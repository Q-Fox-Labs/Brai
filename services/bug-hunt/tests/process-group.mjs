// ABOUTME: Останавливает только созданную fixture отдельную группу npm/Next.
// ABOUTME: Уход лидера не оставляет потомков; ESRCH является штатным завершением.
export async function stopChildGroup(child){
 if(!child?.pid)return;
 const signal=value=>{try{process.kill(-child.pid,value);}catch(error){if(error.code!=='ESRCH')throw error;}};
 try{
  signal('SIGTERM');
  await new Promise(resolve=>setTimeout(resolve,1000));
  signal('SIGKILL');
 }finally{child.stdout?.destroy();child.stderr?.destroy();}
}
