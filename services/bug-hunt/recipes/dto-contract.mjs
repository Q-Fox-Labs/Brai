// ABOUTME: Проверяет DTO по закреплённой схеме на synthetic fixture.
// ABOUTME: Ожидаемое поведение приходит независимому runner из oracle, harness возвращает только факт.
import {readFileSync} from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
const spec=JSON.parse(readFileSync("/spec.json","utf8"));
if(!/^[a-z0-9-]{1,100}$/.test(spec.fixture_ref))throw Error("FIXTURE_REF_INVALID");
const fixture=JSON.parse(readFileSync("/source/fixtures/"+spec.fixture_ref+".json","utf8"));
if(fixture.schema!==process.env.BRAI_RECIPE_SOURCE_FILE)throw Error("SOURCE_BINDING_INVALID");
if(!/^[a-zA-Z0-9_./-]+$/.test(fixture.schema)||fixture.schema.split("/").includes("..")||!fixture.definition)throw Error("FIXTURE_INVALID");
const schema=JSON.parse(readFileSync("/source/"+fixture.schema,"utf8"));
const ajv=new Ajv({strict:false});addFormats(ajv);ajv.addSchema(schema,"source");
const validate=ajv.compile({$ref:"source#/definitions/"+fixture.definition});
process.stdout.write(JSON.stringify({assertions:[{name:"dto acceptance",actual:validate(fixture.input)?"accepted":"rejected"}]}));
