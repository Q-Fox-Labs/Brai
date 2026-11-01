// ABOUTME: Загружает публичные курсы ЦБ и USDT Kraken независимо от браузера.
// ABOUTME: Сохраняет последние исправные значения и отмечает сбои источника.
import type { Pool } from "pg";

type Fetcher = typeof fetch;
type Rate = {currency:string;rate:string;nominal:string;effectiveDate:string};
const decimal = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
function positive(value: string): boolean {
  return decimal.test(value) && /[1-9]/.test(value);
}
function date(value: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!match) throw new Error("INVALID_DATE");
  const result = `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(result + "T00:00:00Z");
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0,10) !== result) throw new Error("INVALID_DATE");
  return result;
}
function tag(text: string, name: string): string {
  const match = new RegExp(`<${name}>([^<]+)</${name}>`).exec(text);
  if (!match) throw new Error("INVALID_CBR");
  return match[1].trim();
}
/** Разбирает дату, номинал и значения ежедневного ответа ЦБ. */
export function parseCbr(xml: string): Rate[] {
  if (xml.length > 1_000_000) throw new Error("INVALID_CBR");
  const header = /<ValCurs\s+[^>]*Date="([^"]+)"[^>]*>/.exec(xml);
  if (!header) throw new Error("INVALID_CBR");
  const effectiveDate = date(header[1]);
  const blocks = [...xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)];
  if (!blocks.length) throw new Error("INVALID_CBR");
  const seen = new Set<string>();
  const rates = blocks.map(([,block]) => {
    const currency = tag(block,"CharCode"), nominal = tag(block,"Nominal"), rate = tag(block,"Value").replace(",",".");
    if (!/^[A-Z]{3}$/.test(currency) || seen.has(currency) || !/^[1-9][0-9]*$/.test(nominal) || !positive(rate)) throw new Error("INVALID_CBR");
    seen.add(currency); return {currency,rate,nominal,effectiveDate};
  });
  if (!seen.has("USD")) throw new Error("INVALID_CBR");
  return rates;
}
/** Извлекает последний курс USDT/USD из ответа Kraken. */
export function parseKraken(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("INVALID_KRAKEN");
  const record = value as {error?:unknown;result?:Record<string,{c?:unknown}>};
  if (!Array.isArray(record.error) || record.error.length || !record.result || typeof record.result !== "object") throw new Error("INVALID_KRAKEN");
  const price = record.result.USDTZUSD?.c;
  if (!Array.isArray(price) || typeof price[0] !== "string" || !positive(price[0])) throw new Error("INVALID_KRAKEN");
  return price[0];
}
async function response(fetcher: Fetcher, url: string): Promise<Response> {
  const result = await fetcher(url,{redirect:"error",signal:AbortSignal.timeout(10_000),headers:{Accept:"application/xml, application/json"}});
  if (!result.ok) throw new Error("PROVIDER_UNAVAILABLE");
  const size = Number(result.headers.get("content-length") ?? 0);
  if (size > 1_000_000) throw new Error("PROVIDER_TOO_LARGE");
  return result;
}
async function boundedText(result: Response): Promise<string> {
  if (!result.body) throw new Error("PROVIDER_UNAVAILABLE");
  const reader = result.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 1_000_000) {await reader.cancel();throw new Error("PROVIDER_TOO_LARGE");}
      chunks.push(part.value);
    }
  } finally {reader.releaseLock();}
  return new TextDecoder().decode(Buffer.concat(chunks));
}
/** Обновляет курсы ЦБ атомарно; при сбое оставляет прежние значения. */
export async function refreshCbr(pool: Pool, fetcher: Fetcher = fetch): Promise<void> {
  try {
    const rates = parseCbr(await boundedText(await response(fetcher,"https://www.cbr.ru/scripts/XML_daily.asp")));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const rate of rates) await client.query(`INSERT INTO goals.exchange_rates(currency,rate,nominal,source,effective_date,fetched_at,failed_at)
        VALUES($1,$2,$3,'ЦБ РФ',$4,now(),NULL) ON CONFLICT(currency) DO UPDATE SET rate=EXCLUDED.rate,nominal=EXCLUDED.nominal,source=EXCLUDED.source,effective_date=EXCLUDED.effective_date,fetched_at=EXCLUDED.fetched_at,failed_at=NULL`,
        [rate.currency,rate.rate,rate.nominal,rate.effectiveDate]);
      await client.query("UPDATE goals.exchange_rates SET failed_at=now() WHERE source='ЦБ РФ' AND NOT(currency = ANY($1::text[]))", [rates.map(rate => rate.currency)]);
      await client.query("COMMIT");
    } catch (error) {await client.query("ROLLBACK").catch(() => {});throw error;} finally {client.release();}
  } catch (error) {
    await pool.query("UPDATE goals.exchange_rates SET failed_at=now() WHERE source='ЦБ РФ'");
    throw error;
  }
}
/** Обновляет оценочный курс USDT через последнюю сохранённую оценку USD ЦБ. */
export async function refreshKraken(pool: Pool, fetcher: Fetcher = fetch): Promise<void> {
  try {
    const price = parseKraken(JSON.parse(await boundedText(await response(fetcher,"https://api.kraken.com/0/public/Ticker?pair=USDTUSD"))));
    const updated = await pool.query(`INSERT INTO goals.exchange_rates(currency,rate,nominal,source,effective_date,fetched_at,failed_at)
      SELECT 'USDT', $1::numeric * rate / nominal, 1, 'Kraken USDT/USD + ЦБ РФ USD', effective_date, now(), failed_at
      FROM goals.exchange_rates WHERE currency='USD'
      ON CONFLICT(currency) DO UPDATE SET rate=EXCLUDED.rate,nominal=1,source=EXCLUDED.source,effective_date=EXCLUDED.effective_date,fetched_at=EXCLUDED.fetched_at,failed_at=EXCLUDED.failed_at`, [price]);
    if (!updated.rowCount) throw new Error("USD_RATE_UNAVAILABLE");
  } catch (error) {
    await pool.query("UPDATE goals.exchange_rates SET failed_at=now() WHERE currency='USDT'");
    throw error;
  }
}
/** Запускает периодическую проверку источников без участия браузера. */
export function startRates(pool: Pool): () => Promise<void> {
  let fiatRunning: Promise<void> | undefined, cryptoRunning: Promise<void> | undefined, stopped = false;
  const fiat = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (fiatRunning) return fiatRunning;
    fiatRunning = (async () => {
      try {await refreshCbr(pool);} catch {console.error(JSON.stringify({service:"service_goals",result:"cbr_unavailable"}));}
      finally {fiatRunning = undefined;}
    })();
    return fiatRunning;
  };
  const crypto = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (cryptoRunning) return cryptoRunning;
    cryptoRunning = (async () => {
      try {await refreshKraken(pool);} catch {console.error(JSON.stringify({service:"service_goals",result:"kraken_unavailable"}));}
      finally {cryptoRunning = undefined;}
    })();
    return cryptoRunning;
  };
  void fiat().then(crypto);
  const one = setInterval(() => {void fiat();},60*60_000);
  const two = setInterval(() => {void crypto();},15*60_000);
  one.unref();two.unref();
  return async () => {
    stopped = true;clearInterval(one);clearInterval(two);
    await Promise.all([fiatRunning,cryptoRunning]);
  };
}
