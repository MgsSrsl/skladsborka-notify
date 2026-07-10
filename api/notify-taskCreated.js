// /api/notify-taskCreated.js
//
// Безопасная версия для повторных запросов из браузерной очереди.
//
// Что делает:
// 1. Проверяет origin/secret ДО обращения к Firebase.
// 2. Проверяет существование задачи.
// 3. Использует lock со статусами processing/completed.
// 4. Если Vercel упал до отправки — lock можно забрать повторно.
// 5. Если пуш уже обработан — второй пуш не отправляет.
// 6. При временной ошибке возвращает HTTP 503 и retryable: true.
// 7. TTL пуша — реальные 24 часа.
// 8. Никогда не пересоздаёт задачу и не трогает файлы.

import admin from "firebase-admin";

let app;

// Сколько времени один запущенный Vercel-запрос владеет lock.
// Если функция зависла или умерла, очередь сможет повторить запрос.
const LOCK_LEASE_MS = 2 * 60 * 1000;

// Lock можно автоматически удалить через TTL Firestore.
// Даже без включённого TTL это ни на что не влияет.
const LOCK_EXPIRES_MS = 2 * 24 * 60 * 60 * 1000;

function initAdmin() {
  if (app) return app;

  if (Array.isArray(admin.apps) && admin.apps.length > 0) {
    app = admin.app();
    return app;
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");
  }

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
  const value = String(role || "")
    .toLowerCase()
    .trim();

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

  if (
    [
      "начальник",
      "head",
      "boss",
    ].includes(value)
  ) {
    return "head";
  }

  if (
    [
      "менеджер",
      "manager",
    ].includes(value)
  ) {
    return "manager";
  }

  return value;
}

function getHeader(req, name) {
  const lowerName = String(name || "").toLowerCase();

  const value =
    req.headers?.[lowerName] ??
    req.headers?.[name];

  return Array.isArray(value)
    ? value[0]
    : value;
}

function parseAllowedOrigins() {
  return String(process.env.NOTIFY_ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function getRefererOrigin(req) {
  const referer = String(
    getHeader(req, "referer") || ""
  ).trim();

  if (!referer) return "";

  try {
    return new URL(referer).origin;
  } catch {
    return "";
  }
}

function applyCors(req, res) {
  const origin = String(
    getHeader(req, "origin") || ""
  )
    .trim()
    .replace(/\/+$/, "");

  const allowedOrigins = parseAllowedOrigins();

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );

    res.setHeader(
      "Vary",
      "Origin"
    );
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Notify-Secret"
  );
}

function isAllowedRequest(req) {
  const expectedSecret = String(
    process.env.NOTIFY_SECRET || ""
  ).trim();

  const receivedSecret = String(
    getHeader(req, "x-notify-secret") || ""
  ).trim();

  // Серверный/Android-клиент может использовать секрет.
  if (
    expectedSecret &&
    receivedSecret &&
    receivedSecret === expectedSecret
  ) {
    return true;
  }

  const allowedOrigins = parseAllowedOrigins();

  if (!allowedOrigins.length) {
    return false;
  }

  const origin = String(
    getHeader(req, "origin") || ""
  )
    .trim()
    .replace(/\/+$/, "");

  if (origin && allowedOrigins.includes(origin)) {
    return true;
  }

  const refererOrigin = getRefererOrigin(req);

  if (
    refererOrigin &&
    allowedOrigins.includes(refererOrigin)
  ) {
    return true;
  }

  return false;
}

function parseBody(req) {
  if (!req.body) return {};

  if (typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return {};
}

function parseAssignees(value) {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .map(String)
          .map(item => item.trim())
          .filter(Boolean)
      ),
    ];
  }

  const raw = String(value || "").trim();

  if (!raw) return [];

  return [
    ...new Set(
      raw
        .split(",")
        .map(item => item.trim())
        .filter(Boolean)
    ),
  ];
}

