-- ABOUTME: Создаёт только синтетическую БД и отдельные роли bug-hunt fixture.
-- ABOUTME: Публичные тестовые пароли не используются ни DEV, ни PROD.
CREATE ROLE bug_hunt_owner LOGIN PASSWORD 'fixture-owner' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE bug_hunt_app LOGIN PASSWORD 'fixture-app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE brai_bug_hunt_test OWNER bug_hunt_owner;
REVOKE CONNECT ON DATABASE brai_bug_hunt_test FROM PUBLIC;
GRANT CONNECT ON DATABASE brai_bug_hunt_test TO bug_hunt_owner,bug_hunt_app;
\connect brai_bug_hunt_test
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
