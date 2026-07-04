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

async function findTaskDoc(db, taskId, daysBack = 30) {
  if (typeof taskId === "string" && taskId.includes("/")) {
    const snap = await db.doc(taskId).get();
    if (snap.exists) return snap;
  }

  let snap = await db.collection("tasks").doc(taskId).get();
  if (snap.exists) return snap;

  const today = new Date();

  for (let i = 0; i <= daysBack; i++) {
    const dt = new Date(today);
    dt.setUTCDate(today.getUTCDate() - i);

    const day = dt.toISOString().slice(0, 10);

    snap = await db
      .collection("archives")
      .doc(day)
      .collection("tasks")
      .doc(taskId)
      .get();

    if (snap.exists) return snap;
  }

  return null;
}

async function getManagers(db) {
  const roleValues = ["manager", "Manager", "менеджер", "Менеджер"];
  const snap = await db.collection("users").where("role", "in", roleValues).get();

  const users = [];
  snap.forEach(d => users.push({ id: d.id, ...d.data() }));
  return users;
}

export default async function handler(req, res) {
  try {
    initAdmin();
    const db = admin.firestore();

    const taskId = req.method === "POST"
      ? req.body?.taskId
      : req.query.taskId;

    if (!taskId) {
      return res.status(200).json({ ok: true, ignored: "missing_taskId" });
    }

    const ref = db.collection("tasks").doc(taskId);

    // 🔥 СНАЧАЛА быстрый lock-check (1 read максимум)
    const pre = await ref.get();
    if (pre.exists && pre.data()?.notifyFinishedProcessed) {
      return res.status(200).json({
        ok: true,
        skipped: "already_processed"
      });
    }

    // 🔒 АТОМАРНЫЙ LOCK
    const lockOk = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const data = snap.data();

      if (!snap.exists) return false;
      if (data?.notifyFinishedProcessed) return false;

      const created = data?.createdAt?.toDate?.();
      if (created) {
        const ageMs = Date.now() - created.getTime();
        if (ageMs > 24 * 60 * 60 * 1000) return false;
      }

      tx.update(ref, {
        notifyFinishedProcessed: true,
        notifyFinishedProcessingAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return true;
    });

    if (!lockOk) {
      return res.status(200).json({
        ok: true,
        skipped: "locked_or_too_old"
      });
    }

    const taskSnap = await ref.get();
    const task = taskSnap.data() || {};

    const title = task.title || "Без названия";
    const takenByName = task.takenByName || "кладовщик";

    const managers = await getManagers(db);

    const tokens = [];
    const seen = {};

    for (const u of managers) {
      for (const t of u.fcmTokens || []) {
        if (!seen[t]) {
          seen[t] = true;
          tokens.push(t);
        }
      }
    }

    if (!tokens.length) {
      return res.status(200).json({ ok: true, sent: 0 });
    }

    const out = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: "Задача завершена",
        body: `«${title}» выполнена (${takenByName})`,
      },
      data: {
        taskId: String(taskId),
      },
    });

    await ref.update({
      notifyFinishedSentAt: admin.firestore.FieldValue.serverTimestamp(),
      notifyFinishedSuccess: out.successCount,
      notifyFinishedFailed: out.failureCount,
    });

    return res.status(200).json({
      ok: true,
      sent: out.successCount,
      failed: out.failureCount,
    });

  } catch (e) {
    console.error(e);

    return res.status(200).json({
      ok: true,
      ignored: "server_error",
    });
  }
}
