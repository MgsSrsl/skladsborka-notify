// /api/notify-taskCreated.js
//
// Серверная часть безопасной очереди уведомлений.
// Браузер может повторять один и тот же taskId, а этот обработчик:
// - не отправит второй пуш после completed;
// - не позволит двум запросам отправлять одновременно;
// - освободит зависший processing-lock через 2 минуты;
// - вернёт retryable:true при временной ошибке;
// - не обращается к Firebase до проверки origin/secret.

import admin from "firebase-admin";

let app;

const LOCK_LEASE_MS = 2 * 60 * 1000;
const LOCK_EXPIRES_MS = 2 * 24 * 60 * 60 * 1000;

function initAdmin() {
  if (app) return app;

  if (Array.isArray(admin.apps) && admin.apps.length > 0) {
    app = admin.app();
    return app;
  }

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
  const value = String(role || "").toLowerCase().trim();

  if (
    [
      "кладовщик",
      "кладовщица",
      "storekeeper",
      "kladovshik",
      "кладовщик склада",
    ].includes(value)
  ) {
    return "storekeeper";
  }

  if (["начальник", "head", "boss"].includes(value)) {
    return "head";
  }

  if (["менеджер", "manager"].includes(value)) {
    return "manager";
  }

  return value;
}

function getHeader(req, name) {
  const lower = String(name || "").toLowerCase();
  const value = req.headers?.[lower] ?? req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function parseAllowedOrigins() {
  return String(process.env.NOTIFY_ALLOWED_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
}

function getRefererOrigin(req) {
  const referer = String(getHeader(req, "referer") || "").trim();
  if (!referer) return "";

  try {
    return normalizeOrigin(new URL(referer).origin);
  } catch {
    return "";
  }
}

function applyCors(req, res) {
  const origin = normalizeOrigin(getHeader(req, "origin"));
  const allowedOrigins = parseAllowedOrigins();

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Notify-Secret"
  );
}

function isAllowedRequest(req) {
  const expectedSecret = String(process.env.NOTIFY_SECRET || "").trim();
  const receivedSecret = String(
    getHeader(req, "x-notify-secret") || ""
  ).trim();

  if (
    expectedSecret &&
    receivedSecret &&
    receivedSecret === expectedSecret
  ) {
    return true;
  }

  const allowedOrigins = parseAllowedOrigins();
  if (!allowedOrigins.length) return false;

  const origin = normalizeOrigin(getHeader(req, "origin"));
  if (origin && allowedOrigins.includes(origin)) return true;

  const refererOrigin = getRefererOrigin(req);
  return Boolean(
    refererOrigin && allowedOrigins.includes(refererOrigin)
  );
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      try {
        return Object.fromEntries(new URLSearchParams(req.body));
      } catch {
        return {};
      }
    }
  }

  return {};
}

function parseAssignees(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(",");

  return [
    ...new Set(
      values
        .map(String)
        .map(item => item.trim())
        .filter(Boolean)
    ),
  ];
}

function getTaskAssignees(task, body) {
  if (Array.isArray(task.assigneeIds)) {
    return parseAssignees(task.assigneeIds);
  }

  if (Array.isArray(task.assignees)) {
    return parseAssignees(task.assignees);
  }

  return parseAssignees(body.assigneeIds);
}

function isRealAuthorUid(value) {
  const uid = String(value || "").trim();
  if (!uid) return false;

  return !["unknown", "web", "none", "null", "undefined"].includes(
    uid.toLowerCase()
  );
}

async function getUserById(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return null;

  return {
    id: uid,
    ...(snap.data() || {}),
  };
}

