// /api/notify-taskCreated.js (ESM)
import admin from "firebase-admin";

let app;
function initAdmin() {
  if (app) return app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

  const sa = JSON.parse(raw);
  sa.private_key = sa.private_key.replace(/\\n/g, "\n").trim();

  app = admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
  });

  console.log("✅ Firebase initialized");
  return app;
}

function normRole(role) {
  const s = String(role || "").toLowerCase().trim();
  if (["кладовщик", "storekeeper", "kladovshik"].includes(s)) return "storekeeper";
  if (["начальник", "head", "boss"].includes(s)) return "head";
  if (["менеджер", "manager"].includes(s)) return "manager";
  return s;
}

async function getUser(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  return { id: uid, ...(snap.data() || {}) };
}

async function collectTokens({ db, assigneeIds, authorUid }) {
  let tokens = [];

  for (const uid of assigneeIds) {
    const u = await getUser(db, uid);
    const list = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
    tokens.push(...list);
  }

  // dedupe
  tokens = [...new Set(tokens)];

  // remove author tokens
  if (authorUid) {
    const au = await getUser(db, authorUid);
    const authorTokens = new Set(Array.isArray(au.fcmTokens) ? au.fcmTokens : []);
    tokens = tokens.filter(t => !authorTokens.has(t));
  }

  return tokens;
}

export default async function handler(req, res) {
  const db = admin.firestore();

const lockRef = db.collection("locks").doc(taskId);

const lockSnap = await lockRef.get();
if (lockSnap.exists) {
  return res.status(200).json({
    skipped: true,
    reason: "locked"
  });
}

await lockRef.set({
  createdAt: Date.now()
});
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    initAdmin();
    const db = admin.firestore();

    const taskId = String(req.body?.taskId || "").trim();
    if (!taskId) return res.status(400).json({ error: "taskId required" });

    const assigneeIdsRaw = String(req.body?.assigneeIds || "");
    let assigneeIds = assigneeIdsRaw
      ? assigneeIdsRaw.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    const taskRef = db.collection("tasks").doc(taskId);
    const snap = await taskRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "task not found" });
    }

    const task = snap.data();

    const authorUid =
      task.creatorId || task.authorUid || task.createdBy || "";

    // =========================
    // 🔥 ANTI DUPLICATE CORE
    // =========================

    if (task.pushSentAt) {
      return res.status(200).json({
        skipped: true,
        reason: "already_sent",
      });
    }

    // fallback: берём из задачи
    if (!assigneeIds.length) {
      assigneeIds =
        task.assigneeIds ||
        task.assignees ||
        [];
    }

    if (!assigneeIds.length) {
      return res.status(200).json({
        skipped: true,
        reason: "no_assignees",
      });
    }

    // anti spam log (global dedup)
    const logId = `${taskId}_created`;
    const logRef = db.collection("pushLogs").doc(logId);

    const logSnap = await logRef.get();
    if (logSnap.exists) {
      return res.status(200).json({
        skipped: true,
        reason: "log_exists",
      });
    }

    const tokens = await collectTokens({ db, assigneeIds, authorUid });

    if (!tokens.length) {
      return res.status(200).json({
        sent: 0,
        reason: "no_tokens",
      });
    }

    const title = task.title ? String(task.title) : `Задача ${taskId}`;
    const body =
      task.comment ||
      task.creatorName ||
      "Новое задание";

    const message = {
      android: {
        priority: "high",
        ttl: 24 * 60 * 60,
      },
      data: {
        type: "taskCreated",
        taskId,
        title,
        body,
      },
    };

    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      ...message,
    });

    // =========================
    // SAVE STATE (IMPORTANT)
    // =========================

    await taskRef.update({
      pushSentAt: Date.now(),
      pushSentSuccess: result.successCount,
      pushSentFailed: result.failureCount,
    });

    await logRef.set({
      taskId,
      createdAt: Date.now(),
      success: result.successCount,
      failed: result.failureCount,
    });

    return res.status(200).json({
      sent: result.successCount,
      failed: result.failureCount,
      tokens: tokens.length,
      status: "sent_once",
    });

  } catch (e) {
    console.error("🔥 error:", e);
    return res.status(500).json({ error: e.message });
  }
}
