import { createClient, SupabaseClient } from '@supabase/supabase-js'

// ── Singleton istemci (Vercel warm start'ta yeniden oluşturmaktan kaçın) ──
let _client: SupabaseClient | null = null

function getClient(): SupabaseClient {
  if (_client) return _client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL veya SUPABASE_SERVICE_ROLE_KEY eksik')
  _client = createClient(url, key, {
    auth: { persistSession: false },
  })
  return _client
}

// ── Tipler ────────────────────────────────────────────────────────────────

export type StepName =
  | 'awaiting_email'
  | 'awaiting_password'
  | 'start'
  | 'awaiting_captcha_login'
  | 'filling_form'
  | 'awaiting_date'
  | 'awaiting_captcha_final'
  | 'completed'
  | 'failed'
  | 'no_slots'

export interface Session {
  id: string
  chat_id: string
  current_step: StepName
  login_data?: { email: string; password: string }
  form_data?: Record<string, unknown>
  selected_date?: string
  browser_state?: Record<string, unknown>   // Playwright StorageState
  status: 'active' | 'closed'
  created_at: string
  updated_at: string
}

export interface CaptchaRecord {
  id: string
  session_id: string
  storage_path: string
  public_url?: string
  type: 'login' | 'final'
  solution?: string
}

// ── Session Yardımcıları ───────────────────────────────────────────────────

/**
 * Belirtilen chat_id için aktif oturumu döndürür.
 * Birden fazla varsa en yenisini alır.
 */
export async function getActiveSession(chatId: string): Promise<Session | null> {
  const { data, error } = await getClient()
    .from('sessions')
    .select('*')
    .eq('chat_id', chatId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`getActiveSession: ${error.message}`)
  return data as Session | null
}

/**
 * Yeni bir oturum oluşturur ve döndürür.
 */
export async function createSession(chatId: string): Promise<Session> {
  const { data, error } = await getClient()
    .from('sessions')
    .insert({
      chat_id: chatId,
      current_step: 'awaiting_email' as StepName,
      status: 'active',
    })
    .select()
    .single()

  if (error) throw new Error(`createSession: ${error.message}`)
  return data as Session
}

/**
 * Oturumu kısmen günceller.
 */
export async function updateSession(
  sessionId: string,
  updates: Partial<Omit<Session, 'id' | 'created_at' | 'updated_at'>>,
): Promise<void> {
  const { error } = await getClient()
    .from('sessions')
    .update(updates)
    .eq('id', sessionId)

  if (error) throw new Error(`updateSession: ${error.message}`)
}

/**
 * Playwright storageState'i Supabase'e kaydeder.
 */
export async function saveBrowserState(
  sessionId: string,
  state: Record<string, unknown>,
): Promise<void> {
  await updateSession(sessionId, { browser_state: state })
}

/**
 * Oturumu adım ve tarayıcı durumuyla birlikte ilerletir.
 */
export async function advanceSession(
  sessionId: string,
  nextStep: StepName,
  state: Record<string, unknown>,
  extra?: Partial<Session>,
): Promise<void> {
  await updateSession(sessionId, {
    current_step: nextStep,
    browser_state: state,
    ...extra,
  })
}

/**
 * Oturumu kapatır (başarılı veya başarısız).
 */
export async function closeSession(
  sessionId: string,
  finalStep: StepName,
): Promise<void> {
  await updateSession(sessionId, { current_step: finalStep, status: 'closed' })
}

// ── Storage / Ekran Görüntüsü ─────────────────────────────────────────────

const BUCKET = 'visa-bot'

/**
 * PNG buffer'ı Supabase Storage'a yükler ve public URL döndürür.
 */
export async function uploadScreenshot(
  sessionId: string,
  buffer: Buffer,
  filename: string,
): Promise<string> {
  const path = `screenshots/${sessionId}/${filename}`

  const { error: uploadError } = await getClient()
    .storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: 'image/png', upsert: true })

  if (uploadError) throw new Error(`uploadScreenshot: ${uploadError.message}`)

  // Signed URL oluştur (1 saat geçerli) — bucket private ise bu gerekli
  const { data, error: urlError } = await getClient()
    .storage
    .from(BUCKET)
    .createSignedUrl(path, 3600)

  if (urlError) throw new Error(`createSignedUrl: ${urlError.message}`)
  return data.signedUrl
}

/**
 * Captcha kaydı oluşturur.
 */
export async function saveCaptchaRecord(
  sessionId: string,
  storagePath: string,
  publicUrl: string,
  type: 'login' | 'final',
): Promise<void> {
  const { error } = await getClient()
    .from('captchas')
    .insert({ session_id: sessionId, storage_path: storagePath, public_url: publicUrl, type })

  if (error) throw new Error(`saveCaptchaRecord: ${error.message}`)
}

export { getClient as supabase }
