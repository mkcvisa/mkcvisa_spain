-- ============================================================
-- MkcVisa Bot — Initial Schema
-- Supabase SQL Editor'da bu dosyayı çalıştırın.
-- ============================================================

-- sessions tablosu: Her kullanıcı akışının durumunu tutar
CREATE TABLE IF NOT EXISTS public.sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id       TEXT NOT NULL,
  current_step  TEXT NOT NULL DEFAULT 'start',
  -- Olası adımlar:
  --   'start'
  --   'awaiting_captcha_login'
  --   'filling_form'
  --   'awaiting_date'
  --   'awaiting_captcha_final'
  --   'completed'
  --   'failed'
  --   'no_slots'
  login_data    JSONB,          -- { email, password } — hassas; gerekirse şifreleyin
  form_data     JSONB,          -- form alanlarının kaydı
  selected_date TEXT,           -- kullanıcının seçtiği tarih "DD-MM-YYYY"
  browser_state JSONB,          -- Playwright storageState (cookies + localStorage)
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_chat_id_status_idx
  ON public.sessions (chat_id, status);

-- captchas tablosu: Captcha meta verisi
CREATE TABLE IF NOT EXISTS public.captchas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  storage_path  TEXT NOT NULL,   -- Supabase Storage içindeki yol
  public_url    TEXT,
  type          TEXT NOT NULL,   -- 'login' | 'final'
  solution      TEXT,            -- kullanıcının girdiği çözüm (log için)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- updated_at otomatik güncelleme trigger'ı
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sessions_updated_at ON public.sessions;
CREATE TRIGGER sessions_updated_at
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- Supabase Storage: "visa-bot" bucket oluşturun
-- Dashboard > Storage > New Bucket > "visa-bot" (private)
-- Aşağıdaki policy'i ekleyin:
-- ============================================================
-- INSERT INTO storage.buckets (id, name, public) VALUES ('visa-bot', 'visa-bot', false);

-- Service role ile her şeye erişim (API server-side kullanımı için)
-- Bu policy Supabase Dashboard > Storage > visa-bot > Policies bölümünden eklenebilir:
-- Allow service_role full access to visa-bot bucket
