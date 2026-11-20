// ABOUTME: Проверяет обычную и служебную пробу Web независимо от внешних сервисов.
import assert from "node:assert/strict";
import test from "node:test";
import {GET, HEAD} from "../app/api/health/route.ts";

test("readiness exposes the same version and status on GET and HEAD", async () => {
  const normal = GET();
  const probe = HEAD();
  assert.deepEqual(await normal.json(), {ready: true, component: "web"});
  assert.equal(await probe.text(), "");
  for (const response of [normal, probe]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Brai-Web-Readiness"), "1");
    assert.equal(response.headers.get("Content-Type"), "application/json");
  }
});
