// ABOUTME: Проверяет email OTP Auth на настоящем PostgreSQL и через NATS endpoints.
// ABOUTME: Ограничен localhost fixture и синтетическими linked identities.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createAuth } from "../../dist/auth.js";
import { adminAction } from "../../dist/admin.js";
import { lifecycleWorker } from "../../dist/lifecycle.js";
import { runNats } from "../../dist/nats.js";
import { captureEmailGrant, permitsEmailCode } from "../../dist/web-access.js";

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
const deliveries = [];
const cfg = { identityMode: "email", origin, trustedOrigins: [origin], secret,
  resendKey: "re_fixture", emailFrom: "Fixture <test@example.com>" };
let auth, transport, endpoints;
const migrate = async () => run(process.execPath, [fileURLToPath(new URL("../../dist/migrate.js", import.meta.url))], {
  env: { ...process.env, AUTH_DATABASE_URL: ownerURL, AUTH_OWNER_ROLE: "auth_owner", AUTH_APP_ROLE: "auth_app",
    AUTH_SECRET: secret, AUTH_ORIGIN: origin, AUTH_EMAIL_FROM: cfg.emailFrom, AUTH_IDENTITY_MODE: "email" },
  timeout: 30000
});
const seed = async (role, status = "active") => {
  const id = randomUUID(), email = "roles-" + randomUUID() + "@fixture.example";
  await owner.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',
    [id, "Email role fixture", email]);
  await owner.query("INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,$4,$5)",
    [id, String(Date.now()) + String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0"), randomUUID(), role, status]);
  return { id, email };
};
const startTransport = async handler => {
  if (transport) await transport.stop();
  endpoints = new Map();
  const service = { addEndpoint(_name, options) { endpoints.set(options.subject, options.handler); }, async stop() {} };
  transport = await runNats({ services: { async add() { return service; } } }, cfg, handler, app);
};
const request = (operation, body, cookie = "") => new Promise((resolve, reject) => {
  const endpoint = endpoints.get("brai.auth.v1." + operation);
  if (!endpoint) return reject(new Error("Missing fixture endpoint " + operation));
  endpoint(null, {
    data: Buffer.from(JSON.stringify({ headers: { origin, ...(cookie ? { cookie } : {}) }, body })),
    respond: value => resolve(JSON.parse(value.toString("utf8"))),
    respondError: (code, message) => resolve({ error: code, message })
  });
});
const roleChange = async (actorId, userId, role) => {
  const changed = await adminAction(app, secret, actorId, "role-set", { userId, role, requestId: randomUUID() });
  assert.equal(changed.status, 200);
  const operation = (await lifecycleWorker(app, "claim", {
    workerId: "email-role-fixture", rolePolicyVersion: 1
  })).operation;
  assert.equal(operation?.userId, userId);
  assert.equal((await lifecycleWorker(app, "complete", {
    operationId: operation.id, leaseToken: operation.leaseToken, success: true
  })).accepted, true);
};
const sessionCookie = response => response.setCookies.map(value => value.split(";")[0]).join("; ");
after(async () => {
  if (transport) await transport.stop();
  await Promise.all([app.end(), owner.end()]);
});

test("linked user OTP is stamped with its captured generation and creates a live session", async () => {
  const ids = [];
  try {
    await migrate();
    const creator = await seed("creator");
    const user = await seed("user");
    ids.push(creator.id, user.id);
    deliveries.length = 0;
    auth = createAuth(cfg, app, async (email, otp) => { deliveries.push({ email, otp }); });
    await startTransport(auth.handler);

    const sent = await request("send-code", { email: user.email });
    assert.equal(sent.status, 200);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].email, user.email);
    const grant = await captureEmailGrant(app, user.email);
    assert.equal(grant.allowed, true);
    assert.equal(grant.userId, user.id);
    assert.equal(await permitsEmailCode(app, user.email, deliveries[0].otp, grant), true);
    const stamped = (await owner.query("SELECT brai_generation FROM verification WHERE identifier=$1",
      ["sign-in-otp-" + user.email.toLowerCase()])).rows[0];
    assert.equal(stamped.brai_generation, grant.generation);

    const verified = await request("verify-code", { email: user.email, otp: deliveries[0].otp });
    assert.equal(verified.status, 200);
    const cookie = sessionCookie(verified);
    assert.match(cookie, /session_token/);
    const session = (await owner.query('SELECT brai_generation FROM "session" WHERE "userId"=$1', [user.id])).rows[0];
    assert.equal(session.brai_generation, grant.generation);
    const currentGrant = await captureEmailGrant(app, user.email);
    assert.equal(await permitsEmailCode(app, user.email, deliveries[0].otp, currentGrant), false);
  } finally {
    if (ids.length) await owner.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [ids]);
  }
});

