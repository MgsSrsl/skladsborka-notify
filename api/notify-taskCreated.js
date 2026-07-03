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

/**
 * Возвращает массив FCM-токенов по правилам:
 * 1) Если есть assigneeIds → пуш только им.
 * 2) Если нет → всем с onPickup==true среди ролей storekeeper/head.
 * 3) Автор исключается.
 */
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
      pickedUsers.push({ uid: doc.id, role: u.role, onPickup: true, tokenCount: (u.fcmTokens || []).length });
      const list = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
      for (const t of list) if (t) tokens.push(t);
    }
  }

  // дедуп токенов
  tokens = [...new Set(tokens)];

  // исключаем автора
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
    console.log("METHOD:", req.method);
    console.log("URL:", req.url);
    console.log("USER-AGENT:", req.headers["user-agent"]);
    console.log("BODY:", req.body);

    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  

    const taskId = String(req.body?.taskId || "").trim();
    // может прийти "uid1,uid2"
    const rawAssignees = String(req.body?.assigneeIds || "").trim();
    let assigneeIds = rawAssignees ? rawAssignees.split(",").map(s => s.trim()).filter(Boolean) : [];

    initAdmin();
    const db = admin.firestore();

    // читаем задачу
    const snap = await db.collection("tasks").doc(taskId).get();
    if (!snap.exists) return res.status(404).send("task not found");
    const task = snap.data() || {};

    // если не пришли получатели — берём из самой задачи
    if (!assigneeIds.length) {
      if (Array.isArray(task.assigneeIds)) assigneeIds = task.assigneeIds.filter(Boolean);
      else if (Array.isArray(task.assignees)) assigneeIds = task.assignees.filter(Boolean);
    }

    const authorUid = task.creatorId || task.authorUid || task.createdBy || "";
    console.log("🧾 Task", { taskId, authorUid, assigneeIdsCount: assigneeIds.length });

    // получаем токены
    const tokens = await collectTargetTokens({ db, assigneeIds, authorUid });
    if (!tokens.length) {
      console.log("ℹ️ No tokens found — skip send");
      return res.status(200).json({ sent: 0, reason: "no tokens" });
    }

    // текст уведомления
    const title = task.title ? String(task.title) : `Задача ${taskId}`;
    const body =
      (task.comment && String(task.comment)) ||
      (task.creatorName ? `От: ${task.creatorName}` : "Новое задание");

    // ⚙️ data-only сообщение (без notification части)
    const message = {
      android: {
        priority: "high",
        ttl: 24 * 60 * 60, // секунды
        // collapseKey оставим пустым => не будет схлопываться очередь
      },
      data: {
        type: "taskCreated",
        taskId: String(taskId),
        title,
        body,
      },
    };

    console.log("📤 Message (data-only):", { android: message.android, data: message.data });

    const sendResult = await admin.messaging().sendEachForMulticast({ tokens, ...message });

    console.log(`📨 Sent: ${sendResult.successCount}, failed: ${sendResult.failureCount}, tried: ${tokens.length}`);
    return res.status(200).json({
      sent: sendResult.successCount,
      failed: sendResult.failureCount,
      tokensTried: tokens.length,
    });
  } catch (e) {
    console.error("🔥 Server error:", e);
    return res.status(500).json({ error: e.message });
  }
}
