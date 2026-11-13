// ABOUTME: Выполняет принятый regression fixture против immutable модуля компонента.
// ABOUTME: Выбирает только фиксированный export evaluate, без argv, сети или generated scripts.
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
const spec=JSON.parse(readFileSync("/spec.json","utf8"));
if(!/^[a-z0-9-]{1,100}$/.test(spec.fixture_ref))throw Error("FIXTURE_REF_INVALID");
const fixture=JSON.parse(readFileSync("/source/fixtures/"+spec.fixture_ref+".json","utf8"));
if(fixture.module!==process.env.BRAI_RECIPE_SOURCE_FILE)throw Error("SOURCE_BINDING_INVALID");
if(!/^[a-zA-Z0-9_./-]+[.]mjs$/.test(fixture.module)||fixture.module.startsWith("/")||fixture.module.split("/").includes(".."))throw Error("FIXTURE_INVALID");
const module=await import(pathToFileURL("/source/"+fixture.module).href);
const actual=await module.evaluate(fixture.input);
if(typeof actual!=="string"||actual.length>4000)throw Error("FIXTURE_OUTPUT_INVALID");
process.stdout.write(JSON.stringify({assertions:[{name:"regression behaviour",actual}]}));
