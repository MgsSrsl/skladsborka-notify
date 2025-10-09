// /api/cloudinary-delete.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { v2 as cloudinary } from 'cloudinary'

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,   // например: dnx1taqp7
  api_key:    process.env.CLOUDINARY_API_KEY!,
  api_secret: process.env.CLOUDINARY_API_SECRET!
})

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed')

  try {
    // Поддержим и JSON, и x-www-form-urlencoded
    const ctype = (req.headers['content-type'] || '').toLowerCase()
    const body: any =
      ctype.includes('application/json') ? (req.body || {}) :
      ctype.includes('application/x-www-form-urlencoded') ? req.body :
      req.body || {}

    // Вариант A: список publicIds
    let publicIds: string[] | undefined = body.publicIds
    if (typeof publicIds === 'string') {
      // если пришёл "a,b,c"
      publicIds = publicIds.split(',').map((s) => s.trim()).filter(Boolean)
    }

    // Вариант B: taskId → удаляем всё по префиксу tasks/{taskId}
    const taskId: string | undefined = body.taskId || body.taskid || body.taskID

    // Пустой запрос — ничего не делаем
    if ((!publicIds || publicIds.length === 0) && !taskId) {
      return res.status(200).json({ deleted: 0, mode: 'noop' })
    }

    let deleted = 0

    // Удаление по списку publicIds
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

    // Удаление по taskId (вся папка tasks/{taskId})
    if (taskId) {
      const prefix = `tasks/${taskId}`
      const r1 = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: 'image' })
      const r2 = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: 'raw' })
      deleted += (r1.partial ? 0 : Object.values(r1.deleted || {}).length)
      deleted += (r2.partial ? 0 : Object.values(r2.deleted || {}).length)

      // Попробуем удалить пустую папку (не критично, если не получится)
      try { await cloudinary.api.delete_folder(prefix) } catch {}

      return res.status(200).json({ deleted, mode: 'byTaskPrefix', prefix })
    }

    // теоретически сюда не попадём
    return res.status(200).json({ deleted, mode: 'unknown' })
  } catch (e: any) {
    // Вернём подробности, чтобы быстро понять причину 500
    const msg = e?.message || 'Internal error'
    const name = e?.name
    const http_code = e?.http_code
    const error = e?.error?.message || e?.error?.error?.message
    return res.status(500).json({ error: error || msg, name, http_code })
  }
}
