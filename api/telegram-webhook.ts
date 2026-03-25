/**
 * api/telegram-webhook.ts
 * ─────────────────────────────────────────────────────────────
 * State Machine:
 *   awaiting_email          → kullanıcı BLS e-posta adresini gönderir
 *   awaiting_password       → kullanıcı BLS şifresini gönderir
 *   awaiting_captcha_login  → kullanıcı login CAPTCHA kodunu gönderir
 *   awaiting_date           → kullanıcı tarih seçer (GG-AA-YYYY)
 *   awaiting_captcha_final  → kullanıcı final CAPTCHA kodunu gönderir
 * ─────────────────────────────────────────────────────────────
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { TelegramUpdate, sendMessage, sendError } from '../lib/telegram'
import { getActiveSession, createSession, updateSession, advanceSession } from '../lib/supabase'
import {
  step1_captureLoginCaptcha,
  step2_loginAndFillForm,
  step3_selectDateAndCaptureFinalCaptcha,
  step4_submitAndConfirm,
} from '../services/browser'

const DATE_REGEX = /^\d{2}-\d{2}-\d{4}$/
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const update = req.body as TelegramUpdate
  const message = update?.message
  if (!message?.text) return res.status(200).json({ ok: true })

  const chatId = String(message.chat.id)
  const text   = message.text.trim()

  // Vercel'e hemen 200 dön, işlemi arka planda çalıştır
  res.status(200).json({ ok: true })

  await processMessage(chatId, text).catch((err) => {
    console.error('[webhook]', err)
  })
}

async function processMessage(chatId: string, text: string): Promise<void> {

  // ── /start ────────────────────────────────────────────────────────
  if (text === '/start') {
    // Varsa önceki oturumu kapat
    const existing = await getActiveSession(chatId)
    if (existing) {
      await updateSession(existing.id, { current_step: 'failed', status: 'closed' })
    }

    await createSession(chatId)
    await sendMessage(
      chatId,
      '👋 <b>MkcVisa Bot</b>\n\n' +
      'BLS Spain randevu sürecini başlatıyoruz.\n\n' +
      '📧 Lütfen BLS Spain <b>e-posta adresinizi</b> gönderin:',
    )
    return
  }

  // ── /status ───────────────────────────────────────────────────────
  if (text === '/status') {
    const session = await getActiveSession(chatId)
    if (!session) {
      await sendMessage(chatId, 'ℹ️ Aktif oturum yok. /start ile başlayın.')
    } else {
      await sendMessage(
        chatId,
        `📊 <b>Oturum Durumu</b>\n` +
        `Adım: <b>${session.current_step}</b>\n` +
        `Başlangıç: ${new Date(session.created_at).toLocaleString('tr-TR')}`,
      )
    }
    return
  }

  // ── /cancel ───────────────────────────────────────────────────────
  if (text === '/cancel') {
    const session = await getActiveSession(chatId)
    if (!session) {
      await sendMessage(chatId, 'ℹ️ İptal edilecek aktif oturum yok.')
      return
    }
    await updateSession(session.id, { current_step: 'failed', status: 'closed' })
    await sendMessage(chatId, '🛑 Oturum iptal edildi. Yeniden başlamak için /start gönderin.')
    return
  }

  // ── Aktif oturumu al ──────────────────────────────────────────────
  const session = await getActiveSession(chatId)
  if (!session) {
    await sendMessage(chatId, '⚠️ Oturum bulunamadı. /start ile başlayın.')
    return
  }

  // ── State Machine ─────────────────────────────────────────────────
  switch (session.current_step) {

    // ── E-posta toplama ───────────────────────────────────────────────
    case 'awaiting_email': {
      if (!EMAIL_REGEX.test(text)) {
        await sendMessage(chatId, '⚠️ Geçersiz e-posta. Lütfen tekrar girin:')
        return
      }
      await updateSession(session.id, {
        current_step: 'awaiting_password',
        login_data: { email: text, password: '' },
      })
      await sendMessage(
        chatId,
        `✅ E-posta alındı.\n\n🔑 Lütfen BLS Spain <b>şifrenizi</b> gönderin:\n\n` +
        `<i>(Mesajınız alındıktan sonra silinmeyecek, lütfen dikkatli olun.)</i>`,
      )
      break
    }

    // ── Şifre toplama + Adım 1 tetikleme ─────────────────────────────
    case 'awaiting_password': {
      if (text.length < 4) {
        await sendMessage(chatId, '⚠️ Şifre çok kısa. Lütfen tekrar girin:')
        return
      }
      const loginData = { ...(session.login_data as { email: string; password: string }), password: text }
      await updateSession(session.id, {
        current_step: 'start',
        login_data: loginData,
      })
      await sendMessage(chatId, '🚀 Bilgiler alındı! BLS Spain\'e bağlanılıyor, CAPTCHA alınıyor...')
      // Adım 1'i hemen başlat
      await step1_captureLoginCaptcha({ ...session, login_data: loginData, current_step: 'start' })
      break
    }

    // ── Login CAPTCHA kodu ────────────────────────────────────────────
    case 'awaiting_captcha_login': {
      const captchaCode = text.replace(/\s+/g, '').toUpperCase()
      if (captchaCode.length < 4) {
        await sendMessage(chatId, '⚠️ Geçersiz kod. Görseldeki kodu tekrar girin:')
        return
      }
      await sendMessage(chatId, `🔄 Kod: <code>${captchaCode}</code> — Login yapılıyor...`)
      await step2_loginAndFillForm(session, captchaCode)
      break
    }

    // ── Tarih seçimi ──────────────────────────────────────────────────
    case 'awaiting_date': {
      if (!DATE_REGEX.test(text)) {
        await sendMessage(
          chatId,
          '⚠️ Geçersiz format.\n<b>GG-AA-YYYY</b> şeklinde girin.\nÖrnek: <code>25-06-2026</code>',
        )
        return
      }
      await sendMessage(chatId, `📅 <b>${text}</b> seçiliyor...`)
      await step3_selectDateAndCaptureFinalCaptcha(session, text)
      break
    }

    // ── Final CAPTCHA kodu ────────────────────────────────────────────
    case 'awaiting_captcha_final': {
      const finalCode = text.replace(/\s+/g, '').toUpperCase()
      if (finalCode.length < 4) {
        await sendMessage(chatId, '⚠️ Geçersiz kod. Son kodu tekrar girin:')
        return
      }
      await sendMessage(chatId, `🔄 Son kod: <code>${finalCode}</code> — Randevu tamamlanıyor...`)
      await step4_submitAndConfirm(session, finalCode)
      break
    }

    case 'completed':
      await sendMessage(chatId, '✅ Randevunuz tamamlandı. Yeni süreç için /start gönderin.')
      break

    case 'failed':
    case 'no_slots':
      await sendMessage(chatId, '⚠️ Önceki işlem kapandı. Yeniden başlamak için /start gönderin.')
      break

    default:
      await sendError(chatId, `Tanınmayan adım: ${session.current_step}`)
  }
}
