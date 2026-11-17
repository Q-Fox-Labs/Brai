// ABOUTME: Печатает подготовленный HTML в PDF через собственный Chrome Hermes.
// ABOUTME: Создаёт отдельный browser context; не открывает внешние страницы и не ставит пакеты.
import fs from 'node:fs/promises';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const endpoint = new URL(process.env.BROWSER_CDP_URL || 'http://127.0.0.1:19364');
if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.protocol !== 'http:') throw Error('PDF_CDP_ENDPOINT');
const version = await fetch(new URL('/json/version', endpoint), {signal: AbortSignal.timeout(5000)}).then(r => r.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, {once:true}); ws.addEventListener('error', reject, {once:true}); });
let sequence = 0;
const pending = new Map();
ws.addEventListener('message', event => {
  const value = JSON.parse(event.data);
  const entry = pending.get(value.id);
  if (entry) { pending.delete(value.id); clearTimeout(entry.timer); value.error ? entry.reject(Error('PDF_CDP_COMMAND')) : entry.resolve(value.result); }
});
/** Исполнить одну ограниченную по времени команду в своей CDP-сессии. */
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('PDF_CDP_TIMEOUT')); }, 15000);
    pending.set(id, {resolve,reject,timer});
    ws.send(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})}));
  });
}
let context;
try {
  context = (await call('Target.createBrowserContext', {disposeOnDetach:true})).browserContextId;
  const {targetId} = await call('Target.createTarget', {url:'about:blank',browserContextId:context});
  const {sessionId} = await call('Target.attachToTarget', {targetId,flatten:true});
  await call('Page.enable', {}, sessionId);
  const {frameTree} = await call('Page.getFrameTree', {}, sessionId);
  await call('Page.setDocumentContent', {frameId:frameTree.frame.id,html:input.html}, sessionId);
  await call('Runtime.evaluate', {expression:'document.fonts.ready.then(() => true)',awaitPromise:true}, sessionId);
  const {data} = await call('Page.printToPDF', {
    printBackground:true,preferCSSPageSize:true,displayHeaderFooter:true,
    headerTemplate:'<span></span>',
    footerTemplate:'<div style="font-size:8px;color:#667588;width:100%;text-align:center;font-family:Arial">Brai · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    generateTaggedPDF:true,generateDocumentOutline:true
  }, sessionId);
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.subarray(0,5).equals(Buffer.from('%PDF-'))) throw Error('PDF_INVALID');
  await fs.writeFile(input.path, bytes, {flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({sizeBytes:bytes.length})+'\n');
} finally {
  if (context) await call('Target.disposeBrowserContext', {browserContextId:context}).catch(() => {});
  ws.close();
}
