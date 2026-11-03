-- ABOUTME: Создаёт таблицы сервиса целей.
-- ABOUTME: Связи владельцев ограничены составными внешними ключами.
CREATE TABLE goals.goals (
 owner_id text NOT NULL, id uuid NOT NULL,
 title text NOT NULL CHECK (length(trim(title)) > 0),
 meaning text NOT NULL CHECK (length(trim(meaning)) > 0),
 achievement text NOT NULL CHECK (length(trim(achievement)) > 0),
 due_on date, status text NOT NULL CHECK (status IN ('discussing','active','waiting','paused','achieved','cancelled')),
 next_step text, executor text, archived boolean NOT NULL DEFAULT false, deleted boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0), PRIMARY KEY(owner_id,id)
);
CREATE TABLE goals.focus (
 owner_id text PRIMARY KEY, id uuid NOT NULL, goal_id uuid, reason text, version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 FOREIGN KEY(owner_id,goal_id) REFERENCES goals.goals(owner_id,id),
 CHECK ((goal_id IS NULL AND reason IS NULL) OR (goal_id IS NOT NULL AND reason IS NOT NULL AND length(trim(reason)) > 0))
);
CREATE TABLE goals.entries (
 owner_id text NOT NULL, id uuid NOT NULL, goal_id uuid,
 kind text NOT NULL CHECK (kind IN ('result','thought')), content text NOT NULL CHECK (length(trim(content)) > 0),
 occurred_on date NOT NULL, pinned boolean NOT NULL DEFAULT false, deleted boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0), PRIMARY KEY(owner_id,id),
 FOREIGN KEY(owner_id,goal_id) REFERENCES goals.goals(owner_id,id)
);
CREATE TABLE goals.resources (
 owner_id text NOT NULL, id uuid NOT NULL, title text NOT NULL CHECK (length(trim(title)) > 0),
 purpose text, kind text NOT NULL CHECK (kind IN ('money','quantity','qualitative','liability')),
 category text CHECK (category IN ('own','borrowed','obligation')), state text NOT NULL,
 amount numeric CHECK (amount >= 0), unit text, currency text, expires_on date, deleted boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0), PRIMARY KEY(owner_id,id),
 CHECK ((kind = 'money' AND category IS NOT NULL AND category IN ('own','borrowed') AND currency IS NOT NULL AND unit IS NULL)
 OR (kind = 'liability' AND category IS NOT NULL AND category = 'obligation' AND currency IS NOT NULL AND unit IS NULL)
 OR (kind = 'quantity' AND category IS NULL AND currency IS NULL AND unit IS NOT NULL)
 OR (kind = 'qualitative' AND category IS NULL AND currency IS NULL AND unit IS NULL AND amount IS NULL))
);
CREATE TABLE goals.needs (
 owner_id text NOT NULL, id uuid NOT NULL, goal_id uuid NOT NULL,
 title text NOT NULL CHECK (length(trim(title)) > 0), kind text NOT NULL CHECK (kind IN ('money','quantity','qualitative')),
 amount numeric CHECK (amount >= 0), unit text, currency text, state text, deleted boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0), PRIMARY KEY(owner_id,id),
 FOREIGN KEY(owner_id,goal_id) REFERENCES goals.goals(owner_id,id),
 CHECK ((kind = 'money' AND currency IS NOT NULL AND unit IS NULL)
 OR (kind = 'quantity' AND unit IS NOT NULL AND currency IS NULL)
 OR (kind = 'qualitative' AND amount IS NULL AND unit IS NULL AND currency IS NULL))
);
CREATE TABLE goals.allocations (
 owner_id text NOT NULL, id uuid NOT NULL, need_id uuid NOT NULL, resource_id uuid NOT NULL,
 amount numeric CHECK (amount > 0), active boolean NOT NULL DEFAULT true, deleted boolean NOT NULL DEFAULT false, version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,need_id,resource_id),
 FOREIGN KEY(owner_id,need_id) REFERENCES goals.needs(owner_id,id),
 FOREIGN KEY(owner_id,resource_id) REFERENCES goals.resources(owner_id,id)
);
CREATE TABLE goals.history (
 owner_id text NOT NULL, id uuid NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL,
 version bigint NOT NULL, actor text NOT NULL, source text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
 previous jsonb, current jsonb NOT NULL, PRIMARY KEY(owner_id,id), UNIQUE(owner_id,entity_type,entity_id,version)
);
CREATE TABLE goals.requests (
 owner_id text NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL,
 response jsonb NOT NULL, PRIMARY KEY(owner_id,request_id)
);
CREATE TABLE goals.exchange_rates (
 currency text PRIMARY KEY, rate numeric NOT NULL CHECK(rate > 0), nominal numeric NOT NULL CHECK(nominal > 0),
 source text NOT NULL, effective_date date NOT NULL, fetched_at timestamptz NOT NULL, failed_at timestamptz
);
CREATE INDEX goals_entries_by_goal ON goals.entries(owner_id,goal_id,occurred_on DESC);
CREATE INDEX goals_history_by_entity ON goals.history(owner_id,entity_type,entity_id,version DESC);
CREATE INDEX goals_allocations_by_resource ON goals.allocations(owner_id,resource_id);
