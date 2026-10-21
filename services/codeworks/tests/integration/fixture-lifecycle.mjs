// ABOUTME: Дожидается собственных async bodies до destructive cleanup PostgreSQL fixture.
// ABOUTME: Отмена запрещает новые действия, но не выдаёт завершение node:test за завершение worker.
export function fixtureTimeout(value) {
  if(value===undefined)return 120000;
  if(typeof value!=='string'||!/^\d+$/.test(value))throw Error('INVALID_TEST_TIMEOUT');
  const timeout=Number(value);
  if(!Number.isSafeInteger(timeout)||timeout<120000||timeout>600000)throw Error('INVALID_TEST_TIMEOUT');
  return timeout;
}
/** Отслеживает настоящие promises: node:test при timeout завершает wrapper раньше async body. */
export function fixtureLifecycle(signal) {
  const active=new Set();let closing=false,closed;
  const check=()=>{signal.throwIfAborted();if(closing)throw Error('FIXTURE_CLOSING');};
  function run(work) {
    check();
    const promise=Promise.resolve().then(()=>{check();return work();}).then(value=>{check();return value;});
    active.add(promise);
    promise.then(()=>active.delete(promise),()=>active.delete(promise));
    return promise;
  }
  const guard=work=>(...args)=>run(()=>work(...args));
  const port=target=>new Proxy(target,{get(object,key){const value=Reflect.get(object,key,object);return typeof value==='function'?guard(value.bind(object)):value;}});
  return {run,guard,port,
    close(cleanup) {
      if(closed)return closed;
      closing=true;
      closed=(async()=>{
        while(active.size)await Promise.allSettled([...active]);
        await cleanup();
      })();
      return closed;
    },
  };
}