async function collectTargetTokens({ db, assigneeIds, authorUid }) {
  let tokens = [];
  const pickedUsers = [];

  if (Array.isArray(assigneeIds) && assigneeIds.length > 0) {
    const users = await Promise.all(
      assigneeIds.map(uid => getUserById(db, uid))
    );

    for (const user of users) {
      if (!user) continue;

      const userTokens = Array.isArray(user.fcmTokens)
        ? user.fcmTokens
        : [];

      pickedUsers.push({
        uid: user.id,
        role: user.role || "",
        onPickup: Boolean(user.onPickup),
        tokenCount: userTokens.length,
      });

      for (const token of userTokens) {
        if (token) tokens.push(String(token));
      }
    }
  } else {
    const querySnap = await db
      .collection("users")
      .where("onPickup", "==", true)
      .get();

    for (const doc of querySnap.docs) {
      const user = doc.data() || {};
      const role = normRole(user.role);

      if (role !== "storekeeper" && role !== "head") continue;

      const userTokens = Array.isArray(user.fcmTokens)
        ? user.fcmTokens
        : [];

      pickedUsers.push({
        uid: doc.id,
        role: user.role || "",
        onPickup: true,
        tokenCount: userTokens.length,
      });

      for (const token of userTokens) {
        if (token) tokens.push(String(token));
      }
    }
  }

  tokens = [...new Set(tokens)].filter(Boolean);

  // В web-задачах creatorId="unknown" — такой документ не читаем.
  if (isRealAuthorUid(authorUid)) {
    const author = await getUserById(db, String(authorUid));

    if (author) {
      const authorTokens = new Set(
        Array.isArray(author.fcmTokens)
          ? author.fcmTokens.map(String).filter(Boolean)
          : []
      );

      tokens = tokens.filter(token => !authorTokens.has(token));
    }
  }

  console.log(
    "👥 Picked users:",
    pickedUsers.length,
    "🎫 Unique tokens:",
    tokens.length
  );

  return tokens;
}

