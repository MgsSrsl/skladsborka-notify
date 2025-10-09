// /api/cloudinary-delete.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { v2 as cloudinary } from 'cloudinary'

/** ---------- Cloudinary config (универсально) ---------- */
const hasUrl = !!process.env.CLOUDINARY_URL
const hasTriple = !!process.env.CLOUDINARY_CLOUD_NAME && !!process.env.CLOUDINARY_API_KEY && !!process.env.CLOUDINARY_API_SECRET

if (hasUrl) {
  cloudinary.config(process.env.CLOUDINARY_URL!)
} else if (hasTriple) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,
    api_key: process.env.CLOUDINARY_API_KEY!,
    api_secret: process.env.CLOUDINARY_API_SECRET!,
  })
}
// https всегда
cloudinary.config({ secure: true })

/** ---------- Handler ---------- */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed')

  // если конфиг не задан — вернём понятную ошибку (а не падение 500 без тела)
  if (!hasUrl && !hasTriple) {
    return res.status(500).json({
      error: 'Cloudinary config is missing. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET in Vercel → Settings → Environment Variables.',
      have: {
        CLOUDINARY_URL: !!process.env.CLOUDINARY_URL,
        CLOUDINARY_CLOUD_NAME: !!process.env.CLOUDINARY_CLOUD_NAME,
        CLOUDINARY_API_KEY: !!process.env.CLOUDINARY_API_KEY,
        CLOUDINARY_API_SECRET: !!process.env.CLOUDINARY_API_SECRET,
      },
    })
  }

  try {
    // Поддержим JSON и x-www-form-urlencoded
    const ctype = (req.headers['content-type'] || '').toLowerCase()
    const body: any =
      ctype.includes('application/json') ? (req.body || {}) :
      ctype.includes('application/x-www-form-urlencoded') ? req.body :
      (req.body || {})

    // A) Удаление по списку publicIds
    let publicIds: string[] | undefined = body.publicIds
    if (typeof publicIds === 'string') {
      publicIds = publicIds.split(',').map(s => s.trim()).filter(Boolean)
    }

    // B) Удаление по taskId → по префиксу tasks/{taskId}
    const taskId: string | undefined = body.taskId || body.taskid || body.taskID

    // Пустой запрос
    if ((!publicIds || publicIds.length === 0) && !taskId) {
      return res.status(200).json({ deleted: 0, mode: 'noop' })
    }

    let deleted = 0

    if (publicIds && publicIds.length > 0) {
      const chunk = (arr: string[], n: number) =>
        arr.reduce((a, _, i) => (i % n ? a[a.length - 1].push(arr[i]) : a.push([arr[i]]), a), [] as string[][])

      const chunks = chunk(publicIds, 80)
      for (const ids of chunks) {
        const r1 = await cloudinary.api.delete_resources(ids, { resource_type: 'image' })
        const r2 = await cloudinary.api.delete_resources(ids, { resource_type: 'raw' })
        deleted += Object.keys(r1.deleted || {}).length + Object.keys(r2.deleted || {}).length
      }
      return res.status(200).json({ deleted, mode: 'byPublicIds' })
    }

    if (taskId) {
      const prefix = `tasks/${taskId}`
      const r1 = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: 'image' })
      const r2 = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: 'raw' })
      deleted += (r1.partial ? 0 : Object.values(r1.deleted || {}).length)
      deleted += (r2.partial ? 0 : Object.values(r2.deleted || {}).length)

      // Пытаемся снести пустую папку (не критично)
      try { await cloudinary.api.delete_folder(prefix) } catch {}

      return res.status(200).json({ deleted, mode: 'byTaskPrefix', prefix })
    }

    // На всякий
    return res.status(200).json({ deleted, mode: 'unknown' })
  } catch (e: any) {
    // Вернём подробности для быстрой диагностики
    return res.status(500).json({
      error: e?.error?.message || e?.error?.error?.message || e?.message || 'Internal error',
      name: e?.name,
      http_code: e?.http_code,
    })
  }
}
