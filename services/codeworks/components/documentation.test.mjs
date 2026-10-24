// ABOUTME: Проверяет полноту документации и приватную границу на изолированных Git fixtures.
// ABOUTME: Не открывает личные инструкции и не обращается к работающим сервисам.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {sourceFiles,validateDocumentation} from './graph.mjs';
const repository=resolve(import.meta.dirname,'../../..');
function fixture(t) {
  mkdirSync(join(repository,'tmp'),{recursive:true});
  const root=mkdtempSync(join(repository,'tmp','documentation-fixture-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  execFileSync('git',['init','-q',root]);
  const put=(p,text)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),text);};
  put('.gitignore','/docs/user-agent/usercustom/\n');
  put('AGENTS.md','[Documentation](docs/README.md)');
  put('docs/README.md','[Components](components/README.md) [Environment](environment/README.md) [Agent](user-agent/README.md)');
  put('docs/components/README.md','[Probe](probe.md)');
  put('docs/environment/README.md','# Environment');
  put('docs/user-agent/README.md','# Agent');
  put('docs/components/probe.md','[Technical](../../services/probe/README.md)');
  put('services/probe/README.md','# Technical');
  const descriptor={id:'probe',status:'active',directory:'services/probe',inputs:{runtime:[],build:[],checks:[]},delivery:{files:[]},dependencies:[]};
  const graph=()=>({files:sourceFiles(root),components:new Map([['probe',descriptor]])});
  return {root,put,graph,descriptor};
}
test('public navigation works without Admin and ignores unreadable personal files',t=>{
  const f=fixture(t);f.put('docs/user-agent/usercustom/private.md','[not public](/private/path)');
  assert.equal(validateDocumentation(f.root,f.graph()).components,1);
});
test('missing card, index entry and technical entry fail',t=>{
  for(const name of ['docs/components/probe.md','docs/components/README.md','services/probe/README.md']) {
    const f=fixture(t);
    if(name.endsWith('components/README.md'))f.put(name,'# Empty');else rmSync(join(f.root,name));
    assert.throws(()=>validateDocumentation(f.root,f.graph()),/DOC_(COMPONENT|TECHNICAL)_MISSING/);
  }
});
test('broken, absolute, escaping and orphan documentation fail',t=>{
  for(const [text,code] of [['[bad](missing.md)','DOC_BROKEN_LINK'],['[bad](/srv/projects/admin/a.md)','DOC_EXTERNAL_LOCAL_PATH'],['[bad](../../../private.md)','DOC_INVALID_LINK']]) {
    const f=fixture(t);f.put('docs/user-agent/README.md',text);
    assert.throws(()=>validateDocumentation(f.root,f.graph()),new RegExp(code));
  }
  const f=fixture(t);f.put('services/probe/hidden.md','# orphan');
  assert.throws(()=>validateDocumentation(f.root,f.graph()),/DOC_UNREACHABLE/);
});
test('retired components and external recipes have explicit index entries',t=>{
  const f=fixture(t);f.descriptor.status='retired';
  assert.throws(()=>validateDocumentation(f.root,f.graph()),/DOC_RETIRED_UNMARKED/);
  f.put('docs/components/probe.md','retired: [Technical](../../services/probe/README.md)');
  validateDocumentation(f.root,f.graph());
  f.descriptor.directory='dependencies/probe';
  assert.throws(()=>validateDocumentation(f.root,f.graph()),/DOC_COMPONENT_MISSING/);
});
test('tracked personal files and delivery ancestors are rejected',t=>{
  const f=fixture(t);f.put('docs/user-agent/usercustom/private.md','private fixture');
  execFileSync('git',['-C',f.root,'add','-f','docs/user-agent/usercustom/private.md']);
  assert.throws(()=>validateDocumentation(f.root,f.graph()),/DOC_PRIVATE_TRACKED/);
  for(const path of ['docs','docs/user-agent','docs/user-agent/usercustom','docs/**']) {
    const g=fixture(t);g.descriptor.delivery.files=[path];
    assert.throws(()=>validateDocumentation(g.root,g.graph()),/DOC_PRIVATE_DELIVERY/);
  }
});

test('local fragments must refer to an existing heading',t=>{
  const f=fixture(t);
  f.put('docs/user-agent/README.md','# Agent\n[anchor](#agent)\n');
  validateDocumentation(f.root,f.graph());
  f.put('docs/user-agent/README.md','# Agent\n[anchor](#missing)\n');
  assert.throws(()=>validateDocumentation(f.root,f.graph()),/DOC_BROKEN_ANCHOR/);
});
