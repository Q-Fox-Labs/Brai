// ABOUTME: Проверяет миграцию, полномочия управляющих и приглашения на настоящем PostgreSQL.
// ABOUTME: Использует только выделенную localhost fixture и синтетические аккаунты.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { migrateIdentity } from "../../dist/identity-schema.js";
import { adminAction } from "../../dist/admin.js";
import { redeemInvite } from "../../dist/identity.js";

const fixtureURL = name => {
  const value = process.env[name];
  if (!value) throw new Error("Explicit " + name + " required");
  const url = new URL(value);
  if (url.hostname !== "127.0.0.1" || url.port !== "15459" || url.pathname !== "/brai_auth_test") {
    throw new Error("Refusing non-fixture database");
  }
  return value;
};
const ownerURL = fixtureURL("AUTH_TEST_OWNER_URL");
const appURL = fixtureURL("AUTH_TEST_APP_URL");
const owner = new Pool({ connectionString: ownerURL });
const app = new Pool({ connectionString: appURL });
const run = promisify(execFile);
const secret = "fixture-auth-secret-32-characters-long";
const origin = "https://fixture.example";
const telegram = () => String(Date.now()) + String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
const cleanup = async ids => {
  if (!ids.length) return;
  await owner.query("DELETE FROM brai_invite WHERE created_by=ANY($1::text[]) OR consumed_by=ANY($1::text[])", [ids]);
  await owner.query("DELETE FROM brai_owner_bootstrap WHERE user_id=ANY($1::text[])", [ids]);
  await owner.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [ids]);
};
const migrate = async () => run(process.execPath, [fileURLToPath(new URL("../../dist/migrate.js", import.meta.url))], {
  env: { ...process.env, AUTH_DATABASE_URL: ownerURL, AUTH_OWNER_ROLE: "auth_owner", AUTH_APP_ROLE: "auth_app",
    AUTH_SECRET: secret, AUTH_ORIGIN: origin, AUTH_EMAIL_FROM: "Fixture <test@example.com>", AUTH_IDENTITY_MODE: "telegram" },
  timeout: 30000
});
const seed = async ({ role = "user", status = "active", name = "Role fixture" } = {}) => {
  const id = randomUUID(), channel = telegram(), profileId = randomUUID();
  await owner.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',
    [id, name, id + "@fixture.example"]);
  await owner.query("INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,$4,$5)",
    [id, channel, profileId, role, status]);
  return { id, channel, profileId };
};
after(async () => { await Promise.all([app.end(), owner.end()]); });

test("A01 повторная миграция сохраняет старые admin/user роли и идентификаторы", async () => {
  const ids = [];
  try {
    await migrate();
    await owner.query("ALTER TABLE brai_identity DROP CONSTRAINT IF EXISTS brai_identity_role_check");
    await owner.query("ALTER TABLE brai_identity ADD CONSTRAINT brai_identity_role_check CHECK(role IN ('admin','user')) NOT VALID");
    const admin = await seed({ role: "admin" });
    ids.push(admin.id);
    const user = await seed({ role: "user" });
    ids.push(user.id);
    const before = await owner.query("SELECT user_id,telegram_id,profile_id,role FROM brai_identity WHERE user_id=ANY($1::text[]) ORDER BY user_id", [ids]);
    await migrateIdentity(owner);
    await migrateIdentity(owner);
    assert.deepEqual(
      (await owner.query("SELECT user_id,telegram_id,profile_id,role FROM brai_identity WHERE user_id=ANY($1::text[]) ORDER BY user_id", [ids])).rows,
      before.rows
    );
    await owner.query("UPDATE brai_identity SET role='guest' WHERE user_id=$1", [user.id]);
    await migrateIdentity(owner);
    assert.equal((await owner.query("SELECT role FROM brai_identity WHERE user_id=$1", [user.id])).rows[0].role, "guest");
  } finally {
    await migrateIdentity(owner);
    await cleanup(ids);
  }
});

