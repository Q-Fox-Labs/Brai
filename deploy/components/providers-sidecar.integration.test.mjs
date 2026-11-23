// ABOUTME: Проверяет сеть реального LiteLLM при пересоздании и откате изолированного Providers fixture.
// ABOUTME: Использует тестовый ключ и сеть, не подключаясь к существующим контейнерам Brai.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

test('Compose moves the LiteLLM sidecar to the new provider network and back',
  {skip:process.env.BRAI_TEST_PROVIDER_SIDECAR !== '1',timeout:300000},async t=>{
  const nodeImage=JSON.parse(readFileSync(new URL('./toolchain.json',import.meta.url),'utf8')).nodeBase;
  const provider=JSON.parse(readFileSync(new URL('../../services/providers/component.json',import.meta.url),'utf8'));
  const proxyImages=provider.delivery.systemRequirements.flatMap(row=>row.match(/docker\.litellm\.ai\/berriai\/litellm@sha256:[0-9a-f]{64}/g)??[]);
  assert.match(nodeImage,/^node:[^@]+@sha256:[0-9a-f]{64}$/);
  assert.equal(proxyImages.length,1);
  const proxyImage=proxyImages[0];
  const dir=mkdtempSync(join(tmpdir(),'brai-sidecar-fixture-'));
  const project=`brai-sidecar-${randomBytes(16).toString('hex')}`;
  const compose=join(dir,'compose.json');
  const env={PATH:process.env.PATH,HOME:dir,DOCKER_HOST:'unix:///var/run/docker.sock'};
  const docker=(args,timeout=30000)=>execFileSync('docker',args,{env,encoding:'utf8',timeout,stdio:['ignore','pipe','pipe']}).trim();
  const prefix=['compose','--project-name',project,'-f',compose];
  let written=false;
  t.after(()=>{
    try {
      if(written)docker([...prefix,'down','--remove-orphans','--volumes'],60000);
      assert.equal(docker(['ps','--all','--quiet','--filter',`label=com.docker.compose.project=${project}`]),'');
      assert.equal(docker(['network','ls','--quiet','--filter',`label=com.docker.compose.project=${project}`]),'');
    }
    finally {rmSync(dir,{recursive:true,force:true});}
  });
  assert.equal(docker(['ps','--all','--quiet','--filter',`label=com.docker.compose.project=${project}`]),'');
  assert.equal(docker(['network','ls','--quiet','--filter',`label=com.docker.compose.project=${project}`]),'');
  writeFileSync(join(dir,'proxy.yaml'),'model_list: []\ngeneral_settings:\n  master_key: sk-fixture-only\n',{mode:0o644});
  docker(['pull',nodeImage],120000);
  docker(['pull',proxyImage],180000);
  let previous;
  for(const generation of ['one','two','one']){
    const document={services:{
      providers:{image:nodeImage,user:'1000:1000',entrypoint:['/usr/local/bin/node'],
        command:['-e','setInterval(() => {}, 1000)'],read_only:true,labels:{'org.brai.fixture.generation':generation},
        healthcheck:{test:['CMD','/usr/local/bin/node','-e','process.exit(0)'],interval:'2s',timeout:'2s',retries:15},networks:['isolated']},
      litellm:{image:proxyImage,network_mode:'service:providers',depends_on:['providers'],
        command:['--config','/fixture/proxy.yaml','--host','127.0.0.1','--port','18400'],
        environment:{LITELLM_LOCAL_MODEL_COST_MAP:'True',DO_NOT_TRACK:'True'},volumes:[`${dir}/proxy.yaml:/fixture/proxy.yaml:ro`]},
    },networks:{isolated:{internal:true}}};
    writeFileSync(compose,JSON.stringify(document),{mode:0o600});written=true;
    docker([...prefix,'up','--detach','--wait','--no-deps','--no-build','--pull','never','providers','litellm'],120000);
    const provider=docker([...prefix,'ps','--quiet','providers']);
    const proxy=docker([...prefix,'ps','--quiet','litellm']);
    assert.match(provider,/^[a-f0-9]{64}$/);assert.match(proxy,/^[a-f0-9]{64}$/);
    const observed=JSON.parse(docker(['inspect','--type','container',proxy]))[0];
    assert.equal(observed.HostConfig.NetworkMode,`container:${provider}`);
    assert.equal(observed.State.Running,true);
    if(previous){assert.notEqual(provider,previous.provider);assert.notEqual(proxy,previous.proxy);}
    const probe='Promise.all([fetch("http://127.0.0.1:18400/health/liveliness"),fetch("http://127.0.0.1:18400/v1/models",{headers:{Authorization:"Bearer sk-fixture-only"}})]).then(r=>{if(r.some(x=>!x.ok))process.exit(1)}).catch(()=>process.exit(1))';
    let ready=false;
    for(let attempt=0;attempt<30;attempt++){
      try{docker(['exec',provider,'/usr/local/bin/node','-e',probe],5000);ready=true;break;}
      catch{await new Promise(resolve=>setTimeout(resolve,2000));}
    }
    assert.equal(ready,true,`LiteLLM did not become ready for generation ${generation}`);
    t.diagnostic(`provider and LiteLLM verified for generation ${generation}`);
    previous={provider,proxy};
  }
});