async function acquireNotifyLock({ db, lockRef, taskId }) {
  return db.runTransaction(async transaction => {
    const snap = await transaction.get(lockRef);
    const nowMs = Date.now();

    let previousAttempts = 0;

    if (snap.exists) {
      const lock = snap.data() || {};
      const status = String(lock.status || "");

      // Старые lock-документы без status считаем завершёнными.
      // Иначе после обновления могли бы повторно полететь старые пуши.
      if (!status) {
        return {
          acquired: false,
          completed: true,
          legacy: true,
        };
      }

      if (status === "completed") {
        return {
          acquired: false,
          completed: true,
          legacy: false,
        };
      }

      previousAttempts = Number(lock.attemptCount || 0);

      const leaseUntilMs =
        typeof lock.leaseUntil?.toMillis === "function"
          ? lock.leaseUntil.toMillis()
          : 0;

      if (status === "processing" && leaseUntilMs > nowMs) {
        return {
          acquired: false,
          completed: false,
          busy: true,
          retryAfterMs: Math.max(1000, leaseUntilMs - nowMs),
        };
      }
    }

    const data = {
      eventType: "taskCreated",
      taskId: String(taskId),
      status: "processing",
      attemptCount: previousAttempts + 1,
      leaseUntil: admin.firestore.Timestamp.fromMillis(
        nowMs + LOCK_LEASE_MS
      ),
      expiresAt: admin.firestore.Timestamp.fromMillis(
        nowMs + LOCK_EXPIRES_MS
      ),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!snap.exists) {
      data.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    transaction.set(lockRef, data, { merge: true });

    return {
      acquired: true,
      completed: false,
      busy: false,
      attemptCount: previousAttempts + 1,
    };
  });
}

async function markLockCompleted({ lockRef, result }) {
  await lockRef.set(
    {
      status: "completed",
      leaseUntil: admin.firestore.Timestamp.fromMillis(0),
      sentCount: Number(result.sentCount || 0),
      failureCount: Number(result.failureCount || 0),
      tokensTried: Number(result.tokensTried || 0),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function markLockRetryableFailure({ lockRef, error }) {
  const errorText = String(
    error?.message || error || "Unknown error"
  ).slice(0, 1000);

  await lockRef.set(
    {
      status: "retryable_failed",
      leaseUntil: admin.firestore.Timestamp.fromMillis(0),
      lastError: errorText,
      lastFailedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function sendMulticastInChunks(tokens, message) {
  let sentCount = 0;
  let failureCount = 0;
  const failureCodes = {};

  for (let offset = 0; offset < tokens.length; offset += 500) {
    const chunk = tokens.slice(offset, offset + 500);

    const response = await admin.messaging().sendEachForMulticast({
      tokens: chunk,
      ...message,
    });

    sentCount += Number(response.successCount || 0);
    failureCount += Number(response.failureCount || 0);

    response.responses.forEach(item => {
      if (item.success) return;

      const code = String(item.error?.code || "unknown");
      failureCodes[code] = Number(failureCodes[code] || 0) + 1;
    });
  }

  return {
    sentCount,
    failureCount,
    tokensTried: tokens.length,
    failureCodes,
  };
}

export default async function handler(req, res) {
  let lockRef = null;
  let lockAcquired = false;
  let fcmFinished = false;

  try {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

    applyCors(req, res);

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        final: true,
        retryable: false,
        reason: "method not allowed",
      });
    }

    // До этой проверки Firebase вообще не читаем.
    if (!isAllowedRequest(req)) {
      console.log("🚫 notify-taskCreated rejected: not allowed");

      return res.status(403).json({
        ok: false,
        final: true,
        retryable: false,
        reason: "not allowed",
      });
    }

    const body = parseBody(req);
    const taskId = String(body.taskId || "").trim();

    if (!taskId) {
      return res.status(400).json({
        ok: false,
        final: true,
        retryable: false,
        reason: "taskId required",
      });
    }

    initAdmin();
    const db = admin.firestore();

    // Задача уже должна быть полностью создана браузером.
    const taskSnap = await db.collection("tasks").doc(taskId).get();

    if (!taskSnap.exists) {
      return res.status(404).json({
        ok: false,
        final: true,
        retryable: false,
        reason: "task not found",
      });
    }

    const task = taskSnap.data() || {};
    lockRef = db.collection("_notifyLocks").doc(`taskCreated_${taskId}`);

    const lockResult = await acquireNotifyLock({
      db,
      lockRef,
      taskId,
    });

    if (lockResult.completed) {
      console.log("♻️ Notification already completed:", taskId);

      return res.status(200).json({
        ok: true,
        final: true,
        retryable: false,
        duplicate: true,
        sent: 0,
        reason: lockResult.legacy
          ? "legacy lock exists"
          : "already notified",
      });
    }

    if (lockResult.busy) {
      return res.status(409).json({
        ok: false,
        final: false,
        retryable: true,
        sent: 0,
        reason: "notification is processing",
        retryAfterMs: lockResult.retryAfterMs,
      });
    }

    lockAcquired = true;

    const assigneeIds = getTaskAssignees(task, body);
    const authorUid = String(
      task.creatorId || task.authorUid || task.createdBy || ""
    ).trim();

    console.log("🧾 Task notification:", {
      taskId,
      authorUid,
      assigneesCount: assigneeIds.length,
      attempt: lockResult.attemptCount,
    });

    const tokens = await collectTargetTokens({
      db,
      assigneeIds,
      authorUid,
    });

    if (!tokens.length) {
      await markLockCompleted({
        lockRef,
        result: {
          sentCount: 0,
          failureCount: 0,
          tokensTried: 0,
        },
      });

      return res.status(200).json({
        ok: true,
        final: true,
        retryable: false,
        sent: 0,
        failed: 0,
        reason: "no tokens",
      });
    }

    const title = task.title
      ? String(task.title)
      : `Задача ${taskId}`;

    const pushBody = task.comment
      ? String(task.comment)
      : task.creatorName && task.creatorName !== "unknown"
        ? `От: ${String(task.creatorName)}`
        : "Новое задание";

    const message = {
      android: {
        priority: "high",
        // Firebase Admin Node: TTL указывается в миллисекундах.
        ttl: 24 * 60 * 60 * 1000,
      },
      data: {
        type: "taskCreated",
        taskId: String(taskId),
        title,
        body: pushBody,
      },
    };

    const sendResult = await sendMulticastInChunks(tokens, message);
    fcmFinished = true;

    console.log(
      `📨 Sent: ${sendResult.sentCount}, ` +
      `failed: ${sendResult.failureCount}, ` +
      `tried: ${sendResult.tokensTried}`
    );

    if (Object.keys(sendResult.failureCodes).length) {
      console.log("⚠️ FCM token failures:", sendResult.failureCodes);
    }

    // После ответа FCM повторять весь multicast уже нельзя:
    // рабочие токены могли получить пуш, даже если часть токенов мёртвая.
    try {
      await markLockCompleted({
        lockRef,
        result: sendResult,
      });
    } catch (lockError) {
      console.error(
        "⚠️ Push handled, but lock completion failed:",
        lockError
      );
    }

    return res.status(200).json({
      ok: true,
      final: true,
      retryable: false,
      sent: sendResult.sentCount,
      failed: sendResult.failureCount,
      tokensTried: sendResult.tokensTried,
    });
  } catch (error) {
    console.error("🔥 notify-taskCreated error:", error);

    // FCM ещё не вернул результат — запрос можно безопасно повторить.
    if (lockAcquired && lockRef && !fcmFinished) {
      try {
        await markLockRetryableFailure({
          lockRef,
          error,
        });
      } catch (lockError) {
        console.error("🔥 Failed to release notify lock:", lockError);
      }
    }

    return res.status(503).json({
      ok: false,
      final: false,
      retryable: true,
      sent: 0,
      error: String(error?.message || error || "Unknown error"),
    });
  }
}