function getTaskAssignees(task, body) {
  // Главный источник — сама задача в Firestore.
  if (Array.isArray(task.assigneeIds)) {
    return parseAssignees(task.assigneeIds);
  }

  if (Array.isArray(task.assignees)) {
    return parseAssignees(task.assignees);
  }

  // Оставлено для совместимости со старыми задачами.
  return parseAssignees(body.assigneeIds);
}

async function getUserById(db, uid) {
  const snap = await db
    .collection("users")
    .doc(uid)
    .get();

  if (!snap.exists) {
    return null;
  }

  return {
    id: uid,
    ...(snap.data() || {}),
  };
}

async function collectTargetTokens({
  db,
  assigneeIds,
  authorUid,
}) {
  let tokens = [];
  const pickedUsers = [];

  if (
    Array.isArray(assigneeIds) &&
    assigneeIds.length > 0
  ) {
    // Читаем назначенных пользователей параллельно.
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
        if (token) {
          tokens.push(String(token));
        }
      }
    }
  } else {
    // Самовывоз: только пользователи, находящиеся на самовывозе.
    const querySnap = await db
      .collection("users")
      .where("onPickup", "==", true)
      .get();

    for (const doc of querySnap.docs) {
      const user = doc.data() || {};
      const role = normRole(user.role);

      if (
        role !== "storekeeper" &&
        role !== "head"
      ) {
        continue;
      }

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
        if (token) {
          tokens.push(String(token));
        }
      }
    }
  }

  // Убираем одинаковые токены.
  tokens = [
    ...new Set(tokens),
  ].filter(Boolean);

  // Не отправляем пуш автору задачи.
  if (authorUid) {
    const author = await getUserById(
      db,
      String(authorUid)
    );

    if (author) {
      const authorTokens = new Set(
        Array.isArray(author.fcmTokens)
          ? author.fcmTokens
              .map(String)
              .filter(Boolean)
          : []
      );

      tokens = tokens.filter(
        token => !authorTokens.has(token)
      );
    }
  }

  console.log(
    "👥 Picked users:",
    pickedUsers.length,
    "🎫 Unique tokens:",
    tokens.length
  );

  return {
    tokens,
    pickedUsers,
  };
}

/**
 * Атомарно пытаемся забрать lock.
 *
 * Возможные результаты:
 * acquired=true:
 *   этот запрос может отправлять пуш.
 *
 * completed=true:
 *   пуш уже был обработан, повтор не нужен.
 *
 * busy=true:
 *   другой Vercel-запрос сейчас отправляет этот пуш.
 */
async function acquireNotifyLock({
  db,
  lockRef,
  taskId,
}) {
  return db.runTransaction(async transaction => {
    const snap = await transaction.get(lockRef);

    const nowMs = Date.now();
    const leaseUntilMs = nowMs + LOCK_LEASE_MS;
    const expiresAtMs = nowMs + LOCK_EXPIRES_MS;

    let previousAttemptCount = 0;

    if (snap.exists) {
      const lock = snap.data() || {};
      const status = String(lock.status || "");

      /*
       * Старые lock-документы не имели status.
       * Считаем их завершёнными, чтобы случайно
       * не отправить старые пуши ещё раз.
       */
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

      previousAttemptCount = Number(
        lock.attemptCount || 0
      );

      const oldLeaseUntilMs =
        typeof lock.leaseUntil?.toMillis === "function"
          ? lock.leaseUntil.toMillis()
          : 0;

      if (
        status === "processing" &&
        oldLeaseUntilMs > nowMs
      ) {
        return {
          acquired: false,
          completed: false,
          busy: true,
          retryAfterMs: Math.max(
            1000,
            oldLeaseUntilMs - nowMs
          ),
        };
      }
    }

    const lockData = {
      eventType: "taskCreated",
      taskId: String(taskId),

      status: "processing",

      attemptCount: previousAttemptCount + 1,

      leaseUntil:
        admin.firestore.Timestamp.fromMillis(
          leaseUntilMs
        ),

      expiresAt:
        admin.firestore.Timestamp.fromMillis(
          expiresAtMs
        ),

      updatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!snap.exists) {
      lockData.createdAt =
        admin.firestore.FieldValue.serverTimestamp();
    }

    transaction.set(
      lockRef,
      lockData,
      {
        merge: true,
      }
    );

    return {
      acquired: true,
      completed: false,
      busy: false,
      attemptCount: previousAttemptCount + 1,
    };
  });
}

