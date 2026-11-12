// ABOUTME: Проверяет отзыв credentials и гонки смены ролей Auth в PostgreSQL.
// ABOUTME: Использует только localhost fixture, реальные транзакции и синтетические данные.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createAuth } from "../../dist/auth.js";
import { adminAction } from "../../dist/admin.js";
import { lifecycleWorker } from "../../dist/lifecycle.js";
import { issueCode, consumeCode } from "../../dist/login-code.js";
import { sessionIdentity } from "../../dist/v2.js";
import { bridge } from "../../dist/bridge.js";

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
const hub = "https://fixture.example";
const preview = "https://preview.fixture.example";
const telegram = () => String(Date.now()) + String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
const cleanup = async ids => {
  if (ids.length) await owner.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [ids]);
};
const migrate = async () => run(process.execPath, [fileURLToPath(new URL("../../dist/migrate.js", import.meta.url))], {
  env: { ...process.env, AUTH_DATABASE_URL: ownerURL, AUTH_OWNER_ROLE: "auth_owner", AUTH_APP_ROLE: "auth_app",
    AUTH_SECRET: secret, AUTH_ORIGIN: hub, AUTH_EMAIL_FROM: "Fixture <test@example.com>", AUTH_IDENTITY_MODE: "telegram" },
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

test("A09 guest не получает код и теряет прежние код, сессию и SSO-билет", async () => {
  const ids = [];
  try {
    await migrate();
    const creator = await seed({ role: "creator", name: "Credential manager fixture" });
    const user = await seed({ role: "user", name: "Credential user fixture" });
    ids.push(creator.id, user.id);
    const cfg = { identityMode: "telegram", origin: hub, trustedOrigins: [hub, preview],
      ssoHubOrigin: hub, ssoPreviewOrigins: [preview], secret };
    const auth = createAuth(cfg, app);
    const loginCode = await issueCode(app, secret, user.channel);
    assert.ok(loginCode);
    const signed = await auth.handler(new Request(hub + "/api/auth/brai/telegram-redeem", {
      method: "POST",
      headers: { origin: hub, "content-type": "application/json", "x-forwarded-for": "192.0.2.41" },
      body: JSON.stringify({ code: loginCode.code })
    }));
    assert.equal(signed.status, 200);
    const cookie = signed.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    assert.equal((await sessionIdentity(app, cfg, auth.handler, new Headers({ cookie }))).id, user.id);
    const pendingCode = await issueCode(app, secret, user.channel);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const issued = await bridge("sso-issue", { headers: { origin: hub, cookie },
      body: { targetOrigin: preview, challenge } }, hub, auth.handler, cfg);
    assert.equal(issued.status, 200);

    const changed = await adminAction(app, secret, creator.id, "role-set",
      { userId: user.id, role: "guest", requestId: randomUUID() });
    assert.equal(changed.status, 200);
    assert.equal((await owner.query('SELECT count(*) FROM "session" WHERE "userId"=$1', [user.id])).rows[0].count, "0");
    assert.equal((await owner.query("SELECT count(*) FROM brai_login_code WHERE user_id=$1", [user.id])).rows[0].count, "0");
    assert.equal(await consumeCode(app, secret, pendingCode.code, "old-role-code"), null);
    const operation = (await lifecycleWorker(app, "claim", { workerId: "role-revocation-fixture", rolePolicyVersion: 1 })).operation;
    assert.equal(operation.userId, user.id);
    assert.equal((await lifecycleWorker(app, "complete", { operationId: operation.id, leaseToken: operation.leaseToken, success: true })).accepted, true);
    assert.equal((await owner.query("SELECT role,status FROM brai_identity WHERE user_id=$1", [user.id])).rows[0].role, "guest");
    assert.equal(await issueCode(app, secret, user.channel), null);
    assert.equal(await sessionIdentity(app, cfg, auth.handler, new Headers({ cookie })), null);
    const redeemed = await bridge("sso-redeem", { headers: { origin: preview },
      body: { ticket: issued.body.ticket, verifier, targetOrigin: preview } }, hub, auth.handler, cfg);
    assert.equal(redeemed.status, 400);
    assert.deepEqual(redeemed.setCookies, []);
  } finally {
    await cleanup(ids);
  }
});

test("A11 guest → user применяет профиль без смены userId/profileId и не оживляет credentials", async () => {
  const ids = [];
  try {
    await migrate();
    const creator = await seed({ role: "creator", name: "Upgrade manager fixture" });
    const guest = await seed({ role: "guest", name: "Preserved guest fixture" });
    ids.push(creator.id, guest.id);
    const previous = (await owner.query("SELECT u.id,u.name,i.telegram_id,i.profile_id FROM \"user\" u JOIN brai_identity i ON i.user_id=u.id WHERE u.id=$1", [guest.id])).rows[0];
    assert.equal(await issueCode(app, secret, guest.channel), null);
    const code = "0123456789AB";
    await owner.query("INSERT INTO brai_login_code(user_id,digest,expires_at) VALUES($1,$2,now()+interval '2 minutes')",
      [guest.id, createHmac("sha256", secret).update("code:" + code).digest("hex")]);
    const sessionId = randomUUID();
    await owner.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt",brai_generation) VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now(),0)',
      [sessionId, randomUUID(), guest.id]);

    const result = await adminAction(app, secret, creator.id, "role-set",
      { userId: guest.id, role: "user", requestId: randomUUID() });
    assert.equal(result.status, 200);
    assert.equal((await owner.query("SELECT role,status FROM brai_identity WHERE user_id=$1", [guest.id])).rows[0].role, "user");
    assert.equal((await owner.query("SELECT count(*) FROM brai_login_code WHERE user_id=$1", [guest.id])).rows[0].count, "0");
    assert.equal((await owner.query('SELECT count(*) FROM "session" WHERE id=$1', [sessionId])).rows[0].count, "0");
    const operation = (await lifecycleWorker(app, "claim", { workerId: "role-upgrade-fixture", rolePolicyVersion: 1 })).operation;
    assert.equal(operation.userId, guest.id);
    assert.equal((await lifecycleWorker(app, "complete", { operationId: operation.id, leaseToken: operation.leaseToken, success: true })).accepted, true);
    const current = (await owner.query("SELECT u.id,u.name,i.telegram_id,i.profile_id,i.role,i.status FROM \"user\" u JOIN brai_identity i ON i.user_id=u.id WHERE u.id=$1", [guest.id])).rows[0];
    assert.deepEqual([current.id, current.name, current.telegram_id, current.profile_id],
      [previous.id, previous.name, previous.telegram_id, previous.profile_id]);
    assert.deepEqual([current.role, current.status], ["user", "active"]);
    assert.equal(await consumeCode(app, secret, code, "old-guest-code"), null);
    assert.ok(await issueCode(app, secret, guest.channel));
  } finally {
    await cleanup(ids);
  }
});

test("A13/A14 role-set replay, parameter conflict and stale lease cannot restore an older role", async () => {
  const ids = [];
  try {
    await migrate();
    const creator = await seed({ role: "creator", name: "Role operation manager fixture" });
    const user = await seed({ role: "user", name: "Role operation fixture" });
    ids.push(creator.id, user.id);
    const requestId = randomUUID();
    const first = await adminAction(app, secret, creator.id, "role-set", { userId: user.id, role: "guest", requestId });
    assert.equal(first.status, 200);
    const generation = first.body.operation.generation;
    const replay = await adminAction(app, secret, creator.id, "role-set", { userId: user.id, role: "guest", requestId });
    assert.equal(replay.body.operation.id, first.body.operation.id);
    assert.equal(replay.body.operation.generation, generation);
    assert.equal((await adminAction(app, secret, creator.id, "role-set", { userId: user.id, role: "user", requestId })).body.code, "REQUEST_CONFLICT");

    const staleLease = (await lifecycleWorker(app, "claim", { workerId: "old-role-worker", rolePolicyVersion: 1 })).operation;
    assert.equal(staleLease.id, first.body.operation.id);
    const next = await adminAction(app, secret, creator.id, "role-set",
      { userId: user.id, role: "user", requestId: randomUUID() });
    assert.equal(next.status, 200);
    assert.ok(next.body.operation.generation > generation);
    assert.equal((await adminAction(app, secret, creator.id, "role-set", { userId: user.id, role: "guest", requestId })).body.operation.state, "cancelled");
    assert.equal((await lifecycleWorker(app, "complete", { operationId: staleLease.id, leaseToken: staleLease.leaseToken, success: true })).accepted, false);
    const identity = (await owner.query("SELECT role,status,lifecycle_generation,applied_generation FROM brai_identity WHERE user_id=$1", [user.id])).rows[0];
    assert.deepEqual([identity.role, identity.status], ["user", "provisioning"]);
    assert.notEqual(identity.applied_generation, identity.lifecycle_generation);
    const currentLease = (await lifecycleWorker(app, "claim", { workerId: "current-role-worker", rolePolicyVersion: 1 })).operation;
    assert.equal(currentLease.id, next.body.operation.id);
    assert.equal((await lifecycleWorker(app, "complete", { operationId: currentLease.id, leaseToken: currentLease.leaseToken, success: true })).accepted, true);
    assert.equal((await owner.query("SELECT role FROM brai_identity WHERE user_id=$1", [user.id])).rows[0].role, "user");
  } finally {
    await cleanup(ids);
  }
});

