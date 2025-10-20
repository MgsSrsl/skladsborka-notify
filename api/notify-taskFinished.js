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

// формат YYYY-MM-DD (UTC)
function ymd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function findTaskDoc(db, taskId, daysBack = 30) {
  // 0) если прислали ПОЛНЫЙ путь — сразу пробуем его
  if (typeof taskId === "string" && taskId.includes("/")) {
    const snap = await db.doc(taskId).get();
    if (snap.exists) return snap;
  }

  // 1) корневая коллекция /tasks/<id>
  let snap = await db.collection("tasks").doc(taskId).get();
  if (snap.exists) return snap;

  // 2) перебор архивов за N дней: /archives/YYYY-MM-DD/tasks/<id>
  const today = new Date();
  for (let i = 0; i <= daysBack; i++) {
    const dt = new Date(today);
    dt.setUTCDate(today.getUTCDate() - i);
    const day = ymd(dt);
    snap = await db.collection("archives").doc(day).collection("tasks").doc(taskId).get();
    if (snap.exists) return snap;
  }

  return null;
}

export default async function handler(req, res) {
  try {
    initAdmin();
    const db = admin.firestore();

    // --- taskId из POST JSON или query ---
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

    // --- находим задачу ---
    const docSnap = await findTaskDoc(db, taskId, 60); // ищем до 60 дней назад
    if (!docSnap) return res.status(404).json({ ok: false, error: "task not found" });

    const task = docSnap.data() || {};
    const title = task.title || "Без названия";
    const takenByName = task.takenByName || task.assigneeNames?.[0] || "кладовщик";

    // --- получатели: ТОЛЬКО менеджеры ---
    const roleValues = ["manager", "Manager", "менеджер", "Менеджер"];
    const mgrs = await db.collection("users").where("role", "in", roleValues).get();

    const users = [];
    mgrs.forEach(d => users.push({ id: d.id, ...d.data() }));

    // сбор токенов и владельцев токенов
    const tokens = [];
    const tokenOwner = {};
    for (const u of users) {
      const tks = (u.fcmTokens || []).filter(Boolean);
      for (const t of tks) {
        if (!tokenOwner[t]) {
          tokenOwner[t] = u.id;
          tokens.push(t);
        }
      }
    }

    const debug = String(req.query?.debug || "").trim() === "1";
    console.log("[notify-taskFinished]", {
      taskId,
      path: docSnap.ref.path,
      managers: users.length,
      tokens: tokens.length,
    });

    if (debug) {
      return res.status(200).json({
        ok: true,
        mode: "debug",
        taskId,
        path: docSnap.ref.path,
        title,
        managersCount: users.length,
        tokensCount: tokens.length,
      });
    }

    if (!tokens.length) {
      return res.status(200).json({ ok: true, sent: 0, info: "no tokens" });
    }

    // --- отправляем пуш ---
    const payload = {
      tokens,
      notification: {
        title: "Задача завершена",
        body: `«${title}» выполнена (${takenByName})`,
      },
      data: { taskId: String(docSnap.id) }, // отправляем короткий id
    };

    const out = await admin.messaging().sendEachForMulticast(payload);

    // очистка битых токенов
    const errors = out.responses
      .map((r, i) => (r.error ? { token: tokens[i], error: r.error.message } : null))
      .filter(Boolean);

    if (errors.length) {
      const toRemoveByUser = {};
      const badRe = /registration-token|NotRegistered|Unregistered|MismatchSenderId|InvalidToken/i;
      for (const e of errors) {
        if (badRe.test(e.error)) {
          const uid = tokenOwner[e.token];
          if (uid) {
            (toRemoveByUser[uid] ||= []).push(e.token);
          }
        }
      }
      for (const [uid, list] of Object.entries(toRemoveByUser)) {
        try {
          await db.collection("users").doc(uid).update({
            fcmTokens: admin.firestore.FieldValue.arrayRemove(...list),
          });
          console.log("[notify-taskFinished] removed bad tokens for", uid, list.length);
        } catch (err) {
          console.warn("[notify-taskFinished] cleanup failed for", uid, err?.message);
        }
      }
    }

    return res.status(200).json({
      ok: true,
      sent: out.successCount,
      failed: out.failureCount,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
