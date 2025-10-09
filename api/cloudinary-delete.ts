// /api/cloudinary-delete.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { v2 as cloudinary } from 'cloudinary'

/** ---- Конфиг Cloudinary: принимаем и CLOUDINARY_URL, и тройку ---- */
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
cloudinary.config({ secure: true })

/** ---- Вспомогательное: парсер тела из Postman/Insomnia/curl ---- */
function parseBody(req: VercelRequest): any {
  const ctype = (req.headers['content-type'] || '').toLowerCase()
  const raw = req.body
  if (!raw) return {}

  if (typeof raw === 'object') {
    // JSON уже распарсен (application/json) или form-urlencoded уже собран в объект
    return raw
  }
  if (typeof raw === 'string') {
    // иногда Vercel отдаёт строкой, если не смог распарсить
    if (ctype.includes('application/json')) {
      try { return JSON.parse(raw) } catch { return {} }
    }
    // простейший разбор a=b&c=d → {a: 'b', c: 'd'}
    if (ctype.includes('application/x-www-form-urlencoded')) {
      const obj: Record<string,string> = {}
      raw.split('&').forEach(p => {
        const [k, v] = p.split('=')
        if (k) obj[decodeURIComponent(k)] = decodeURIComponent(v || '')
      })
      return obj
    }
  }
  return {}
}

/** ---- Handler ---- */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1) Диагностика: GET /api/cloudinary-delete?ping=1
  if (req.method === 'GET' && (req.query.ping === '1' || req.query.ping === 'true')) {
    try {
      const cfgOk = hasUrl || hasTriple
      const ping = cfgOk ? await (cloudinary as any).api.ping?.() : null
      return res.status(200).json({
        ok: true,
        env: {
          CLOUDINARY_URL: !!process.env.CLOUDINARY_URL,
          CLOUDINARY_CLOUD_NAME: !!process.env.CLOUDINARY_CLOUD_NAME,
          CLOUDINARY_API_KEY: !!process.env.CLOUDINARY_API_KEY,
          CLOUDINARY_API_SECRET: !!process.env.CLOUDINARY_API_SECRET,
        },
        cfgOk,
        ping: ping ?? 'no api.ping available (SDK without ping)',
      })
    } catch (e: any) {
      return res.status(500).json({
        ok: false,
        where: 'ping',
        error: e?.error?.message || e?.message || 'ping failed',
        name: e?.name, http_code: e?.http_code
      })
    }
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed')

  // 2) Понятная ошибка, если конфиг не виден
  if (!hasUrl && !hasTriple) {
    return res.status(500).json({
      error: 'Cloudinary config is missing. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET in Vercel → Settings → Environment Variables. Then redeploy.',
      have: {
        CLOUDINARY_URL: !!process.env.CLOUDINARY_URL,
        CLOUDINARY_CLOUD_NAME: !!process.env.CLOUDINARY_CLOUD_NAME,
        CLOUDINARY_API_KEY: !!process.env.CLOUDINARY_API_KEY,
        CLOUDINARY_API_SECRET: !!process.env.CLOUDINARY_API_SECRET,
      },
    })
  }

  try {
    const body = parseBody(req)

    // A) publicIds
    let publicIds: string[] | undefined = body.publicIds
    if (typeof publicIds === 'string') {
      publicIds = publicIds.split(',').map(s => s.trim()).filter(Boolean)
    }
    // B) taskId
    const taskId: string | undefined = body.taskId || body.taskid || body.taskID

    if ((!publicIds || publicIds.length === 0) && !taskId) {
      return res.status(200).json({ deleted: 0, mode: 'noop' })
    }

    let deleted = 0

    if (publicIds && publicIds.length > 0) {
      const chunk = (arr: string[], n: number) =>
        arr.reduce((a, _, i) => (i % n ? a[a.length - 1].push(arr[i]) : a.push([arr[i]]), a), [] as string[][])

      const chunks = chunk(publicIds, 80)
      for (const ids of chunks) {
        // Удаляем для image/raw/video — на случай, если есть видео
        const r1 = await cloudinary.api.delete_resources(ids, { resource_type: 'image' })
        const r2 = await cloudinary.api.delete_resources(ids, { resource_type: 'raw' })
        const r3 = await cloudinary.api.delete_resources(ids, { resource_type: 'video' }).catch(() => ({ deleted: {} }))
        deleted += Object.keys((r1 as any).deleted || {}).length
        deleted += Object.keys((r2 as any).deleted || {}).length
        deleted += Object.keys((r3 as any).deleted || {}).length
      }
      return res.status(200).json({ deleted, mode: 'byPublicIds' })
    }

    if (taskId) {
      const prefix = `tasks/${taskId}`
      const r1 = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: 'image' })
      const r2 = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: 'raw' })
      const r3 = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: 'video' }).catch(() => ({ deleted: {}, partial: false }))
      deleted += (r1 as any).partial ? 0 : Object.values((r1 as any).deleted || {}).length
      deleted += (r2 as any).partial ? 0 : Object.values((r2 as any).deleted || {}).length
      deleted += (r3 as any).partial ? 0 : Object.values((r3 as any).deleted || {}).length
      try { await cloudinary.api.delete_folder(prefix) } catch {}
      return res.status(200).json({ deleted, mode: 'byTaskPrefix', prefix })
    }

    return res.status(200).json({ deleted, mode: 'unknown' })
  } catch (e: any) {
    return res.status(500).json({
      error: e?.error?.message || e?.error?.error?.message || e?.message || 'Internal error',
      name: e?.name, http_code: e?.http_code
    })
  }
}
