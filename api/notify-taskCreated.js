mport admin from "firebase-admin";

let app;
function initAdmin() {
  if (!app) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

    const sa = JSON.parse(raw);

    // 🔹 Эта строка обязательна: превращаем \\n → \n
    sa.private_key = sa.private_key.replace(/\\\\n/g, "\n");

    console.log("🔍 private_key preview:", sa.private_key.slice(0, 40));

    app = admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: sa.project_id,
    });
    console.log("✅ Firebase initialized:", sa.project_id);
  }
  return app;
}

// ---- 2. Получение токенов получателей ----
async function collectAssigneeTokens(db, task) {
  let assigneeIds = Array.isArray(task.assigneeIds) ? task.assigneeIds : [];
  if ((!assigneeIds || assigneeIds.length === 0) && Array.isArray(task.assignees)) {
    assigneeIds = task.assignees.map(a => (typeof a === "string" ? a : a.uid)).filter(Boolean);
  }
  if (!assigneeIds?.length) return [];

  const tokens = new Set();
  for (const uid of assigneeIds) {
    const snap = await db.collection("users").doc(uid).get();
    const u = snap.data() || {};
    const arr = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
    arr.forEach(t => { if (t && typeof t === "string") tokens.add(t); });
  }

  // опционально — не слать автору
  if (task.authorUid) {
    const ad = await db.collection("users").doc(task.authorUid).get();
    const au = ad.data() || {};
    const at = Array.isArray(au.fcmTokens) ? au.fcmTokens : [];
    at.forEach(t => tokens.delete(t));
  }
  return [...tokens];
}

// ---- 3. Главный обработчик эндпойнта ----
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // простая защита по секрету (опционально)
    const sec = process.env.NOTIFY_SECRET;
    if (sec && req.headers["x-notify-secret"] !== sec) {
      return res.status(401).send("Unauthorized");
    }

    const taskId = (req.body?.taskId || "").trim();
    if (!taskId) return res.status(400).send("taskId required");

    // инициализация админа
    initAdmin();
    const db = admin.firestore();

    const snap = await db.collection("tasks").doc(taskId).get();
    if (!snap.exists) return res.status(404).send("task not found");
    const task = snap.data() || {};

    const tokens = await collectAssigneeTokens(db, task);
    if (!tokens.length) {
      return res.status(200).json({ sent: 0, reason: "no tokens" });
    }

    const title = "Новая задача";
    const body = task.title ? String(task.title) : `Задача ${taskId}`;

    const message = {
      notification: { title, body },
      android: {
        priority: "high",
        notification: {
          channelId: "tasks_channel",
          clickAction: "com.example.skladsborka.OPEN_TASK"
        }
      },
      data: { taskId: String(taskId) }
    };

    const resp = await admin.messaging().sendEachForMulticast({ tokens, ...message });

    return res.status(200).json({
      sent: resp.successCount,
      failed: resp.failureCount,
      tokensTried: tokens.length
    });
  } catch (e) {
    console.error("🔥 Server error:", e);
    return res.status(500).json({ error: e.message });
  }
}
