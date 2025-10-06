import admin from "firebase-admin";

let app;
function initAdmin() {
  if (!app) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  }
  return app;
}

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

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // (опционально) простая защита секретом:
    const sec = process.env.NOTIFY_SECRET;
    if (sec && req.headers["x-notify-secret"] !== sec) {
      return res.status(401).send("Unauthorized");
    }

    const taskId = (req.body?.taskId || "").trim();
    if (!taskId) return res.status(400).send("taskId required");

    initAdmin();
    const db = admin.firestore();

    const snap = await db.collection("tasks").doc(taskId).get();
    if (!snap.exists) return res.status(404).send("task not found");
    const task = snap.data() || {};

    const tokens = await collectAssigneeTokens(db, task);
    if (!tokens.length) return res.status(200).json({ sent: 0, reason: "no tokens" });

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

    // мёртвые токены можно почистить здесь (resp.responses[i].error)
    return res.status(200).json({ sent: resp.successCount, failed: resp.failureCount });
  } catch (e) {
    console.error(e);
    return res.status(500).send("server error");
  }
}