async function markLockCompleted({
  lockRef,
  result,
}) {
  await lockRef.set(
    {
      status: "completed",

      leaseUntil:
        admin.firestore.Timestamp.fromMillis(0),

      sentCount: Number(result.sentCount || 0),
      failureCount: Number(result.failureCount || 0),
      tokensTried: Number(result.tokensTried || 0),

      completedAt:
        admin.firestore.FieldValue.serverTimestamp(),

      updatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
    },
    {
      merge: true,
    }
  );
}

async function markLockRetryableFailure({
  lockRef,
  error,
}) {
  const errorText = String(
    error?.message || error || "Unknown error"
  ).slice(0, 1000);

  await lockRef.set(
    {
      status: "retryable_failed",

      leaseUntil:
        admin.firestore.Timestamp.fromMillis(0),

      lastError: errorText,

      lastFailedAt:
        admin.firestore.FieldValue.serverTimestamp(),

      updatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
    },
    {
      merge: true,
    }
  );
}

async function sendMulticastInChunks(
  tokens,
  message
) {
  let sentCount = 0;
  let failureCount = 0;

  const failureCodes = {};

  // Firebase разрешает максимум 500 токенов за один multicast.
  for (
    let offset = 0;
    offset < tokens.length;
    offset += 500
  ) {
    const chunk = tokens.slice(
      offset,
      offset + 500
    );

    const response =
      await admin
        .messaging()
        .sendEachForMulticast({
          tokens: chunk,
          ...message,
        });

    sentCount += Number(
      response.successCount || 0
    );

    failureCount += Number(
      response.failureCount || 0
    );

    response.responses.forEach(item => {
      if (item.success) return;

      const code = String(
        item.error?.code || "unknown"
      );

      failureCodes[code] =
        Number(failureCodes[code] || 0) + 1;
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
  let db = null;
  let lockRef = null;
  let lockAcquired = false;

  /*
   * Становится true только после того,
   * как Firebase Messaging вернул результат.
   */
  let fcmRequestFinished = false;

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
        retryable: false,
        final: true,
        reason: "method not allowed",
      });
    }

    /*
     * До этой проверки Firebase вообще не читаем.
     */
    if (!isAllowedRequest(req)) {
      console.log(
        "🚫 notify-taskCreated rejected: not allowed"
      );

      return res.status(403).json({
        ok: false,
        retryable: false,
        final: true,
        reason: "not allowed",
      });
    }

    const body = parseBody(req);

    const taskId = String(
      body.taskId || ""
    ).trim();

    if (!taskId) {
      return res.status(400).json({
        ok: false,
        retryable: false,
        final: true,
        reason: "taskId required",
      });
    }

    initAdmin();

    db = admin.firestore();

    /*
     * Сначала проверяем задачу.
     * Пустой lock для несуществующей задачи не создаём.
     */
    const taskSnap = await db
      .collection("tasks")
      .doc(taskId)
      .get();

    if (!taskSnap.exists) {
      console.log(
        "⚠️ Task not found:",
        taskId
      );

      return res.status(404).json({
        ok: false,
        retryable: false,
        final: true,
        reason: "task not found",
      });
    }

    const task = taskSnap.data() || {};

    const lockId = `taskCreated_${taskId}`;

    lockRef = db
      .collection("_notifyLocks")
      .doc(lockId);

    const lockResult = await acquireNotifyLock({
      db,
      lockRef,
      taskId,
    });

    if (lockResult.completed) {
      console.log(
        "♻️ Notification already completed:",
        taskId
      );

      return res.status(200).json({
        ok: true,
        final: true,
        duplicate: true,
        sent: 0,
        reason: lockResult.legacy
          ? "legacy lock exists"
          : "already notified",
      });
    }

    if (lockResult.busy) {
      console.log(
        "⏳ Notification is already processing:",
        taskId
      );

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

    const assigneeIds = getTaskAssignees(
      task,
      body
    );

    const authorUid = String(
      task.creatorId ||
      task.authorUid ||
      task.createdBy ||
      ""
    ).trim();

    console.log("🧾 Task notification:", {
      taskId,
      authorUid,
      assigneesCount: assigneeIds.length,
      attempt: lockResult.attemptCount,
    });

    const {
      tokens,
    } = await collectTargetTokens({
      db,
      assigneeIds,
      authorUid,
    });

    /*
     * Нет токенов — повторять бессмысленно.
     * Отмечаем событие завершённым.
     */
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
      : task.creatorName
        ? `От: ${String(task.creatorName)}`
        : "Новое задание";

    const message = {
      android: {
        priority: "high",

        // Firebase Admin Node принимает TTL в миллисекундах.
        // Это реальные 24 часа.
        ttl: 24 * 60 * 60 * 1000,
      },

      data: {
        type: "taskCreated",
        taskId: String(taskId),
        title: String(title),
        body: String(pushBody),
      },
    };

    const sendResult =
      await sendMulticastInChunks(
        tokens,
        message
      );

    /*
     * Firebase Messaging уже вернул результат.
     * Даже если отдельные токены невалидны,
     * повторять весь multicast нельзя —
     * иначе рабочие токены получат второй пуш.
     */
    fcmRequestFinished = true;

    console.log(
      `📨 Sent: ${sendResult.sentCount}, ` +
      `failed: ${sendResult.failureCount}, ` +
      `tried: ${sendResult.tokensTried}`
    );

    if (
      Object.keys(sendResult.failureCodes).length
    ) {
      console.log(
        "⚠️ FCM token failures:",
        sendResult.failureCodes
      );
    }

    /*
     * Сохраняем completed.
     *
     * Если эта запись неожиданно не получится,
     * всё равно возвращаем браузеру успех:
     * Firebase Messaging уже принял запрос,
     * а повтор может создать дубли.
     */
    try {
      await markLockCompleted({
        lockRef,
        result: sendResult,
      });
    } catch (lockError) {
      console.error(
        "⚠️ Push sent, but lock completion failed:",
        lockError
      );
    }

    return res.status(200).json({
      ok: true,
      final: true,

      sent: sendResult.sentCount,
      failed: sendResult.failureCount,
      tokensTried: sendResult.tokensTried,

      /*
       * Отдельные ошибки токенов считаются
       * окончательным результатом.
       * Браузер должен удалить запрос из очереди.
       */
      retryable: false,
    });
  } catch (error) {
    console.error(
      "🔥 notify-taskCreated error:",
      error
    );

    /*
     * Освобождаем lock только если FCM ещё
     * не успел вернуть результат отправки.
     *
     * После этого браузерная очередь сможет
     * безопасно повторить запрос.
     */
    if (
      lockAcquired &&
      lockRef &&
      !fcmRequestFinished
    ) {
      try {
        await markLockRetryableFailure({
          lockRef,
          error,
        });
      } catch (lockError) {
        console.error(
          "🔥 Failed to release notify lock:",
          lockError
        );
      }
    }

    return res.status(503).json({
      ok: false,
      final: false,
      retryable: true,
      sent: 0,
      error: String(
        error?.message ||
        error ||
        "Unknown notification error"
      ),
    });
  }
}
