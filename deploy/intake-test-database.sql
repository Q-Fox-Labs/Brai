-- ABOUTME: Создаёт только синтетическую БД и две ограниченные роли fixture.
-- ABOUTME: Публичные пароли не используются вне disposable тестовых контейнеров.
CREATE ROLE intake_test_owner LOGIN PASSWORD 'intake-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE intake_test LOGIN PASSWORD 'intake-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE brai_intake_test OWNER intake_test_owner;
REVOKE ALL ON DATABASE brai_intake_test FROM PUBLIC;
GRANT CONNECT ON DATABASE brai_intake_test TO intake_test;
CREATE ROLE intake_artifacts_test_owner LOGIN PASSWORD 'intake-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE intake_artifacts_test_app LOGIN PASSWORD 'intake-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE intake_history_test_owner LOGIN PASSWORD 'intake-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE intake_history_test_app LOGIN PASSWORD 'intake-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE intake_history_test_web LOGIN PASSWORD 'intake-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE brai_intake_artifacts_test OWNER intake_artifacts_test_owner;
CREATE DATABASE brai_intake_history_test OWNER intake_history_test_owner;
CREATE ROLE channels_test_owner LOGIN PASSWORD 'intake-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE channels_test LOGIN PASSWORD 'intake-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE brai_channels_test OWNER channels_test_owner;
REVOKE ALL ON DATABASE brai_channels_test FROM PUBLIC;
GRANT CONNECT ON DATABASE brai_channels_test TO channels_test;
CREATE ROLE contacts_test_owner LOGIN PASSWORD 'intake-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE contacts_test LOGIN PASSWORD 'intake-test' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE brai_contacts_test OWNER contacts_test_owner;
REVOKE ALL ON DATABASE brai_contacts_test FROM PUBLIC;
GRANT CONNECT ON DATABASE brai_contacts_test TO contacts_test;
