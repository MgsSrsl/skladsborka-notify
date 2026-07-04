// /api/notify-taskCreated.js  (ESM, "type":"module")
import admin from "firebase-admin";

let app;

function initAdmin() {
  if (app) return app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

  const sa = JSON.parse(raw);
  sa.private_key = sa.private_key.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();

  app = admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
  });

  console.log("✅ Firebase initialized:", sa.project_id);
  return app;
}

// --- helpers ---
function normRole(role) {
  const s = String(role || "").toLowerCase().trim();
  if (["кладовщик", "кладовщица", "storekeeper", "kladovshik", "кладовщик склада"].includes(s)) return "storekeeper";
  if (["начальник", "head", "boss"].includes(s)) return "head";
  if (["менеджер", "manager"].includes(s)) return "manager";
  return s;
}

async function getUserById(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  return { id: uid, ...(snap.data() || {}) };
}

async function collectTargetTokens({ db, assigneeIds, authorUid }) {
  let tokens = [];
  const pickedUsers = [];

  if (Array.isArray(assigneeIds) && assigneeIds.length) {
    for (const uid of assigneeIds) {
      const u = await getUserById(db, uid);
      pickedUsers.push({ uid, role: u.role, onPickup: u.onPickup, tokenCount: (u.fcmTokens || []).length });
      const list = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
      for (const t of list) if (t) tokens.push(t);
    }
  } else {
    const qs = await db.collection("users").where("onPickup", "==", true).get();

    for (const doc of qs.docs) {
      const u = doc.data() || {};
      const role = normRole(u.role);

      if (role !== "storekeeper" && role !== "head") continue;

      pickedUsers.push({
        uid: doc.id,
        role: u.role,
        onPickup: true,
        tokenCount: (u.fcmTokens || []).length
      });

      const list = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
      for (const t of list) if (t) tokens.push(t);
    }
  }

  tokens = [...new Set(tokens)];

  if (authorUid) {
    const au = await getUserById(db, authorUid);
    const authorTokens = new Set(Array.isArray(au.fcmTokens) ? au.fcmTokens.filter(Boolean) : []);
    tokens = tokens.filter(t => !authorTokens.has(t));
  }

  console.log("👥 Picked users:", pickedUsers.length, "🎫 Tokens:", tokens.length);
  return tokens;
}

export default async function handler(req, res) {
  try {
    console.log("🔥 notify-taskCreated CALLED", new Date().toISOString());

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: true,
        final: true,
        stop: true,
        reason: "method_not_allowed"
      });
    }

    initAdmin();
    const db = admin.firestore();

    const taskId = String(req.body?.taskId || "").trim();

    if (!taskId) {
      return res.status(200).json({
        ok: true,
        final: true,
        stop: true,
        reason: "missing_taskId"
      });
    }

    const rawAssignees = String(req.body?.assigneeIds || "").trim();

    let assigneeIds = rawAssignees
      ? rawAssignees.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    const snap = await db.collection("tasks").doc(taskId).get();

    if (!snap.exists) {
      return res.status(200).json({
        ok: true,
        final: true,
        stop: true,
        reason: "task_not_found"
      });
    }

    const task = snap.data() || {};

    // 🔒 idempotency
    if (task.notifyCreatedProcessed) {
      return res.status(200).json({
        ok: true,
        final: true,
        stop: true,
        reason: "already_processed"
      });
    }

    const created =
      task.createdAt && typeof task.createdAt.toDate === "function"
        ? task.createdAt.toDate()
        : null;

    if (created instanceof Date) {
      const ageMs = Date.now() - created.getTime();

      if (ageMs > 24 * 60 * 60 * 1000) {
        return res.status(200).json({
          ok: true,
          final: true,
          stop: true,
          reason: "task_too_old"
        });
      }
    }

    if (!assigneeIds.length) {
      if (Array.isArray(task.assigneeIds)) assigneeIds = task.assigneeIds.filter(Boolean);
      else if (Array.isArray(task.assignees)) assigneeIds = task.assignees.filter(Boolean);
    }

    const authorUid =
      task.creatorId ||
      task.authorUid ||
      task.createdBy ||
      "";

    const tokens = await collectTargetTokens({
      db,
      assigneeIds,
      authorUid
    });

    if (!tokens.length) {
      return res.status(200).json({
        ok: true,
        final: true,
        stop: true,
        sent: 0
      });
    }

    const title = task.title || `Задача ${taskId}`;
    const body =
      task.comment ||
      (task.creatorName ? `От: ${task.creatorName}` : "Новое задание");

    const message = {
      android: {
        priority: "high",
        ttl: 24 * 60 * 60
      },
      tokens,
      notification: {
        title,
        body
      },
      data: {
        type: "taskCreated",
        taskId: String(taskId),
        title: String(title),
        body: String(body)
      }
    };

    const sendResult = await admin.messaging().sendEachForMulticast(message);

    await snap.ref.update({
      notifyCreatedProcessed: true,
      notifyCreatedSentAt: admin.firestore.FieldValue.serverTimestamp(),
      notifyCreatedSuccess: sendResult.successCount
    });

    return res.status(200).json({
      ok: true,
      final: true,
      stop: true,
      sent: sendResult.successCount,
      failed: sendResult.failureCount
    });

  } catch (e) {
    console.error("🔥 Server error:", e);

    return res.status(200).json({
      ok: true,
      final: true,
      stop: true,
      error: e.message
    });
  }
}
