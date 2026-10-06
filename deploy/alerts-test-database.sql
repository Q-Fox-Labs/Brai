-- ABOUTME: Создаёт только синтетическую БД alerts в одноразовом контейнере.
-- ABOUTME: Прикладную схему создаёт отдельная миграция продукта.
CREATE ROLE alerts_test_owner LOGIN PASSWORD 'alerts-test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE alerts_test_app LOGIN PASSWORD 'alerts-test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE alerts_test_web LOGIN PASSWORD 'alerts-test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE brai_alerts_test OWNER alerts_test_owner;
REVOKE ALL ON DATABASE brai_alerts_test FROM PUBLIC;
GRANT CONNECT ON DATABASE brai_alerts_test TO alerts_test_app, alerts_test_web;
\connect brai_alerts_test
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
