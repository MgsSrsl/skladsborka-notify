// /api/notify-taskFinished.js
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
  return app;
}

export default async function handler(req, res) {
  try {
    initAdmin();

    // читаем JSON тело
    let taskId;
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyStr = Buffer.concat(chunks).toString();
      if (bodyStr) {
        const data = JSON.parse(bodyStr);
        taskId = data.taskId;
      }
    } else {
      taskId = req.query.taskId;
    }

    if (!taskId) return res.status(400).json({ ok: false, error: "Missing taskId" });

    const db = admin.firestore();
    const doc = await db.collection("tasks").doc(taskId).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: "task not found" });

    const task = doc.data();
    const title = task.title || "Без названия";
    const creatorId = task.creatorId;
    const takenByName = task.takenByName || task.assigneeNames?.[0] || "кладовщик";

    const users = [];
    if (creatorId) {
      const u = await db.collection("users").doc(creatorId).get();
      if (u.exists) users.push(u.data());
    }

    const tokens = [...new Set(users.flatMap(u => u.fcmTokens || []))].filter(Boolean);
    console.log("[notify-taskFinished]", { taskId, creatorId, tokens: tokens.length });

    if (tokens.length === 0)
      return res.status(200).json({ ok: true, sent: 0, info: "no tokens" });

    const payload = {
      tokens,
      notification: {
        title: "Задача завершена",
        body: `«${title}» выполнена (${takenByName})`,
      },
      data: { taskId },
    };

    const result = await admin.messaging().sendEachForMulticast(payload);
    res.status(200).json({ ok: true, sent: result.successCount, failed: result.failureCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
