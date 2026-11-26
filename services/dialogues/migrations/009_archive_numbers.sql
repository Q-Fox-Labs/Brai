-- ABOUTME: Присваивает темам, беседам и сообщениям постоянные номера для коротких ссылок MCP.
-- ABOUTME: Номера заполняются и для существующей истории при обновлении.
ALTER TABLE dialogues_live.topics ADD COLUMN IF NOT EXISTS short_id bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE dialogues_live.dialogues ADD COLUMN IF NOT EXISTS short_id bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE dialogues_live.messages ADD COLUMN IF NOT EXISTS short_id bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS topics_short_id ON dialogues_live.topics(short_id);
CREATE UNIQUE INDEX IF NOT EXISTS dialogues_short_id ON dialogues_live.dialogues(short_id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_short_id ON dialogues_live.messages(short_id);
INSERT INTO dialogues_live.migrations(version) VALUES(9) ON CONFLICT DO NOTHING;
