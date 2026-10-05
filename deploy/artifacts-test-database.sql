-- ABOUTME: Создаёт только disposable DB и отдельные owner/runtime роли.
-- ABOUTME: Credentials применимы только к production-test стенду.
CREATE ROLE artifacts_owner LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-artifacts-owner';
CREATE ROLE artifacts_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-artifacts-app';
CREATE DATABASE brai_artifacts_test OWNER artifacts_owner;
REVOKE ALL ON DATABASE brai_artifacts_test FROM PUBLIC;
GRANT CONNECT ON DATABASE brai_artifacts_test TO artifacts_app;
\connect brai_artifacts_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
