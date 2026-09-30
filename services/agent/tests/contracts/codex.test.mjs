// ABOUTME: Проверяет замыкание схем Codex и фактическую форму raw RPC.
// ABOUTME: Утверждения о live-поведении ограничены результатом пробы операции 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { openrpcDocument } from '@open-rpc/meta-schema';
import { jsonSchema as jsonSchemaMeta } from '@json-schema-tools/meta-schema';

const base = new URL('../../contracts/codex/', import.meta.url);
const schema = JSON.parse(await readFile(new URL('schema.json', base)));
const openrpc = JSON.parse(await readFile(new URL('openrpc.json', base)));
const manifest = JSON.parse(await readFile(new URL('manifest.json', base)));

function refs(value, into = []) {
  if (!value || typeof value !== 'object') return into;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string') into.push(child);
    else refs(child, into);
  }
  return into;
}

test('OpenRPC entries and schema closure resolve with no unused upstream definitions', () => {
  assert.match(openrpc.openrpc, /^1\./);
  assert.equal(openrpc.paramStructure,undefined);
  for (const method of openrpc.methods) assert.equal(method.paramStructure,'by-name',method.name);
  for (const method of openrpc.methods) {
    assert.ok(method['x-paramsSchema']?.$ref, `${method.name} whole-params reference`);
    for (const parameter of method.params) assert.ok(parameter.schema.$ref.includes(`/properties/${parameter.name}`), `${method.name}.${parameter.name} is a top-level field`);
  }
  assert.deepEqual(openrpc.methods.find(method=>method.name==='turn/start').params.filter(p=>p.required).map(p=>p.name), schema.definitions.TurnStartParams.required);
  const defs = schema.definitions;
  const allRefs = [...refs(openrpc), ...Object.values(defs).flatMap(value => refs(value))];
  for (const ref of allRefs) {
    if (ref.startsWith('schema.json#')) {
      const pointer = ref.slice('schema.json#'.length).split('/').slice(1).map(x=>x.replace(/~1/g,'/').replace(/~0/g,'~'));
      let node = schema;
      for (const part of pointer) node = node?.[part];
      assert.notEqual(node, undefined, `unresolved ${ref}`);
    } else if (ref.startsWith('#/components/schemas/')) {
      assert.ok(openrpc.components.schemas[ref.split('/').at(-1)], `unresolved ${ref}`);
    } else if (ref.startsWith('#/definitions/')) {
      assert.ok(defs[ref.split('/').at(-1)], `unresolved ${ref}`);
    } else assert.fail(`unexpected reference ${ref}`);
  }
  const reachable = new Set();
  const visit = name => { if (reachable.has(name)) return; reachable.add(name); for (const ref of refs(defs[name] ?? {})) if (ref.startsWith('#/definitions/')) visit(ref.split('/').at(-1)); };
  for (const name of manifest.rootTypes) visit(name);
  assert.deepEqual([...Object.keys(defs)].filter(name=>!reachable.has(name)), []);
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  const ajv = new Ajv({allErrors:true, strict:false, validateFormats:false});
  for (const [name, definition] of Object.entries(defs)) assert.doesNotThrow(()=>ajv.compile({$schema:schema.$schema,definitions:defs,$ref:`#/definitions/${name}`}), name);
});

test('wire envelopes omit mandatory jsonrpc field and forbid result plus error', () => {
  const rawRequest = openrpc.components.schemas.RawRequest;
  const validateRequest = requireAjv(rawRequest);
  const valid = value => validateRequest(value);
  assert.ok(valid({id:'r1',method:'initialize',params:{}}));
  assert.ok(valid({id:1,method:'turn/interrupt',params:{}}));
  assert.equal(valid({id:1.5,method:'turn/interrupt',params:{}}),false);
  const response = openrpc.components.schemas.RawResponse;
  const validateResponse = requireAjv(response);
  assert.ok(validateResponse({id:'r1',result:{}}));
  assert.ok(validateResponse({id:null,error:{code:-32600,message:'Invalid Request'}}));
  assert.ok(validateResponse({id:'r1',error:{code:-32600,message:'Invalid Request'}}));
  assert.equal(validateResponse({id:'r1',result:{},error:{code:-32600,message:'Invalid Request'}}), false);
});

function requireAjv(target) {
  const ajv = new Ajv({allErrors:true,strict:false});
  return ajv.compile(target);
}

test('upstream start, steer, interrupt, approval, and question shapes validate exactly', () => {
  const ajv = new Ajv({allErrors:true,strict:false,validateFormats:false});
  const validate = name => ajv.compile({$schema:schema.$schema,definitions:schema.definitions,$ref:`#/definitions/${name}`});
  assert.ok(validate('TurnStartParams')({threadId:'th-1',input:[{type:'text',text:'hello'}]}));
  assert.ok(validate('TurnSteerParams')({threadId:'th-1',expectedTurnId:'turn-1',input:[{type:'text',text:'continue'}]}));
  assert.ok(validate('TurnInterruptParams')({threadId:'th-1',turnId:'turn-1'}));
  assert.ok(validate('CommandExecutionRequestApprovalResponse')({decision:'decline'}));
  assert.equal(validate('CommandExecutionRequestApprovalResponse')({decision:'allow'}),false);
  assert.ok(validate('ToolRequestUserInputResponse')({answers:{q1:{answers:['A']}}}));
  assert.equal(validate('ToolRequestUserInputResponse')({answers:{q1:{answer:'A'}}}),false);
});

test('initialized and schema-only notification/server-request mappings describe packet direction', () => {
  const initialized = openrpc['x-clientNotifications'].find(item=>item.name==='initialized');
  assert.deepEqual(initialized.packet,{method:'initialized',params:{}});
  assert.equal(initialized.hasRpcId,false);
  for (const name of ['item/commandExecution/outputDelta','item/fileChange/outputDelta','turn/plan/updated']) {
    assert.ok(openrpc['x-notifications'].some(item=>item.name===name&&item.evidence==='schema-only'));
  }
  const fileApproval = openrpc['x-serverRequests'].find(item=>item.name==='item/fileChange/requestApproval');
  assert.ok(fileApproval.params.$ref.endsWith('/FileChangeRequestApprovalParams'));
  assert.ok(fileApproval.response.$ref.endsWith('/FileChangeRequestApprovalResponse'));
});

test('schema-only permission response is a profile and not an invented decision', () => {
  const permission = schema.definitions.PermissionsRequestApprovalResponse;
  assert.ok(permission);
  assert.ok(refs(permission).some(ref=>ref.includes('GrantedPermissionProfile')));
  assert.ok(!JSON.stringify(permission).includes('decision'));
});


test('OpenRPC document validates against released meta-schema and external Draft-07 schema', () => {
  const ajv = new Ajv({allErrors:true,strict:false});
  addFormats(ajv);
  ajv.addSchema(jsonSchemaMeta);
  // OpenRPC 1.14.9 references the same official resource without its trailing slash.
  ajv.addSchema({...jsonSchemaMeta, $id:'https://meta.json-schema.tools'}, 'https://meta.json-schema.tools');
  const validate = ajv.compile(openrpcDocument);
  assert.equal(validate(openrpc),true,JSON.stringify(validate.errors,null,2));
});
