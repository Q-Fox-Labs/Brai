// ABOUTME: Запускает один независимый настоящий Ansible job для fixture установки Codeworks.
// ABOUTME: Повтор по ID читает прежний результат; пути ограничены private fixture и PROD не используется.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const [input,id]=process.argv.slice(2),base=path.dirname(fs.realpathSync(input));
if(!/\/tmp\/codeworks-temporal\/ansible-[a-f0-9-]{36}$/.test(base)||!/^[0-9a-f-]{36}$/.test(id))throw Error('FIXTURE_REQUIRED');
const dir=base+'/'+id;fs.mkdirSync(dir,{recursive:true,mode:0o700});
if(fs.existsSync(dir+'/result.json'))console.log(fs.readFileSync(dir+'/result.json','utf8'));
else{
  try{
    fs.writeFileSync(dir+'/started',id,{flag:'wx',mode:0o600});
    const variables={codeworks_fixture_action:'upgrade',codeworks_fixture_input:input,codeworks_fixture_operation:id,codeworks_fixture_source:JSON.parse(fs.readFileSync(input)).source};
    fs.writeFileSync(dir+'/input.json',JSON.stringify(variables),{mode:0o600});
    const log=fs.openSync(dir+'/ansible.log','a',0o600);
    const child=spawn('/usr/bin/ansible-playbook',['-i','localhost,','-c','local','/srv/projects/admin/ansible/playbooks/operations/codeworks_temporal_service_fixture.yml','-e','@'+dir+'/input.json'],{detached:true,stdio:['ignore',log,log],env:{...process.env,ANSIBLE_CONFIG:'/srv/projects/admin/ansible/ansible.cfg'}});fs.closeSync(log);child.unref();
  }catch(error){if(error.code!=='EEXIST')throw error;}
  console.log(JSON.stringify({status:'running'}));
}
