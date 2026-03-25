/**
 * Telegram Bot API yardımcıları.
 * Tüm istekler fetch ile yapılır — harici bağımlılık yok.
 */

const BASE = () =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`

// ── Tipler ────────────────────────────────────────────────────────────────

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

export interface TelegramMessage {
  message_id: number
  from?: { id: number; username?: string }
  chat: { id: number }
  text?: string
}

// ── Gönderme fonksiyonları ────────────────────────────────────────────────

async function apiCall(method: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${BASE()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Telegram ${method} başarısız: ${text}`)
  }
}

/** Düz metin mesajı gönderir. */
export async function sendMessage(chatId: string | number, text: string): Promise<void> {
  await apiCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  })
}

/**
 * URL üzerinden fotoğraf gönderir.
 * Supabase signed URL'leri doğrudan gönderilebilir.
 */
export async function sendPhoto(
  chatId: string | number,
  photoUrl: string,
  caption?: string,
): Promise<void> {
  await apiCall('sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
  })
}

/**
 * Buffer olarak fotoğraf gönderir (multipart/form-data).
 * Signed URL oluşturulamadığı durumlarda kullanın.
 */
export async function sendPhotoBuffer(
  chatId: string | number,
  buffer: Buffer,
  filename: string,
  caption?: string,
): Promise<void> {
  const formData = new FormData()
  formData.append('chat_id', String(chatId))
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
  formData.append('photo', new Blob([ab], { type: 'image/png' }), filename)
  if (caption) formData.append('caption', caption)

  const res = await fetch(`${BASE()}/sendPhoto`, { method: 'POST', body: formData })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`sendPhotoBuffer başarısız: ${text}`)
  }
}

/** Hata mesajı gönderir (emoji ile). */
export async function sendError(chatId: string | number, detail: string): Promise<void> {
  await sendMessage(chatId, `❌ <b>Hata:</b> ${detail}`)
}

/** Başarı mesajı gönderir. */
export async function sendSuccess(chatId: string | number, detail: string): Promise<void> {
  await sendMessage(chatId, `✅ ${detail}`)
}

/** Bilgi mesajı gönderir. */
export async function sendInfo(chatId: string | number, detail: string): Promise<void> {
  await sendMessage(chatId, `ℹ️ ${detail}`)
}

// ── Webhook kurulum yardımcısı ─────────────────────────────────────────────

/**
 * Telegram webhook'unu Vercel URL'ine yönlendirir.
 * Tek seferlik kurulum için terminal'den çağrılabilir:
 *   npx ts-node -e "require('./lib/telegram').registerWebhook('https://your-app.vercel.app')"
 */
export async function registerWebhook(baseUrl: string): Promise<void> {
  const url = `${baseUrl}/api/telegram-webhook`
  const res = await fetch(`${BASE()}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, allowed_updates: ['message'] }),
  })
  const json = (await res.json()) as { ok: boolean; description?: string }
  if (!json.ok) throw new Error(`setWebhook başarısız: ${json.description}`)
  console.log(`Webhook kayıt edildi: ${url}`)
}
