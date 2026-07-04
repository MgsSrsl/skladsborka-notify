// /api/notify-taskFinished.js
// Старый endpoint выключен.
// Отвечаем 200 OK, чтобы старые Android-клиенты не ретраили.
// Firebase НЕ трогаем.

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    return res.status(200).json({
      ok: true,
      sent: 0,
      ignored: true,
      endpoint: "notify-taskFinished",
      reason: "disabled"
    });
  } catch (e) {
    return res.status(200).json({
      ok: true,
      sent: 0,
      ignored: true
    });
  }
}
