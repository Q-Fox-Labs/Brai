-- ABOUTME: Хранит профиль справочной, решения по заявкам и устойчивую обработку Telegram.
-- ABOUTME: Идентичность принадлежит Auth, переписка записывается в личные Диалоги через MCP.
CREATE SCHEMA IF NOT EXISTS welcome;
CREATE TABLE IF NOT EXISTS welcome.settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  model text NOT NULL DEFAULT 'gpt-6-luna',
  reasoning text NOT NULL DEFAULT 'low',
  image_enabled boolean NOT NULL DEFAULT false,
  request_limit integer NOT NULL DEFAULT 50 CHECK(request_limit >= 0),
  image_limit integer NOT NULL DEFAULT 3 CHECK(image_limit >= 0)
);
INSERT INTO welcome.settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS welcome.visitors (
  user_id uuid PRIMARY KEY,
  profile_id uuid NOT NULL UNIQUE,
  telegram_id text NOT NULL UNIQUE CHECK(telegram_id ~ '^[1-9][0-9]{0,19}$'),
  name text NOT NULL,
  username text,
  avatar_file_id text,
  referral_code text NOT NULL UNIQUE,
  inviter_id uuid REFERENCES welcome.visitors(user_id),
  voice_enabled boolean NOT NULL DEFAULT true,
  questionnaire jsonb,
  CHECK(inviter_id IS DISTINCT FROM user_id)
);
CREATE TABLE IF NOT EXISTS welcome.turns (
  bot_id text NOT NULL,
  update_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES welcome.visitors(user_id),
  dialogue_id text NOT NULL,
  input_text text NOT NULL,
  input_receipt jsonb,
  result jsonb,
  request_at timestamptz,
  image_at timestamptz,
  image_request jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(bot_id,update_id)
);
CREATE INDEX IF NOT EXISTS welcome_turn_requests ON welcome.turns(user_id,request_at) WHERE request_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS welcome_turn_images ON welcome.turns(user_id,image_at) WHERE image_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS welcome.applications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES welcome.visitors(user_id),
  occupation text NOT NULL CHECK(btrim(occupation) <> ''),
  purpose text NOT NULL CHECK(btrim(purpose) <> ''),
  status text NOT NULL CHECK(status IN ('pending','approving','approved','rejected')),
  operation_id uuid,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS welcome_open_application ON welcome.applications(user_id) WHERE status IN ('pending','approving');
CREATE TABLE IF NOT EXISTS welcome.audit (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
