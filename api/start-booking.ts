/**
 * api/start-booking.ts
 * ─────────────────────────────────────────────────────────────
 * Opsiyonel endpoint — sadece sistem sağlık kontrolü için.
 * Artık süreci /start Telegram komutu başlatır.
 * Bu endpoint Vercel Cron'u tarafından kullanılabilir,
 * örneğin günlük "slot var mı?" kontrolü için genişletilebilir.
 * ─────────────────────────────────────────────────────────────
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret =
    req.query.secret ??
    req.headers['x-vercel-cron-secret'] ??
    req.headers['authorization']?.replace('Bearer ', '')

  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  return res.status(200).json({
    ok: true,
    message: 'MkcVisa Bot aktif. Süreci başlatmak için Telegram\'dan /start gönderin.',
    timestamp: new Date().toISOString(),
  })
}