test("A03/A04 creator сохраняет управление; admin защищён от назначения и изменения creator", async () => {
  const ids = [];
  let temp;
  try {
    await migrate();
    const soleAdmin = await seed({ role: "admin", name: "Sole admin fixture" });
    ids.push(soleAdmin.id);
    await owner.query("INSERT INTO brai_owner_bootstrap(singleton,user_id) VALUES(true,$1)", [soleAdmin.id]);
    const generation = (await owner.query("SELECT lifecycle_generation FROM brai_identity WHERE user_id=$1", [soleAdmin.id])).rows[0].lifecycle_generation;
    const sessionId = randomUUID();
    await owner.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt",brai_generation) VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now(),$4)',
      [sessionId, randomUUID(), soleAdmin.id, generation]);

    temp = await mkdtemp(join(tmpdir(), "auth-role-bootstrap-"));
    const bootstrapFile = join(temp, "bootstrap.json");
    await writeFile(bootstrapFile, JSON.stringify({ userId: soleAdmin.id, telegramId: soleAdmin.channel,
      profileId: soleAdmin.profileId, role: "creator", name: "Sole admin fixture" }), { mode: 0o600 });
    await run(process.execPath, [fileURLToPath(new URL("../../dist/bootstrap.js", import.meta.url))], {
      env: { ...process.env, AUTH_DATABASE_URL: ownerURL, AUTH_OWNER_ROLE: "auth_owner", AUTH_BOOTSTRAP_FILE: bootstrapFile },
      timeout: 30000
    });
    const converted = (await owner.query('SELECT i.role,i.status,i.lifecycle_generation,s.brai_generation FROM brai_identity i JOIN "session" s ON s."userId"=i.user_id AND s.id=$2 WHERE i.user_id=$1',
      [soleAdmin.id, sessionId])).rows[0];
    assert.deepEqual(converted, { role: "creator", status: "active", lifecycle_generation: 1, brai_generation: 1 });
    assert.equal((await adminAction(app, secret, soleAdmin.id, "users-list", {})).status, 200);
    assert.equal((await adminAction(app, secret, soleAdmin.id, "invite-create", { role: "guest" })).status, 200);

    const admin = await seed({ role: "admin", name: "Admin fixture" });
    const person = await seed({ name: "Managed fixture" });
    const blocked = await seed({ role: "user", status: "blocked", name: "Restored fixture" });
    const protectedCreator = await seed({ role: "creator", name: "Protected creator fixture" });
    const blockedCreator = await seed({ role: "creator", status: "blocked", name: "Blocked creator fixture" });
    ids.push(admin.id, person.id, blocked.id, protectedCreator.id, blockedCreator.id);
    const action = (op, body) => adminAction(app, secret, soleAdmin.id, op, body);
    const addRequest = randomUUID();
    const added = await action("users-add", { requestId: addRequest, telegramId: telegram(), role: "guest" });
    ids.push(added.body.user.id);
    assert.equal(added.status, 200);
    assert.equal(added.body.user.role, "guest");
    assert.equal((await action("users-operation-get", { requestId: addRequest })).body.operation.id, added.body.operation.id);
    assert.ok((await action("users-list", {})).body.users.some(user => user.id === person.id));
    assert.equal((await action("users-get", { userId: person.id })).body.user.id, person.id);
    assert.equal((await action("role-set", { userId: person.id, role: "guest", requestId: randomUUID() })).status, 200);
    assert.equal((await action("status-set", { userId: person.id, status: "blocked", requestId: randomUUID() })).status, 200);
    assert.equal((await action("users-revoke", { userId: blocked.id, requestId: randomUUID() })).status, 200);
    assert.equal((await action("users-add", { telegramId: blocked.channel, role: "user", requestId: randomUUID() })).body.user.id, blocked.id);
    const sessionTarget = await seed();
    ids.push(sessionTarget.id);
    await owner.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',
      [randomUUID(), randomUUID(), sessionTarget.id]);
    assert.equal((await action("sessions-revoke", { userId: sessionTarget.id })).status, 200);
    const invite = (await action("invite-create", { role: "guest" })).body.invite;
    assert.equal((await action("invite-list", {})).body.invites.some(item => item.id === invite.id), true);
    assert.equal((await action("invite-revoke", { inviteId: invite.id })).status, 200);
    assert.equal((await action("admin-audit", { userId: person.id, action: "memory.read" })).status, 200);

    const deny = (op, body) => adminAction(app, secret, admin.id, op, body);
    assert.equal((await deny("role-set", { userId: person.id, role: "creator", requestId: randomUUID() })).status, 403);
    for (const target of [protectedCreator, blockedCreator]) {
      assert.equal((await deny("role-set", { userId: target.id, role: "user", requestId: randomUUID() })).status, 403);
      assert.equal((await deny("status-set", { userId: target.id, status: "blocked", requestId: randomUUID() })).status, 403);
      assert.equal((await deny("users-revoke", { userId: target.id, requestId: randomUUID() })).status, 403);
      assert.equal((await deny("sessions-revoke", { userId: target.id })).status, 403);
      assert.equal((await deny("users-add", { telegramId: target.channel, role: "guest", requestId: randomUUID() })).status, 403);
    }
    assert.equal((await owner.query("SELECT role,status FROM brai_identity WHERE user_id=$1", [protectedCreator.id])).rows[0].role, "creator");
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
    await cleanup(ids);
  }
});

test("A05 приглашение хранит user/guest, а replay не меняет принятое решение Auth", async () => {
  const ids = [];
  try {
    await migrate();
    const creator = await seed({ role: "creator", name: "Invite creator fixture" });
    ids.push(creator.id);
    const action = (op, body) => adminAction(app, secret, creator.id, op, body);
    const defaultInvite = (await action("invite-create", {})).body.invite;
    const guestInvite = (await action("invite-create", { role: "guest" })).body.invite;
    assert.deepEqual((await owner.query("SELECT id,role FROM brai_invite WHERE id=ANY($1::text[]) ORDER BY id",
      [[defaultInvite.id, guestInvite.id]])).rows.map(row => row.role).sort(), ["guest", "user"]);
    const firstChannel = telegram(), secondChannel = telegram();
    const invitedUser = await redeemInvite(app, secret, firstChannel, defaultInvite.code);
    const invitedGuest = await redeemInvite(app, secret, secondChannel, guestInvite.code);
    ids.push(invitedUser.id, invitedGuest.id);
    assert.equal(invitedUser.role, "user");
    assert.equal(invitedGuest.role, "guest");
    const replayUser = await redeemInvite(app, secret, firstChannel, defaultInvite.code);
    assert.deepEqual([replayUser.id, replayUser.profileId, replayUser.role], [invitedUser.id, invitedUser.profileId, "user"]);
    assert.equal((await action("role-set", { userId: invitedGuest.id, role: "user", requestId: randomUUID() })).status, 200);
    const replayGuest = await redeemInvite(app, secret, secondChannel, guestInvite.code);
    assert.deepEqual([replayGuest.id, replayGuest.profileId, replayGuest.role], [invitedGuest.id, invitedGuest.profileId, "user"]);
  } finally {
    await cleanup(ids);
  }
});

