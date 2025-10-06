// /api/notify-taskCreated.js  (ESM, "type":"module")
import admin from "firebase-admin";

let app;

function initAdmin() {
  if (app) return app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

  const sa = JSON.parse(raw);
  sa.private_key = sa.private_key
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();

  app = admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
  });
  console.log("✅ Firebase initialized:", sa.project_id);
  return app;
}

// --- utils ---
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
 * Возвращает массив FCM-токенов получателей по правилам:
 * - если есть assigneeIds → пуш ТОЛЬКО им;
 * - если assigneeIds пуст (самовывоз) → всем, у кого onPickup==true И роль кладовщика;
 * - автор исключается всегда.
 */
async function collectTargetTokens({ db, assigneeIds, authorUid }) {
  let tokens = [];

  if (Array.isArray(assigneeIds) && assigneeIds.length) {
    // Явные исполнители
    for (const uid of assigneeIds) {
      const u = await getUserById(db, uid);
      const list = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
      for (const t of list) if (t) tokens.push(t);
    }
  } else {
    // Самовывоз: только те, кто включил onPickup и действительно кладовщики
    const qs = await db.collection("users").where("onPickup", "==", true).get();
    for (const doc of qs.docs) {
      const u = doc.data() || {};
      if (normRole(u.role) !== "storekeeper") continue; // защита от широкой рассылки
      const list = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
      for (const t of list) if (t) tokens.push(t);
    }
  }

  // Дедуп токенов
  tokens = [...new Set(tokens)];

  // Исключаем автора
  if (authorUid) {
    const au = await getUserById(db, authorUid);
    const authorTokens = new Set(Array.isArray(au.fcmTokens) ? au.fcmTokens.filter(Boolean) : []);
    tokens = tokens.filter(t => !authorTokens.has(t));
  }

  return tokens;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const taskId = (req.body?.taskId || "").trim();
    if (!taskId) return res.status(400).send("taskId required");

    // опционально: можно передать "uid1,uid2"
    const rawAssignees = String(req.body?.assigneeIds || "").trim();
    let assigneeIds = rawAssignees
      ? rawAssignees.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    initAdmin();
    const db = admin.firestore();

    // читаем задачу (и для получателей, и для текста уведомления)
    const snap = await db.collection("tasks").doc(taskId).get();
    if (!snap.exists) return res.status(404).send("task not found");
    const task = snap.data() || {};

    // если не пришли получатели — берём из самой задачи
    if (!assigneeIds.length) {
      if (Array.isArray(task.assigneeIds)) assigneeIds = task.assigneeIds.filter(Boolean);
      else if (Array.isArray(task.assignees)) assigneeIds = task.assignees.filter(Boolean);
    }

    const authorUid = task.creatorId || task.authorUid || task.createdBy || "";

    // получаем список токенов по новым правилам
    const tokens = await collectTargetTokens({ db, assigneeIds, authorUid });

    if (!tokens.length) {
      console.log("ℹ️ No target tokens resolved.");
      return res.status(200).json({ sent: 0, reason: "no tokens" });
    }

    // 🔹 ТЕКСТ УВЕДОМЛЕНИЯ ИЗ БАЗЫ
    const title = task.title ? String(task.title) : `Задача ${taskId}`;
    const body =
      (task.comment && String(task.comment)) ||
      (task.creatorName ? `От: ${task.creatorName}` : "Новое задание");

    // 🔹 Собственно сообщение (кладём title/body и в notification, и в data)
    const message = {
      notification: { title, body },
      android: {
        priority: "high",
        notification: {
          channelId: "tasks_channel",
          clickAction: "com.example.skladsborka.OPEN_TASK",
        },
      },
      data: {
        taskId: String(taskId),
        title,
        body,
      },
    };

    const resp = await admin.messaging().sendEachForMulticast({ tokens, ...message });

    console.log(`📨 Sent: ${resp.successCount}, failed: ${resp.failureCount}, to ${tokens.length} tokens`);
    return res.status(200).json({
      sent: resp.successCount,
      failed: resp.failureCount,
      tokensTried: tokens.length,
    });
  } catch (e) {
    console.error("🔥 Server error:", e);
    return res.status(500).json({ error: e.message });
  }
}
