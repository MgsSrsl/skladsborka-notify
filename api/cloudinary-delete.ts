// /api/cloudinary-delete.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { v2 as cloudinary } from 'cloudinary'

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,   // dnx1taqp7
  api_key:    process.env.CLOUDINARY_API_KEY!,
  api_secret: process.env.CLOUDINARY_API_SECRET!
})

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed')
  try {
    const { publicIds } = req.body as { publicIds: string[] }
    if (!Array.isArray(publicIds) || publicIds.length === 0) {
      return res.status(200).json({ deleted: 0 })
    }
    // удаляем батчем (Cloudinary сам примет разный resource_type по public_id не знает,
    // поэтому вызываем для 'image' и 'raw' — либо используем delete_resources_by_prefix по папке)
    const chunk = (arr: string[], n: number) => arr.reduce((a,_,i)=> (i%n? a[a.length-1].push(arr[i]) : a.push([arr[i]]), a), [] as string[][])
    const chunks = chunk(publicIds, 80)
    let deleted = 0
    for (const ids of chunks) {
      const r1 = await cloudinary.api.delete_resources(ids, { resource_type: 'image' })
      const r2 = await cloudinary.api.delete_resources(ids, { resource_type: 'raw' })
      deleted += Object.keys(r1.deleted).length + Object.keys(r2.deleted).length
    }
    return res.status(200).json({ deleted })
  } catch (e:any) {
    return res.status(500).json({ error: e.message })
  }
}
