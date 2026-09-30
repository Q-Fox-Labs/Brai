-- ABOUTME: Создаёт отдельную auth БД и роли только disposable production fixture.
-- ABOUTME: Все пароли синтетические; файл не используется production deployment.
CREATE ROLE brai_auth_owner LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-auth-owner';
CREATE ROLE brai_auth_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-auth-app';
CREATE DATABASE brai_auth_test OWNER brai_auth_owner;
REVOKE ALL ON DATABASE brai_auth_test FROM PUBLIC;
GRANT CONNECT ON DATABASE brai_auth_test TO brai_auth_app;
\connect brai_auth_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
