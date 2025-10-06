// ESM-версия для Vercel ("type":"module")
import admin from "firebase-admin";

let app;

function initAdmin() {
  if (!app) {
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
  }
  return app;
}

/** Собираем FCM-токены исполнителей (исключая автора) */
async function collectAssigneeTokens(db, assigneeIds, authorUid) {
  if (!assigneeIds?.length) return [];

  const tokens = new Set();
  for (const uid of assigneeIds) {
    const snap = await db.collection("users").doc(uid).get();
    const u = snap.data() || {};
    (Array.isArray(u.fcmTokens) ? u.fcmTokens : []).forEach(t => t && tokens.add(t));
  }

  // выкидываем токены автора, чтобы он сам не получил пуш
  if (authorUid) {
    const ad = await db.collection("users").doc(authorUid).get();
    const au = ad.data() || {};
    (Array.isArray(au.fcmTokens) ? au.fcmTokens : []).forEach(t => tokens.delete(t));
  }

  return [...tokens];
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const taskId = (req.body?.taskId || "").trim();
    if (!taskId) return res.status(400).send("taskId required");

    // 👇 Новое: читаем assigneeIds, если клиент передал
    const rawAssignees = (req.body?.assigneeIds || "").trim();
    let assigneeIds = [];

    if (rawAssignees) {
      // передано строкой: "uid1,uid2,..."
      assigneeIds = rawAssignees.split(",").map(s => s.trim()).filter(Boolean);
    }

    initAdmin();
    const db = admin.firestore();

    // Загружаем задачу для резервного случая (и для текста уведомления)
    const snap = await db.collection("tasks").doc(taskId).get();
    if (!snap.exists) return res.status(404).send("task not found");
    const task = snap.data() || {};

    // если с клиента не пришли assigneeIds — берём из Firestore
    if (!assigneeIds.length) {
      if (Array.isArray(task.assigneeIds)) assigneeIds = task.assigneeIds;
      else if (Array.isArray(task.assignees)) assigneeIds = task.assignees;
    }

    // --- если и здесь пусто → значит это самовывоз → всем кладовщикам ---
    let tokens = [];
    if (assigneeIds.length) {
      tokens = await collectAssigneeTokens(db, assigneeIds, task.creatorId || task.authorUid);
    } else {
      console.log("📦 No assigneeIds → sending to all storekeepers (pickup mode)");
      const roles = ["кладовщик", "Кладовщик", "storekeeper", "kladovshik"];
      const qs = await db.collection("users").whereIn("role", roles).get();
      qs.docs.forEach(doc => {
        const u = doc.data() || {};
        (Array.isArray(u.fcmTokens) ? u.fcmTokens : []).forEach(t => t && tokens.push(t));
      });
      // убираем дубли и токены автора
      tokens = [...new Set(tokens)];
      if (task.creatorId) {
        const ad = await db.collection("users").doc(task.creatorId).get();
        const au = ad.data() || {};
        (Array.isArray(au.fcmTokens) ? au.fcmTokens : []).forEach(t => {
          tokens = tokens.filter(x => x !== t);
        });
      }
    }

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
          clickAction: "com.example.skladsborka.OPEN_TASK",
        },
      },
      data: { taskId: String(taskId) },
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
