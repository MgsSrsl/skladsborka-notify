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

// --- helpers ---
function ymd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
    const day = ymd(dt);

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

async function getUsers(db) {
  const roleValues = ["manager", "Manager", "менеджер", "Менеджер"];
  const mgrs = await db.collection("users").where("role", "in", roleValues).get();

  const users = [];
  mgrs.forEach((d) => users.push({ id: d.id, ...d.data() }));
  return users;
}

export default async function handler(req, res) {
  try {
    initAdmin();
    const db = admin.firestore();

    let taskId =
      req.method === "POST" ? req.body?.taskId : req.query.taskId;

    if (!taskId) {
      return res.status(200).json({ ok: true, ignored: "missing_taskId" });
    }

    const docSnap = await findTaskDoc(db, taskId, 60);
    if (!docSnap) {
      return res.status(200).json({ ok: true, ignored: "task_not_found" });
    }

    const ref = docSnap.ref;

    // =========================
    // 🔒 ATOMIC LOCK (ВАЖНО)
    // =========================
    const lockOk = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);

      if (snap.data()?.notifyFinishedProcessed) {
        return false;
      }

      const created = snap.data()?.createdAt?.toDate?.();

      if (created) {
        const ageMs = Date.now() - created.getTime();
        if (ageMs > 24 * 60 * 60 * 1000) {
          return false;
        }
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

    const task = docSnap.data() || {};
    const title = task.title || "Без названия";
    const takenByName =
      task.takenByName || task.assigneeNames?.[0] || "кладовщик";

    const users = await getUsers(db);

    const tokens = [];
    const tokenOwner = {};

    for (const u of users) {
      const tks = u.fcmTokens || [];
      for (const t of tks) {
        if (!tokenOwner[t]) {
          tokenOwner[t] = u.id;
          tokens.push(t);
        }
      }
    }

    if (!tokens.length) {
      return res.status(200).json({ ok: true, sent: 0 });
    }

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
      ok: false,
      error: e.message,
    });
  }
}
