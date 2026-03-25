/**
 * services/browser.ts
 * ─────────────────────────────────────────────────────────────
 * Playwright otomasyon — BLS Spain Turkey
 * URL: https://turkey.blsspainglobal.com
 *
 * Site anti-bot koruması:
 *  - Email/şifre input ID'leri her yüklemede rastgele üretilir
 *  - CAPTCHA ayrı bir popup pencerede açılır
 *  - Şifre alanı class="fakepassword" ile tanımlanır
 * ─────────────────────────────────────────────────────────────
 */

import chromium from '@sparticuz/chromium'
import { chromium as playwright, Browser, BrowserContext, Page } from 'playwright-core'
import {
  Session,
  advanceSession,
  closeSession,
  uploadScreenshot,
  saveCaptchaRecord,
} from '../lib/supabase'
import { sendPhoto, sendMessage, sendError } from '../lib/telegram'

// ── Sabitler ──────────────────────────────────────────────────────────────

const BASE_URL = process.env.BLS_BASE_URL ?? 'https://turkey.blsspainglobal.com'
const LOGIN_URL = `${BASE_URL}/Global/account/login`
const APPT_URL  = `${BASE_URL}/Global/appointment/newappointment`
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID!

const FORM_VALUES = {
  juristification : 'Ankara',
  location        : 'Ankara',
  visaType        : 'Schengen Visa Short term visa',
  visaSubType     : 'Tourist Visa',
  appointmentFor  : 'Family',
  numMembers      : '3',
  category        : 'Normal',
} as const

// ── Tarayıcı başlatma ─────────────────────────────────────────────────────

async function launchBrowser(): Promise<{ browser: Browser; ctx: BrowserContext }> {
  const executablePath = await chromium.executablePath()
  const browser = await playwright.launch({
    args: chromium.args,
    executablePath,
    headless: !!chromium.headless,
  })
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })
  return { browser, ctx }
}

async function launchWithState(
  rawState: Record<string, unknown>,
): Promise<{ browser: Browser; ctx: BrowserContext }> {
  const executablePath = await chromium.executablePath()
  const browser = await playwright.launch({
    args: chromium.args,
    executablePath,
    headless: !!chromium.headless,
  })
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageState: rawState as any,
  })
  return { browser, ctx }
}

async function captureState(ctx: BrowserContext): Promise<Record<string, unknown>> {
  return (await ctx.storageState()) as unknown as Record<string, unknown>
}

// ── Yardımcı: Görünür email input ID'sini bul ─────────────────────────────
// Site anti-bot olarak rastgele ID'ler üretiyor.
// JS çalıştıktan sonra yalnızca gerçek input'un parent div'i görünür olur.
async function findVisibleEmailInputId(page: Page): Promise<string> {
  return page.evaluate((): string => {
    const labels = Array.from(document.querySelectorAll<HTMLLabelElement>('label'))
    for (const label of labels) {
      if (!label.textContent?.trim().startsWith('Email')) continue
      const parent = label.closest('div')
      if (!parent) continue
      if (window.getComputedStyle(parent).display === 'none') continue
      if (parent.getBoundingClientRect().width === 0) continue
      const input = parent.querySelector<HTMLInputElement>('input[type="text"]')
      if (input?.id) return input.id
    }
    return ''
  })
}

