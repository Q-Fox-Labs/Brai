// ABOUTME: Создаёт disposable Git репозитории и подключает явно указанную тестовую PostgreSQL.
// ABOUTME: Не читает .env, не устанавливает пакеты и не обращается к пользовательским БД.
import { readFile,mkdir,writeFile,mkdtemp,copyFile,chmod,rm,realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID,createHash } from 'node:crypto';
import { Pool } from 'pg';
import { command as runCommand,createGit } from '../../src/git.mjs';
import { createStore } from '../../src/storage.mjs';
import { createHandlers } from '../../src/domain.mjs';
import { migrate } from '../../src/migrate.mjs';
import { launchWorker } from '../../src/runtime.mjs';
export const configured=!!process.env.CODEWORKS_TEST_CONFIG_FILE;
/** Принимает native write.begin через указанный handler/runtime, сохраняя identity повтора. */
export async function prepareWith(call,args,executor='codex') {
  const key=createHash('sha256').update(JSON.stringify(args)).digest('hex');
  const request={...args,session_id:'fixture-session',turn_id:key,tool_use_id:key,tool_name:'apply_patch',payload_sha256:key,targets:['hello.txt']};
  const result=await call('write.begin',request,executor);
  await call('write.stop',{project_id:args.project_id,session_id:request.session_id,turn_id:request.turn_id,event:'Stop'},executor);
  return Object.fromEntries(['workspace_id','operation_id','path','branch'].filter(field=>field in result).map(field=>[field,result[field]]));
}
/** Принимает только две конкретные disposable DB; credentials не логируются. */
export async function readConfig() {
  if(!configured)throw new Error('CODEWORKS_TEST_CONFIG_FILE_REQUIRED');
  const config=JSON.parse(await readFile(process.env.CODEWORKS_TEST_CONFIG_FILE,'utf8'));
  const primary=config.fixture==='temporal'?'brai_codeworks_temporal_test':'brai_codeworks_test',restore=config.fixture==='temporal'?'brai_codeworks_temporal_restore_test':'brai_codeworks_restore_test';
  for(const [key,name] of [['owner_url',primary],['app_url',primary],['restore_owner_url',restore],['restore_app_url',restore]]) {
    const url=new URL(config[key]);
    if(url.pathname!=='/'+name||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('DISPOSABLE_DATABASE_REQUIRED');
  }
  return config;
}
/** Применяет owner migrations только в указанной test DB и создаёт реальные Git fixtures. */
export async function setup({git=createGit(),command=runCommand}={}) {
  const config=await readConfig();
  const owner=new Pool({connectionString:config.owner_url,max:4}),app=new Pool({connectionString:config.app_url,max:8});
  await migrate(owner,config.app_role);
  await migrate(owner,config.app_role);
  await owner.query('TRUNCATE codeworks.requests,codeworks.legacy_attachments,codeworks.releases,codeworks.operations,codeworks.workspaces,codeworks.projects CASCADE');
  const allowedRepositories=[];
  const h=createHandlers(createStore(app),git,{allowedRepositories});
  const temporary=[];
  return {config,owner,app,h,
    /** Создаёт область через настоящий durable native write.begin, без допуска инструмента. */
    async prepare(args,executor='codex') {
      return prepareWith(h.call,args,executor);
    },
    /** Реальный минимальный monorepo использует установленный подготовщик с package/workspace проверками. */
    async project({documentationPaths=[],sharedFixture=false,github,codeIndexDisabled=false}={}) {
      const temporaryRoot=fileURLToPath(new URL('../../../../tmp/',import.meta.url));
      await mkdir(temporaryRoot,{recursive:true});
      const root=await realpath(await mkdtemp(path.join(temporaryRoot,'codeworks-test-')));temporary.push(root);
      const repo=path.join(root,'repo'),areas=path.join(root,'areas');
      await mkdir(repo);await mkdir(areas);await mkdir(path.join(repo,'node_modules'));
      const manifest={name:'fixture',version:'1.0.0',private:true,workspaces:['packages/*'],engines:{node:'24.22.1',npm:'11.19.1'}};
      if(sharedFixture)manifest.dependencies={'shared-readonly':'1.0.0'};
      const leaf={name:'@fixture/leaf',version:'1.0.0'};
      await mkdir(path.join(repo,'packages/leaf'),{recursive:true});
      await writeFile(path.join(repo,'packages/leaf/package.json'),JSON.stringify(leaf)+'\n');
      await writeFile(path.join(repo,'package.json'),JSON.stringify(manifest)+'\n');
      const packages={'':manifest,'packages/leaf':leaf,'node_modules/@fixture/leaf':{resolved:'packages/leaf',link:true}};
      if(sharedFixture){
        packages['node_modules/shared-readonly']={version:'1.0.0'};
        await mkdir(path.join(repo,'node_modules/shared-readonly'));
        await writeFile(path.join(repo,'node_modules/shared-readonly/package.json'),JSON.stringify({name:'shared-readonly',version:'1.0.0'}));
        await writeFile(path.join(repo,'node_modules/shared-readonly/keep.js'),'shared dependency\n');
      }
      await writeFile(path.join(repo,'package-lock.json'),JSON.stringify({name:'fixture',version:'1.0.0',lockfileVersion:3,packages})+'\n');
      await mkdir(path.join(repo,'node_modules/@fixture'),{recursive:true});
      const {symlink}=await import('node:fs/promises');await symlink(path.join(repo,'packages/leaf'),path.join(repo,'node_modules/@fixture/leaf'));
      await writeFile(path.join(repo,'.gitignore'),'node_modules/\nAGENTS.override.md\n');
      await writeFile(path.join(repo,'AGENTS.override.md'),'Synthetic worktree instructions.\n');
      await writeFile(path.join(repo,'hello.txt'),'frozen base\n');
      if(documentationPaths.length){await mkdir(path.join(repo,'docs'));await writeFile(path.join(repo,'docs/readme.md'),'base docs\n');}
      await command('git',['init','-b','dev',repo]);
      await command('git',['-C',repo,'config','user.name','Codeworks fixture']);
      await command('git',['-C',repo,'config','user.email','fixture@example.invalid']);
      await command('git',['-C',repo,'add','.']);
      await command('git',['-C',repo,'commit','-m','Synthetic base']);
      const base=(await command('git',['-C',repo,'rev-parse','HEAD'])).stdout;
      await command('git',['-C',repo,'update-ref','refs/remotes/origin/dev',base]);
      await command('git',['-C',repo,'update-ref','refs/remotes/origin/main',base]);
      const common=path.join(repo,'.git');
      const sourceCommon=(await command('git',['rev-parse','--path-format=absolute','--git-common-dir'])).stdout;
      const preparer=path.join(common,'hooks/prepare-brai-worktree');
      await copyFile(process.env.CODEWORKS_TEST_PREPARER??path.join(sourceCommon,'hooks/prepare-brai-worktree'),preparer);await chmod(preparer,0o755);
      const project={id:'test_'+randomUUID(),repo_path:repo,common_dir:common,workspace_root:areas,allowed_paths:['.'],excluded_paths:['.git','node_modules','.env'],executors:['codex','hermes'],git_flow:{feature_base:'refs/remotes/origin/dev',hotfix_base:'refs/remotes/origin/main',feature_prefix:'feature/',hotfix_prefix:'hotfix/'},preparer_path:preparer,node_version:'24.22.1',platform:process.platform+'-'+process.arch};
      if(codeIndexDisabled)project.code_index_policy={enabled:false};
      if(github){
        project.github=github;
        const remote=path.join(root,'origin.git');
        await command('git',['init','--bare',remote]);await command('git',['-C',repo,'remote','add','origin',remote]);
        await command('git',['-C',repo,'push','origin','dev',base+':refs/heads/main']);
      }
      if(documentationPaths.length)project.documentation_paths=documentationPaths;
      allowedRepositories.push(repo);
      await h.call('project.register',{project},'codeworks_admin');
      return project;
    },
    /** Запускает настоящий worker; SIGKILL снимает только его lock/session, не данные. */
    async worker(project,operationId,crashAfter) {
      const child=launchWorker(project.common_dir,operationId,{...process.env,CODEWORKS_DATABASE_URL:config.app_url,CODEWORKS_ALLOWED_REPOSITORIES:JSON.stringify([project.repo_path]),CODEWORKS_TEST_MODE:'1',CODEWORKS_TEST_CRASH_AFTER:crashAfter??''});
      let stderr='';child.stderr.on('data',b=>stderr+=b);
      const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
      if(result.code!==0&&result.code!==75&&result.signal!=='SIGKILL')throw new Error('FIXTURE_WORKER_FAILED '+result.code+' '+stderr);
      return result;
    },
    /** Закрывает только созданные fixtures и собственные строки тестовой БД. */
    async close() {
      await owner.query('TRUNCATE codeworks.requests,codeworks.legacy_attachments,codeworks.releases,codeworks.operations,codeworks.workspaces,codeworks.projects CASCADE');
      await Promise.all([owner.end(),app.end()]);
      for(const root of temporary)await rm(root,{recursive:true,force:true});
    },
  };
}