test("guest grant is denied and an OTP from before guest→user never becomes valid again", async () => {
  const ids = [];
  try {
    await migrate();
    const creator = await seed("creator");
    const user = await seed("user");
    const guest = await seed("guest");
    ids.push(creator.id, user.id, guest.id);
    deliveries.length = 0;
    auth = createAuth(cfg, app, async (email, otp) => { deliveries.push({ email, otp }); });
    await startTransport(auth.handler);

    const denied = await request("send-code", { email: guest.email });
    assert.equal(denied.status, 403);
    assert.equal(deliveries.length, 0);

    const sent = await request("send-code", { email: user.email });
    assert.equal(sent.status, 200);
    const oldOtp = deliveries.find(item => item.email === user.email).otp;
    await roleChange(creator.id, user.id, "guest");
    await roleChange(creator.id, user.id, "user");
    const current = await captureEmailGrant(app, user.email);
    assert.equal(current.allowed, true);
    assert.ok(current.generation > 0);
    const replay = await request("verify-code", { email: user.email, otp: oldOtp });
    assert.notEqual(replay.status, 200);
    assert.equal((await owner.query('SELECT count(*) FROM "session" WHERE "userId"=$1', [user.id])).rows[0].count, "0");
    assert.equal((await owner.query("SELECT count(*) FROM verification WHERE identifier=$1",
      ["sign-in-otp-" + user.email.toLowerCase()])).rows[0].count, "0");
  } finally {
    if (ids.length) await owner.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [ids]);
  }
});

test("OTP request captured before downgrade cannot stamp or send after generation changes twice", async () => {
  const ids = [];
  try {
    await migrate();
    const creator = await seed("creator");
    const user = await seed("user");
    ids.push(creator.id, user.id);
    deliveries.length = 0;
    auth = createAuth(cfg, app, async (email, otp) => { deliveries.push({ email, otp }); });
    await startTransport(auth.handler);

    const context = await auth.$context;
    const original = context.internalAdapter.createVerificationValue.bind(context.internalAdapter);
    let transitioned = false;
    context.internalAdapter.createVerificationValue = async (...args) => {
      if (!transitioned) {
        transitioned = true;
        await roleChange(creator.id, user.id, "guest");
        await roleChange(creator.id, user.id, "user");
      }
      return original(...args);
    };
    const before = await captureEmailGrant(app, user.email);
    assert.equal(before.allowed, true);
    const sendCount = deliveries.length;
    const response = await request("send-code", { email: user.email });
    assert.equal(transitioned, true);
    assert.notEqual(response.status, 200);
    assert.equal(deliveries.length, sendCount);
    const afterGrant = await captureEmailGrant(app, user.email);
    assert.equal(afterGrant.allowed, true);
    assert.ok(afterGrant.generation > before.generation);
    const row = (await owner.query("SELECT brai_generation FROM verification WHERE identifier=$1",
      ["sign-in-otp-" + user.email.toLowerCase()])).rows[0];
    assert.notEqual(row?.brai_generation, afterGrant.generation);
    const sessions = await owner.query('SELECT count(*) FROM "session" WHERE "userId"=$1', [user.id]);
    assert.equal(sessions.rows[0].count, "0");
  } finally {
    if (ids.length) await owner.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [ids]);
  }
});

