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

async function getManagers(db) {
  const roleValues = ["manager", "Manager", "менеджер", "Менеджер"];
  const snap = await db.collection("users").where("role", "in", roleValues).get();

  const users = [];
  snap.forEach((d) => users.push({ id: d.id, ...d.data() }));
  return users;
}

export default async function handler(req, res) {
  try {
    initAdmin();
    const db = admin.firestore();

    const taskId =
      req.method === "POST" ? req.body?.taskId : req.query.taskId;

    if (!taskId) {
      return res.status(200).json({ ok: true, ignored: "missing_taskId" });
    }

    // =========================
    // 🔥 ONLY FAST LOOKUP (NO ARCHIVES SCAN)
    // =========================
    const docSnap = await db.collection("tasks").doc(taskId).get();

    if (!docSnap.exists) {
      return res.status(200).json({
        ok: true,
        ignored: "task_not_found",
      });
    }

    const ref = docSnap.ref;
    const task = docSnap.data() || {};

    // =========================
    // 🔒 FAST DEDUPE CHECK
    // =========================
    if (task.notifyFinishedProcessed) {
      return res.status(200).json({
        ok: true,
        skipped: "already_processed",
      });
    }

    // =========================
    // 🔒 ATOMIC LOCK (anti-spam + race safe)
    // =========================
    const lockOk = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();

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
        skipped: "locked_or_too_old",
      });
    }

    // =========================
    // DATA
    // =========================
    const title = task.title || "Без названия";
    const takenByName =
      task.takenByName || task.assigneeNames?.[0] || "кладовщик";

    // =========================
    // TOKENS (managers only)
    // =========================
    const managers = await getManagers(db);

    const tokens = [];
    const tokenOwner = {};

    for (const u of managers) {
      const list = u.fcmTokens || [];
      for (const t of list) {
        if (!tokenOwner[t]) {
          tokenOwner[t] = u.id;
          tokens.push(t);
        }
      }
    }

    if (!tokens.length) {
      return res.status(200).json({ ok: true, sent: 0 });
    }

    // =========================
    // SEND PUSH
    // =========================
    const payload = {
      tokens,
      notification: {
        title: "Задача завершена",
        body: `«${title}» выполнена (${takenByName})`,
      },
      data: {
        taskId: String(taskId),
      },
    };

    const out = await admin.messaging().sendEachForMulticast(payload);

    // =========================
    // UPDATE
    // =========================
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

    if (String(e.message).includes("RESOURCE_EXHAUSTED")) {
      return res.status(200).json({
        ok: true,
        ignored: "quota_exceeded",
      });
    }

    return res.status(200).json({
      ok: true,
      ignored: "server_error",
    });
  }
}
