// ABOUTME: Разрывает только соединения изолированного fixture с PostgreSQL или Temporal.
// ABOUTME: Не останавливает серверы и не журналирует передаваемые пакеты или credentials.
import net from 'node:net';
/** Возвращает loopback proxy; dropOnCommit теряет ответ уже выполненной транзакции PostgreSQL. */
export async function connectionProxy(host,port,{dropOnCommit=false}={}){
  const sockets=new Set();let online=true;
  const server=net.createServer(client=>{
    if(!online){client.destroy();return;}
    const remote=net.connect({host,port});let commit=false;
    sockets.add(client);sockets.add(remote);
    const close=()=>{client.destroy();remote.destroy();sockets.delete(client);sockets.delete(remote);};
    client.on('error',close);remote.on('error',close);client.on('close',close);remote.on('close',close);
    client.on('data',data=>{if(dropOnCommit&&data.includes(Buffer.from('COMMIT\0')))commit=true;remote.write(data);});
    remote.on('data',data=>{if(commit){close();return;}client.write(data);});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {address:'127.0.0.1:'+server.address().port,drop(){online=false;for(const socket of sockets)socket.destroy();},restore(){online=true;},async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