// ── Yardımcı: Dropdown / select doldur ───────────────────────────────────
async function selectOption(page: Page, selector: string, value: string): Promise<void> {
  const el = page.locator(selector).first()
  const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => 'div')
  if (tag === 'select') {
    await el.selectOption({ label: value })
  } else {
    await el.click()
    await page.locator(`li:has-text("${value}"), .dropdown-item:has-text("${value}")`).first().click()
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ADIM 1: Login sayfasına git → email+şifre doldur → CAPTCHA popup aç →
//          screenshot al → Telegram'a gönder → kapat
// ─────────────────────────────────────────────────────────────────────────
export async function step1_captureLoginCaptcha(session: Session): Promise<void> {
  const { browser, ctx } = await launchBrowser()
  const page = await ctx.newPage()

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60_000 })

    // JS obfuscation çalışsın
    await page.waitForTimeout(1500)

    // ── Görünür email input'unu bul ve doldur ─────────────────────
    const emailId = await findVisibleEmailInputId(page)
    if (!emailId) throw new Error('Email input bulunamadı — site yapısı değişmiş olabilir')
    await page.locator(`#${emailId}`).fill(session.login_data!.email)

    // ── Şifre: class="fakepassword" ───────────────────────────────
    await page.locator('input.fakepassword').fill(session.login_data!.password)

    await page.waitForTimeout(500)

    // ── CAPTCHA popup'ını aç ──────────────────────────────────────
    // Site, CAPTCHA'yı popup pencerede açıyor (OpenWindow).
    // "Verify" butonuna tıkladığımızda önce doğrulama popup'ı açılıyor.
    const [popup] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 15_000 }),
      page.locator('#btnVerify').click(),
    ])

    await popup.waitForLoadState('networkidle', { timeout: 30_000 })

    // ── Popup içindeki CAPTCHA görselini screenshot al ────────────
    // Site genellikle bir <img> veya <canvas> içinde CAPTCHA gösterir
    const captchaImg = popup.locator('img[src*="captcha" i], img.captcha-image, canvas').first()
    await captchaImg.waitFor({ state: 'visible', timeout: 15_000 })

    const captchaBuffer = (await captchaImg.screenshot()) as Buffer

    // Supabase'e yükle
    const filename = `captcha_login_${Date.now()}.png`
    const publicUrl = await uploadScreenshot(session.id, captchaBuffer, filename)
    await saveCaptchaRecord(
      session.id,
      `screenshots/${session.id}/${filename}`,
      publicUrl,
      'login',
    )

    // Tarayıcı durumunu (cookie) kaydet — popup dahil context aynı
    const state = await captureState(ctx)
    await advanceSession(session.id, 'awaiting_captcha_login', state)

    // Telegram'a gönder
    await sendPhoto(
      CHAT_ID,
      publicUrl,
      '🔐 <b>Login CAPTCHA</b>\nGörseldeki kodu yazıp gönderin:',
    )
  } catch (err) {
    await closeSession(session.id, 'failed')
    await sendError(CHAT_ID, `Adım 1: ${(err as Error).message}`)
    throw err
  } finally {
    await browser.close()
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ADIM 2: CAPTCHA kodunu gir → popup'ı kapat → login tamamla → formu doldur
//          → takvim veya "slot yok" screenshot → Telegram'a gönder
// ─────────────────────────────────────────────────────────────────────────
export async function step2_loginAndFillForm(
  session: Session,
  captchaCode: string,
): Promise<void> {
  const { browser, ctx } = await launchWithState(session.browser_state!)
  const page = await ctx.newPage()

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.waitForTimeout(1500)

    // ── Email + şifre tekrar doldur (sayfa yeniden açıldı) ────────
    const emailId = await findVisibleEmailInputId(page)
    if (!emailId) throw new Error('Email input bulunamadı')
    await page.locator(`#${emailId}`).fill(session.login_data!.email)
    await page.locator('input.fakepassword').fill(session.login_data!.password)
    await page.waitForTimeout(500)

    // ── CAPTCHA popup'ını tekrar aç ───────────────────────────────
    const [popup] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 15_000 }),
      page.locator('#btnVerify').click(),
    ])
    await popup.waitForLoadState('networkidle', { timeout: 30_000 })

    // ── Popup içindeki CAPTCHA input'una kodu yaz ─────────────────
    const codeInput = popup.locator('input[type="text"], input[name*="captcha" i], input[id*="captcha" i]').first()
    await codeInput.waitFor({ state: 'visible', timeout: 10_000 })
    await codeInput.fill(captchaCode)

    // ── Popup submit ──────────────────────────────────────────────
    await popup.locator('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Verify")').first().click()

    // Popup kapanana veya ana sayfanın #CaptchaData dolana kadar bekle
    await Promise.race([
      popup.waitForEvent('close', { timeout: 15_000 }),
      page.waitForFunction(() => {
        const el = document.getElementById('CaptchaData') as HTMLInputElement | null
        return el && el.value.length > 0
      }, { timeout: 15_000 }),
    ]).catch(() => {/* timeout — devam et */})

    // ── Ana formu submit et (#btnVerify tekrar tıkla) ─────────────
    // CaptchaData artık doluysa OnSubmitVerify verileri toplar
    await page.locator('#btnVerify').click()

    // ── Login sonucu bekle ────────────────────────────────────────
    await page.waitForURL('**', { waitUntil: 'networkidle', timeout: 45_000 })

    // Hata var mı?
    const errMsg = page.locator('.validation-summary li:visible, .alert-danger, .text-danger:visible')
    if (await errMsg.count() > 0) {
      const txt = await errMsg.first().textContent()
      await sendMessage(CHAT_ID, `⚠️ Hata: ${txt?.trim()}\nYeniden denemek için CAPTCHA kodu gönderin.`)
      // Adım 1'i yeniden başlat
      const state = await captureState(ctx)
      await advanceSession(session.id, 'awaiting_captcha_login', state)
      await step1_captureLoginCaptcha({ ...session, browser_state: state })
      return
    }

    // ── Login başarılı — randevu sayfasına git ────────────────────
    await page.goto(APPT_URL, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.waitForTimeout(1000)

    // ── Formu doldur ──────────────────────────────────────────────

    // Juristification
    await selectOption(page, 'select#Juristification, select[name="Juristification"]', FORM_VALUES.juristification)
    await page.waitForTimeout(600)

    // Location
    await selectOption(page, 'select#Location, select[name="Location"]', FORM_VALUES.location)
    await page.waitForTimeout(600)

    // Visa Type
    await selectOption(page, 'select#VisaType, select[name="VisaType"]', FORM_VALUES.visaType)
    await page.waitForTimeout(800)

    // Visa Sub Type
    await selectOption(page, 'select#VisaSubType, select[name="VisaSubType"]', FORM_VALUES.visaSubType)
    await page.waitForTimeout(600)

    // Appointment For: Family (radyo)
    await page.locator(`input[type="radio"][value="Family"], label:has-text("Family") input`).first().click()
    await page.waitForTimeout(500)

    // Number of Members
    await selectOption(page, 'select#NoOfApplicant, select[name="NoOfApplicant"]', FORM_VALUES.numMembers)
    await page.waitForTimeout(500)

    // Category: Normal
    await selectOption(page, 'select#Category, select[name="Category"]', FORM_VALUES.category)
    await page.waitForTimeout(500)

    // ── Formu gönder ─────────────────────────────────────────────
    await page.locator('button[type="submit"]:has-text("Search"), button:has-text("Book"), input[type="submit"]').first().click()
    await page.waitForURL('**', { waitUntil: 'networkidle', timeout: 45_000 })

    // ── Slot yok mu? ──────────────────────────────────────────────
    const noSlot = page.locator(
      'text=/no.*appointment.*available/i, text=/randevu.*bulunmamaktadır/i, text=/no.*slot/i',
    )
    if (await noSlot.count() > 0) {
      await closeSession(session.id, 'no_slots')
      await sendMessage(CHAT_ID, '😔 Şu an uygun randevu tarihi yok. İşlem kapatıldı.')
      return
    }

    // ── Takvim screenshot ─────────────────────────────────────────
    const calBuffer = (await page.screenshot({ type: 'png' })) as Buffer
    const calFilename = `calendar_${Date.now()}.png`
    const calUrl = await uploadScreenshot(session.id, calBuffer, calFilename)

    const state = await captureState(ctx)
    await advanceSession(session.id, 'awaiting_date', state)

    await sendPhoto(
      CHAT_ID,
      calUrl,
      '📅 <b>Uygun randevu tarihleri:</b>\n\n' +
        'Hangi günü seçeyim?\n<b>GG-AA-YYYY</b> formatında yaz.\nÖrnek: <code>25-06-2026</code>',
    )
  } catch (err) {
    await closeSession(session.id, 'failed')
    await sendError(CHAT_ID, `Adım 2: ${(err as Error).message}`)
    throw err
  } finally {
    await browser.close()
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ADIM 3: Seçilen tarihe tıkla → final CAPTCHA screenshot → Telegram
// ─────────────────────────────────────────────────────────────────────────
export async function step3_selectDateAndCaptureFinalCaptcha(
  session: Session,
  dateStr: string,
): Promise<void> {
  const { browser, ctx } = await launchWithState(session.browser_state!)
  const page = await ctx.newPage()

  try {
    await page.goto(APPT_URL, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.waitForTimeout(1000)

    // Takvimde gün seç — "25-06-2026" → gün = "25"
    const [day, month, year] = dateStr.split('-')
    const isoDate = `${year}-${month}-${day}` // "2026-06-25"

    // Önce data-date attribute ile dene
    const byData = page.locator(`[data-date="${isoDate}"], [data-value="${isoDate}"]`)
    if (await byData.count() > 0) {
      await byData.first().click()
    } else {
      // Fallback: takvim td içindeki metin
      await page.locator(`td.available:has-text("${Number(day)}"), .day-cell:has-text("${Number(day)}")`).first().click()
    }

    await page.waitForTimeout(1500)

    // ── Final CAPTCHA popup ───────────────────────────────────────
    const captchaContainer = page.locator('img[src*="captcha" i], canvas.captcha, #captchaImg').first()
    await captchaContainer.waitFor({ state: 'visible', timeout: 15_000 })
    const captchaBuffer = (await captchaContainer.screenshot()) as Buffer

    const filename = `captcha_final_${Date.now()}.png`
    const publicUrl = await uploadScreenshot(session.id, captchaBuffer, filename)
    await saveCaptchaRecord(
      session.id,
      `screenshots/${session.id}/${filename}`,
      publicUrl,
      'final',
    )

    const state = await captureState(ctx)
    await advanceSession(session.id, 'awaiting_captcha_final', state, {
      selected_date: dateStr,
    })

    await sendPhoto(
      CHAT_ID,
      publicUrl,
      `✅ <b>${dateStr}</b> seçildi!\n🔐 Son doğrulama kodunu yazın:`,
    )
  } catch (err) {
    await closeSession(session.id, 'failed')
    await sendError(CHAT_ID, `Adım 3: ${(err as Error).message}`)
    throw err
  } finally {
    await browser.close()
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ADIM 4: Final CAPTCHA → Submit → Onay ekranı → Telegram
// ─────────────────────────────────────────────────────────────────────────
export async function step4_submitAndConfirm(
  session: Session,
  captchaCode: string,
): Promise<void> {
  const { browser, ctx } = await launchWithState(session.browser_state!)
  const page = await ctx.newPage()

  try {
    await page.waitForTimeout(500)

    // Final CAPTCHA input
    await page.locator('input[name*="CaptchaCode" i], input[id*="captcha" i], input.captcha-input').first().fill(captchaCode)

    // Submit
    await page.locator('button[type="submit"]:has-text("Book"), button:has-text("Confirm"), button:has-text("Submit"), input[type="submit"]').first().click()
    await page.waitForURL('**', { waitUntil: 'networkidle', timeout: 60_000 })

    // Hata kontrolü
    const errMsg = page.locator('.alert-danger:visible, .text-danger:visible, .validation-summary li:visible')
    if (await errMsg.count() > 0) {
      const txt = await errMsg.first().textContent()
      await sendError(CHAT_ID, `Submit hatası: ${txt?.trim()}`)
      await closeSession(session.id, 'failed')
      return
    }

    // Onay ekranı screenshot
    const confirmBuffer = (await page.screenshot({ type: 'png', fullPage: true })) as Buffer
    const confirmUrl = await uploadScreenshot(session.id, confirmBuffer, `confirmation_${Date.now()}.png`)

    await closeSession(session.id, 'completed')

    await sendPhoto(
      CHAT_ID,
      confirmUrl,
      `🎉 <b>Randevu alındı!</b>\n📅 Tarih: <b>${session.selected_date}</b>\nOnay belgesi yukarıdadır.`,
    )
  } catch (err) {
    await closeSession(session.id, 'failed')
    await sendError(CHAT_ID, `Adım 4: ${(err as Error).message}`)
    throw err
  } finally {
    await browser.close()
  }
}
