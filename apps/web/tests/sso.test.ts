// ABOUTME: Проверяет границы конфигурации и привязку DEV SSO к браузеру.
// ABOUTME: Не обращается к сервису авторизации и не использует реальные сессии.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { continuation, newProof, proofCookie, readProof, ssoConfig, validVerifier } from "../server/sso.ts";

test("DEV SSO требует полную точную конфигурацию и выключен в PROD", () => {
 const names = ["BRAI_ENVIRONMENT", "WEB_ORIGIN", "WEB_SSO_HUB_ORIGIN", "WEB_SSO_PREVIEW_ORIGINS"] as const;
 const previous = names.map(name => process.env[name]);
 try {
  process.env.BRAI_ENVIRONMENT = "dev"; process.env.WEB_ORIGIN = "https://dev.brai.one";
  process.env.WEB_SSO_HUB_ORIGIN = "https://dev.brai.one"; process.env.WEB_SSO_PREVIEW_ORIGINS = "https://preview01.brai.one,https://preview02.brai.one";
  const config = ssoConfig(); assert.equal(config?.role, "hub");
  const { verifier, challenge } = newProof();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.ok(validVerifier(verifier));
  const params = new URLSearchParams({ targetOrigin: "https://preview01.brai.one", challenge });
  assert.ok(continuation(params, config));
  params.set("targetOrigin", "https://attacker.example"); assert.equal(continuation(params, config), null);
  params.set("targetOrigin", "https://preview01.brai.one"); params.append("challenge", challenge); assert.equal(continuation(params, config), null);
  assert.equal(readProof(`x=1; __Host-brai-sso=${verifier}`), verifier);
  assert.equal(readProof(`__Host-brai-sso=${verifier}; __Host-brai-sso=${verifier}`), undefined);
  assert.match(proofCookie(verifier, 600), /Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax/);
  process.env.BRAI_ENVIRONMENT = "prod"; assert.equal(ssoConfig(), null);
  process.env.BRAI_ENVIRONMENT = "dev"; delete process.env.WEB_SSO_PREVIEW_ORIGINS; assert.equal(ssoConfig(), null);
  process.env.WEB_SSO_PREVIEW_ORIGINS = "https://preview01.brai.one/path"; assert.equal(ssoConfig(), null);
 } finally { names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }); }
});
