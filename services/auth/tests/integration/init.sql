-- ABOUTME: Создаёт временную auth БД с отдельными owner/app ролями.
-- ABOUTME: Фиктивные пароли предназначены только для изолированного стенда.
CREATE ROLE auth_owner LOGIN PASSWORD 'fixture-owner' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE auth_app LOGIN PASSWORD 'fixture-app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE brai_auth_test OWNER auth_owner;
\connect brai_auth_test
CREATE SCHEMA private_fixture;
CREATE TABLE private_fixture.foreign_data(id integer);
INSERT INTO private_fixture.foreign_data VALUES(1);
