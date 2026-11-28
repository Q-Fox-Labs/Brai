-- ABOUTME: Вводит отдельную роль посетителя Welcome в постоянном реестре Auth.
-- ABOUTME: До одобрения профиль только зарезервирован и не может стать active.
ALTER TABLE brai_identity DROP CONSTRAINT IF EXISTS brai_identity_role_check;
ALTER TABLE brai_identity ADD CONSTRAINT brai_identity_role_check CHECK (
  role IN ('creator','admin','user','guest') OR
  (role='welcome' AND status IN ('provisioning','blocked') AND profile_id IS NOT NULL)
);
