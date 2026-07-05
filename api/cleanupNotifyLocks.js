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

  return app;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    initAdmin();

    const db = admin.firestore();
    const col = db.collection("_notifyLocks");

    let totalDeleted = 0;
    const batchSize = 300;

    while (true) {
      const snap = await col.limit(batchSize).get();

      if (snap.empty) break;

      const batch = db.batch();

      snap.docs.forEach(doc => {
        batch.delete(doc.ref);
      });

      await batch.commit();

      totalDeleted += snap.size;

      if (snap.size < batchSize) break;
    }

    return res.status(200).json({
      ok: true,
      deleted: totalDeleted,
    });
  } catch (e) {
    console.error("cleanupNotifyLocks error:", e);

    return res.status(200).json({
      ok: false,
      error: String(e.message || e),
    });
  }
}
