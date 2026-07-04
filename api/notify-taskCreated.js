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

function normRole(role) {
  const s = String(role || "").toLowerCase().trim();
  if (["менеджер", "manager"].includes(s)) return "manager";
  if (["кладовщик", "storekeeper"].includes(s)) return "storekeeper";
  if (["head", "начальник"].includes(s)) return "head";
  return s;
}

async function getUser(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function collectTokens(db, assigneeIds, authorUid) {
  let tokens = [];
  const seen = new Set();

  const add = (list) => {
    for (const t of list || []) {
      if (!seen.has(t)) {
        seen.add(t);
        tokens.push(t);
      }
    }
  };

  if (assigneeIds.length) {
    for (const uid of assigneeIds) {
      const u = await getUser(db, uid);
      if (u?.fcmTokens) add(u.fcmTokens);
    }
  } else {
    const qs = await db.collection("users").where("onPickup", "==", true).get();

    qs.forEach(doc => {
      const u = doc.data();
      if (["storekeeper", "head"].includes(normRole(u.role))) {
        add(u.fcmTokens);
      }
    });
  }

  // исключаем автора
  if (authorUid) {
    const au = await getUser(db, authorUid);
    const authorTokens = new Set(au?.fcmTokens || []);
    tokens = tokens.filter(t => !authorTokens.has(t));
  }

  return tokens;
}

export default async function handler(req, res) {
  try {
    initAdmin();
    const db = admin.firestore();

    const taskId = req.body?.taskId || req.query?.taskId;

    if (!taskId) {
      return res.status(200).json({ ok: true, stop: true });
    }

    const ref = db.collection("tasks").doc(taskId);

    // 🔒 ATOMIC LOCK (главное решение)
    const lockOk = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const data = snap.data();

      if (!snap.exists) return false;

      if (data?.notifyCreatedProcessed) return false;

      const created = data?.createdAt?.toDate?.();
      if (created) {
        const ageMs = Date.now() - created.getTime();
        if (ageMs > 24 * 60 * 60 * 1000) return false;
      }

      tx.update(ref, {
        notifyCreatedProcessed: true,
        notifyCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return true;
    });

    if (!lockOk) {
      return res.status(200).json({ ok: true, stop: true });
    }

    const taskSnap = await ref.get();
    const task = taskSnap.data();

    const assigneeIds = Array.isArray(task.assigneeIds)
      ? task.assigneeIds
      : [];

    const authorUid = task.creatorId || task.authorUid || task.createdBy || "";

    const tokens = await collectTokens(db, assigneeIds, authorUid);

    if (!tokens.length) {
      return res.status(200).json({ ok: true, stop: true, sent: 0 });
    }

    const message = {
      tokens,
      notification: {
        title: task.title || "Новая задача",
        body: task.comment || "Новое задание",
      },
      data: {
        type: "taskCreated",
        taskId: String(taskId),
      },
    };

    const result = await admin.messaging().sendEachForMulticast(message);

    await ref.update({
      notifyCreatedSentAt: admin.firestore.FieldValue.serverTimestamp(),
      notifyCreatedSuccess: result.successCount,
    });

    return res.status(200).json({
      ok: true,
      sent: result.successCount,
      failed: result.failureCount,
    });

  } catch (e) {
    console.error(e);

    return res.status(200).json({
      ok: true,
      stop: true,
    });
  }
}
