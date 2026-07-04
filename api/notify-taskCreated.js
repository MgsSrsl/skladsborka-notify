// /api/notify-taskCreated.js
// Старый URL оставляем, но защищаем от старых/левых клиентов.
// Firebase читаем ТОЛЬКО после проверки доступа.

import admin from "firebase-admin";

let app;

function initAdmin() {
  if (app) return app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

  const sa = JSON.parse(raw);
  sa.private_key = String(sa.private_key || "")
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

function normRole(role) {
  const s = String(role || "").toLowerCase().trim();

  if (["кладовщик", "кладовщица", "storekeeper", "kladovshik", "кладовщик склада"].includes(s)) {
    return "storekeeper";
  }

  if (["начальник", "head", "boss"].includes(s)) {
    return "head";
  }

  if (["менеджер", "manager"].includes(s)) {
    return "manager";
  }

  return s;
}

function getHeader(req, name) {
  const key = name.toLowerCase();
  const value = req.headers?.[key] || req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseAllowedOrigins() {
  return String(process.env.NOTIFY_ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function isAllowedRequest(req) {
  /**
   * Вариант 1 — секретный заголовок.
   * Можно добавить в новую веб-страницу.
   */
  const expectedSecret = String(process.env.NOTIFY_SECRET || "").trim();
  const gotSecret = String(getHeader(req, "x-notify-secret") || "").trim();

  if (expectedSecret && gotSecret && gotSecret === expectedSecret) {
    return true;
  }

  /**
   * Вариант 2 — разрешаем только запросы с нашего сайта.
   * Старые Android-клиенты обычно не присылают Origin/Referer.
   */
  const allowedOrigins = parseAllowedOrigins();

  if (allowedOrigins.length) {
    const origin = String(getHeader(req, "origin") || "").trim();
    const referer = String(getHeader(req, "referer") || "").trim();

    if (origin && allowedOrigins.includes(origin)) {
      return true;
    }

    if (referer) {
      for (const allowed of allowedOrigins) {
        if (referer.startsWith(allowed)) {
          return true;
        }
      }
    }
  }

  return false;
}

function parseAssignees(value) {
  if (Array.isArray(value)) {
    return value.map(String).map(s => s.trim()).filter(Boolean);
  }

  const raw = String(value || "").trim();
  if (!raw) return [];

  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

async function getUserById(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return null;
  return { id: uid, ...(snap.data() || {}) };
}

async function collectTargetTokens({ db, assigneeIds, authorUid }) {
  let tokens = [];
  const pickedUsers = [];

  if (Array.isArray(assigneeIds) && assigneeIds.length) {
    for (const uid of assigneeIds) {
      const u = await getUserById(db, uid);
      if (!u) continue;

      const list = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];

      pickedUsers.push({
        uid,
        role: u.role,
        onPickup: u.onPickup,
        tokenCount: list.length,
      });

      for (const t of list) {
        if (t) tokens.push(t);
      }
    }
  } else {
    const qs = await db.collection("users").where("onPickup", "==", true).get();

    for (const doc of qs.docs) {
      const u = doc.data() || {};
      const role = normRole(u.role);

      if (role !== "storekeeper" && role !== "head") continue;

      const list = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];

      pickedUsers.push({
        uid: doc.id,
        role: u.role,
        onPickup: true,
        tokenCount: list.length,
      });

      for (const t of list) {
        if (t) tokens.push(t);
      }
    }
  }

  tokens = [...new Set(tokens)].filter(Boolean);

  if (authorUid) {
    const au = await getUserById(db, authorUid);

    if (au) {
      const authorTokens = new Set(
        Array.isArray(au.fcmTokens) ? au.fcmTokens.filter(Boolean) : []
      );

      tokens = tokens.filter(t => !authorTokens.has(t));
    }
  }

  console.log("👥 Picked users:", pickedUsers.length, "🎫 Tokens:", tokens.length);
  return tokens;
}

async function createNotifyLock(db, lockId) {
  const ref = db.collection("_notifyLocks").doc(lockId);

  try {
    await ref.create({
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return true;
  } catch (e) {
    const code = String(e.code || "");
    const msg = String(e.message || "").toLowerCase();

    if (
      code === "6" ||
      code === "already-exists" ||
      msg.includes("already exists")
    ) {
      return false;
    }

    throw e;
  }
}

async function sendMulticastInChunks(tokens, message) {
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);

    const result = await admin.messaging().sendEachForMulticast({
      tokens: chunk,
      ...message,
    });

    successCount += result.successCount;
    failureCount += result.failureCount;
  }

  return { successCount, failureCount };
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    /**
     * ВАЖНО:
     * Не отдаём 405/401/403 старым клиентам.
     * Им всегда 200, чтобы они не ретраили.
     */
    if (req.method !== "POST") {
      return res.status(200).json({
        ok: true,
        sent: 0,
        ignored: true,
        reason: "not post"
      });
    }

    /**
     * САМАЯ ВАЖНАЯ ОТСЕЧКА.
     * До этого места Firebase вообще не инициализировался.
     */
    if (!isAllowedRequest(req)) {
      console.log("🚫 notify-taskCreated ignored: not allowed");

      return res.status(200).json({
        ok: true,
        sent: 0,
        ignored: true,
        reason: "not allowed"
      });
    }

    const body = req.body || {};

    const taskId = String(body.taskId || "").trim();

    if (!taskId) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        ignored: true,
        reason: "taskId required"
      });
    }

    initAdmin();
    const db = admin.firestore();

    /**
     * Защита от дублей.
     * Даже если нормальный клиент случайно отправит 10 раз,
     * пуш уйдёт только один раз.
     *
     * Это write, не read.
     */
    const lockId = `taskCreated_${taskId}`;
    const firstTime = await createNotifyLock(db, lockId);

    if (!firstTime) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        duplicate: true,
        reason: "already notified"
      });
    }

    let assigneeIds = parseAssignees(body.assigneeIds);

    const snap = await db.collection("tasks").doc(taskId).get();

    if (!snap.exists) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        ignored: true,
        reason: "task not found"
      });
    }

    const task = snap.data() || {};

    if (!assigneeIds.length) {
      if (Array.isArray(task.assigneeIds)) {
        assigneeIds = task.assigneeIds.filter(Boolean);
      } else if (Array.isArray(task.assignees)) {
        assigneeIds = task.assignees.filter(Boolean);
      }
    }

    const authorUid = task.creatorId || task.authorUid || task.createdBy || "";

    console.log("🧾 Task", {
      taskId,
      authorUid,
      assigneesCount: assigneeIds.length,
    });

    const tokens = await collectTargetTokens({
      db,
      assigneeIds,
      authorUid,
    });

    if (!tokens.length) {
      console.log("ℹ️ No tokens found — skip send");

      return res.status(200).json({
        ok: true,
        sent: 0,
        reason: "no tokens"
      });
    }

    const title = task.title ? String(task.title) : `Задача ${taskId}`;

    const pushBody =
      task.comment
        ? String(task.comment)
        : task.creatorName
          ? `От: ${task.creatorName}`
          : "Новое задание";

    const message = {
      android: {
        priority: "high",
        ttl: 24 * 60 * 60,
      },
      data: {
        type: "taskCreated",
        taskId: String(taskId),
        title,
        body: pushBody,
      },
    };

    const result = await sendMulticastInChunks(tokens, message);

    console.log(
      `📨 Sent: ${result.successCount}, failed: ${result.failureCount}, tried: ${tokens.length}`
    );

    return res.status(200).json({
      ok: true,
      sent: result.successCount,
      failed: result.failureCount,
      tokensTried: tokens.length,
    });
  } catch (e) {
    console.error("🔥 notify-taskCreated error:", e);

    /**
     * Даже при ошибке отдаём 200.
     * Notify не должен запускать бесконечные ретраи.
     */
    return res.status(200).json({
      ok: true,
      sent: 0,
      ignored: true,
      error: String(e.message || e),
    });
  }
}
