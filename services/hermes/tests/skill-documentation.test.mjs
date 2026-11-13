// ABOUTME: Проверяет включение публичных текстов навыков в идентичность поставки Hermes.
// ABOUTME: Сравнивает настоящие fingerprints в отдельной временной копии исходных входов.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, cpSync, existsSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {expand, fingerprints, discover, validateDocumentation} from '../../../deploy/components/graph.mjs';
import {buildOutputInventory} from '../../../deploy/components/cli.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
test('public skill texts and executable helpers change their Hermes payload',t=>{
  mkdirSync(join(root,'tmp'),{recursive:true});
  const fixture=mkdtempSync(join(root,'tmp/hermes-doc-fingerprint-'));
  t.after(()=>rmSync(fixture,{recursive:true,force:true}));
  const component=JSON.parse(readFileSync(join(root,'services/hermes/component.json'),'utf8'));
  const inputs=[...component.inputs.build,...component.inputs.runtime,...component.inputs.checks,
    ...component.dependencies.flatMap(d=>d.inputs)];
  const files=new Set(expand(root,inputs));
  files.add('package-lock.json');
  const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));
  for(const key of Object.keys(lock.packages))
    if(!key.includes('node_modules') && existsSync(join(root,key,'package.json')))
      files.add(join(key,'package.json'));
  if(existsSync(join(root,'deploy/components/toolchain.json')))
    files.add('deploy/components/toolchain.json');
  for(const path of new Set([...files,...component.delivery.files,...component.dependencies.flatMap(d=>d.delivery)])){
    if(!existsSync(join(root,path)))continue;
    mkdirSync(dirname(join(fixture,path)),{recursive:true});
    cpSync(join(root,path),join(fixture,path),{recursive:true});
  }
  const before=fingerprints(fixture,component);
  const docsRoot=join(root,'docs/user-agent/instructions');
  const skillTexts=[];
  function collectTexts(directory) {
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      if(entry.isDirectory()) collectTexts(path);
      else if(/\.(md|txt)$/.test(entry.name)) skillTexts.push(path.slice(root.length));
    }
  }
  collectTexts(join(docsRoot,'hermes/skills'));
  collectTexts(join(docsRoot,'skills'));
  for(const path of skillTexts) {
    mkdirSync(dirname(join(fixture,path)),{recursive:true});
    writeFileSync(join(fixture,path),'changed independently installed document');
  }
  const text='docs/user-agent/instructions/hermes/skills/creative/art-director/SKILL.md';
  mkdirSync(dirname(join(fixture,text)),{recursive:true});
  writeFileSync(join(fixture,text),'first text');
  const first=fingerprints(fixture,component);
  assert.notEqual(first.artifact,before.artifact);
  assert.notEqual(first.runtime,before.runtime);
  writeFileSync(join(fixture,text),'changed skill text');
  const updated=fingerprints(fixture,component);
  assert.notEqual(updated.artifact,first.artifact);
  assert.notEqual(updated.runtime,first.runtime);
  const script='services/hermes/extensions/skill-scripts/media/youtube-content/scripts/video_workflow.py';
  writeFileSync(join(fixture,script),readFileSync(join(fixture,script),'utf8')+'\n# changed executable fixture\n');
  const after=fingerprints(fixture,component);
  assert.notEqual(after.build,updated.build);
  assert.notEqual(after.artifact,updated.artifact);
  assert.notEqual(after.runtime,updated.runtime);
});

test('the actual component graph and documentation remain valid',()=>{
  const graph=discover(root,{allowMissingBuildOutputs:true});
  validateDocumentation(root,graph);
});

test('delivery includes the mandatory public skill documentation',()=>{
  const component=JSON.parse(readFileSync(join(root,'services/hermes/component.json'),'utf8'));
  const delivered=new Set(buildOutputInventory(root,component).map(item=>item.path));
  assert.ok(delivered.has('docs/user-agent/instructions/hermes/skills/creative/context-gifs/SKILL.md'));
});

test('Hermes packager includes the public skill and workflow closure',()=>{
  const result=spawnSync(process.env.PYTHON||'python3',['-B','-m','unittest','discover','-s',join(root,'services/hermes/identity/tests'),'-p','test_component_release_package.py'],
    {cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  assert.match(result.stderr,/Ran [1-9]\d* tests?/);
});
