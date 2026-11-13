// ABOUTME: Открывает существующую явную browser fixture на собственных live verification результатах.
// ABOUTME: Worker моделей не запускается, используютcя только synthetic Auth/DB/NATS и собственный Web.
import {writeFile,readFile,rm} from "node:fs/promises";
import assert from "node:assert/strict";
import {Pool} from "pg";
import {fixture} from "./fixture.mjs";
assert.match(fixture.run,/^[a-f0-9-]{36}$/);
let flow=JSON.parse(await readFile(new URL("../../../../tmp/bug-hunt-verification-live.json",import.meta.url),"utf8"));
{const db=new Pool({connectionString:fixture.appURL,max:1});try{const found=(await db.query("SELECT i.installation_id,i.owner_id,max(i.snapshot->'source'->>'commit') AS source_commit FROM verification_investigation i JOIN verification_result r ON r.investigation_id=i.id WHERE i.installation_id LIKE 'flow-%' AND i.owner_id LIKE 'synthetic-%' AND i.executor='codex_app_server' AND i.state='completed' GROUP BY i.installation_id,i.owner_id HAVING count(distinct r.payload->>'verdict')=3 ORDER BY max(i.registered_at) DESC LIMIT 1")).rows[0];assert.ok(found);assert.match(found.source_commit,/^[a-f0-9]{40}$/);flow={run:found.installation_id.slice(5),installationId:found.installation_id,userId:found.owner_id,sourceCommit:found.source_commit};await writeFile(new URL("../../../../tmp/bug-hunt-verification-live.json",import.meta.url),JSON.stringify(flow),{mode:0o600});}finally{await db.end();}}
assert.equal(flow.userId,"synthetic-"+flow.run);
const auth=new Pool({connectionString:fixture.authAppURL,max:1});try{const old=(await auth.query("SELECT telegram_id FROM brai_identity WHERE user_id=$1",[flow.userId])).rows[0];if(old)fixture.verificationTelegramId=old.telegram_id;}finally{await auth.end();}
await rm(new URL("../../../../tmp/bug-hunt-browser-"+fixture.run+".stop",import.meta.url),{force:true});
await writeFile(new URL("../../../../tmp/bug-hunt-browser.enable",import.meta.url),"explicit stage3 fixture");
await writeFile(new URL("../../../../tmp/bug-hunt-stage3-browser.enable",import.meta.url),"explicit stage3 fixture");
await import("./browser.test.mjs");
