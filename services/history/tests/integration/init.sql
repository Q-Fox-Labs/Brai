-- ABOUTME: Создаёт изолированную PostgreSQL-БД и роли проверок истории.
-- ABOUTME: Все пароли синтетические; файл разрешён только для временного тестового стенда.
CREATE ROLE history_owner LOGIN PASSWORD 'fixture-owner' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE history_app LOGIN PASSWORD 'fixture-app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE history_web LOGIN PASSWORD 'fixture-web' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE history_actor LOGIN PASSWORD 'fixture-actor' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE DATABASE brai_history_test OWNER history_owner;
REVOKE CONNECT ON DATABASE brai_history_test FROM PUBLIC;
GRANT CONNECT ON DATABASE brai_history_test TO history_owner, history_app, history_web;
REVOKE ALL ON DATABASE brai_history_test FROM history_actor;
\connect brai_history_test
REVOKE CREATE ON SCHEMA public FROM PUBLIC, history_app, history_web, history_actor;
CREATE SCHEMA foreign_fixture AUTHORIZATION postgres;
CREATE TABLE foreign_fixture.foreign_data(id integer PRIMARY KEY);
INSERT INTO foreign_fixture.foreign_data VALUES (1);
REVOKE ALL ON SCHEMA foreign_fixture FROM PUBLIC, history_owner, history_app, history_web, history_actor;
REVOKE ALL ON TABLE foreign_fixture.foreign_data FROM PUBLIC, history_owner, history_app, history_web, history_actor;
