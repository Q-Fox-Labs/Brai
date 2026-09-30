-- ABOUTME: Создаёт только временную изолированную тестовую БД и роли.
-- ABOUTME: Пароли фиктивные, не используются вне ephemeral контейнера.
CREATE ROLE timer_owner LOGIN PASSWORD 'fixture-owner' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE timer_app LOGIN PASSWORD 'fixture-app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE supabase_actor LOGIN PASSWORD 'fixture-actor' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE brai_timer_test OWNER timer_owner;
\connect brai_timer_test
CREATE SCHEMA private_fixture;
CREATE TABLE private_fixture.foreign_data(id integer);
INSERT INTO private_fixture.foreign_data VALUES(1);
