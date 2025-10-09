// /api/cloudinary-delete.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { v2 as cloudinary } from 'cloudinary'

// ✅ используем одну переменную окружения CLOUDINARY_URL
// пример значения: cloudinary://658194199323454:cwZRZ5PCIF4DqSqPO9-5lwHveiw@dnx1taqp7
const CLOUDINARY_URL = process.env.CLOUDINARY_URL

if (!CLOUDINARY_URL) {
  throw new Error('CLOUDINARY_URL is not set in environment variables')
}

// Можно передать URL целиком — SDK сам разберёт ключ/секрет/облако.
// Дополнительно включим secure-доставку (https).
cloudinary.config(CLOUDINARY_URL)
cloudinary.config({ secure: true })

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed')

  try {
    const ctype = (req.headers['content-type'] || '').toLowerCase()
    const body: any =
      ctype.includes('application/json') ? (req.body || {}) :
      ctype.includes('application/x-www-form-urlencoded') ? req.body :
      req.body || {}

    let publicIds: string[] | undefined = body.publicIds
    if (typeof publicIds === 'string') {
      publicIds = publicIds.split(',').map((s) => s.trim()).filter(Boolean)
    }

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
      try { await cloudinary.api.delete_folder(prefix) } catch {}
      return res.status(200).json({ deleted, mode: 'byTaskPrefix', prefix })
    }

    return res.status(200).json({ deleted, mode: 'unknown' })
  } catch (e: any) {
    const msg = e?.message || 'Internal error'
    const name = e?.name
    const http_code = e?.http_code
    const error = e?.error?.message || e?.error?.error?.message
    return res.status(500).json({ error: error || msg, name, http_code })
  }
}
