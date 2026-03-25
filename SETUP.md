# MkcVisa Bot — Kurulum Rehberi

## 1. Ön Gereksinimler

- Node.js 20+
- Vercel CLI (`npm i -g vercel`)
- Supabase hesabı
- Telegram Bot Token ([@BotFather](https://t.me/BotFather) üzerinden)

---

## 2. Kurulum

```bash
cd MkcVisa
npm install
cp .env.example .env.local   # değerleri doldurun
```

---

## 3. Supabase Kurulumu

1. [Supabase Dashboard](https://supabase.com) → yeni proje oluşturun.
2. **SQL Editor** → `supabase/migrations/001_initial.sql` içeriğini yapıştırıp çalıştırın.
3. **Storage** → "New Bucket" → isim: `visa-bot` → **Private** seçin.
4. Storage > `visa-bot` > **Policies** → Şu policy'i ekleyin:

```sql
-- Service role her şeyi yapabilir
CREATE POLICY "service_role_all" ON storage.objects
  FOR ALL TO service_role USING (bucket_id = 'visa-bot');
```

5. **Project Settings → API** bölümünden şunları kopyalayın:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` secret → `SUPABASE_SERVICE_ROLE_KEY`

---

## 4. Telegram Bot Kurulumu

### Bot oluşturma
1. Telegram'da [@BotFather](https://t.me/BotFather) ile konuşun.
2. `/newbot` → isim ve kullanıcı adı belirleyin.
3. Verilen **Token**'i `TELEGRAM_BOT_TOKEN` env'e yazın.

### Chat ID alma
1. Botunuza bir mesaj gönderin.
2. Şu URL'i tarayıcıda açın:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. `result[0].message.chat.id` değerini `TELEGRAM_CHAT_ID` env'e yazın.

### Webhook kaydetme (Vercel'e deploy sonrası)
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-app.vercel.app/api/telegram-webhook"
```

---

## 5. Vercel Deployment

```bash
vercel login
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add TELEGRAM_BOT_TOKEN
vercel env add TELEGRAM_CHAT_ID
vercel env add BLS_EMAIL
vercel env add BLS_PASSWORD
vercel env add CRON_SECRET        # rastgele bir string, örn: openssl rand -hex 16
vercel env add BLS_BASE_URL       # https://blsspain-global.com

vercel deploy --prod
```

---

## 6. Manuel Test

```bash
# Süreci elle başlat (CRON_SECRET değerinizi girin)
curl "https://your-app.vercel.app/api/start-booking?secret=CRON_SECRET"
```

---

## 7. Cron Job

`vercel.json`'daki schedule (`0 9 * * 1-5`) her Pazartesi–Cuma 09:00 UTC'de
`/api/start-booking` endpoint'ini otomatik çağırır.
Vercel **Pro** plan gereklidir. Hobby'de cron çalışmaz — manuel tetikleyin.

---

## 8. Selector Doğrulama (Önemli!)

`services/browser.ts` içindeki `TODO` yorumlarını takip edin.
BLS Spain sitesini DevTools ile açıp şu elementleri doğrulayın:

| Alan | Kontrol Edilecek |
|---|---|
| Email input | `input[name="email"]` |
| Password input | `input[type="password"]` |
| CAPTCHA resmi | `img.captcha-img` veya benzeri |
| CAPTCHA text input | `input[name="captcha"]` |
| Juristification dropdown | `select[name="juristification"]` |
| Location dropdown | `select[name="location"]` |
| Visa Type dropdown | `select[name="visaType"]` |
| Family radyo butonu | `input[type="radio"][value="Family"]` |
| Members dropdown | `select[name="numMembers"]` |
| Category dropdown | `select[name="category"]` |
| Submit butonu | `button[type="submit"]` |
| Takvim hücreleri | `.calendar td` veya `[data-date]` |

---

## 9. Bot Komutları

| Komut | Açıklama |
|---|---|
| `/start` | Botu karşıla |
| `/status` | Aktif oturum durumunu göster |
| `/cancel` | Aktif oturumu iptal et |
| *(CAPTCHA kodu)* | Login/final CAPTCHA yanıtı |
| `GG-AA-YYYY` | Randevu tarihi seçimi |

---

## 10. Akış Özeti

```
Cron / Manuel Tetik
        │
        ▼
[Adım 1] site → login ekranı → CAPTCHA screenshot → Supabase kayıt → Telegram
        │
   Kullanıcı kodu gönderir
        │
        ▼
[Adım 2] login → form doldur → takvim screenshot → Telegram
        │
   Kullanıcı tarih gönderir (GG-AA-YYYY)
        │
        ▼
[Adım 3] tarihe tıkla → final CAPTCHA screenshot → Telegram
        │
   Kullanıcı son kodu gönderir
        │
        ▼
[Adım 4] submit → onay ekranı → Telegram 🎉
```
