import { pool } from "../db/pool";
import { round8, floor4, buyerPays } from "./pricingService";
import { inTransaction } from "./orderBookService";
import { getNexTradePrice } from "./nexTradePriceService";

/**
 * REAL TOKENLAR (v9): Toncoin (TON) va Notcoin (NOT).
 *
 * Narx haqiqiy bozordan olinadi va avtomatik kuzatiladi (har 20 soniyada):
 *   1) CoinGecko (narx, 24s o'zgarish, rasm)
 *   2) OKX, Binance, Bybit - birjalar narxi (mediana; 3% dan chetga chiqqani tashlanadi)
 *   3) Markaziy bank (cbu.uz) - 1 USD necha so'm
 *   Nex narxi = USD narx * (so'm/USD) / (so'm/Nex)
 *
 * NARX NAZORATI (price guard): ikki manba 3% dan ko'p farq qilsa yoki ma'lumot
 * 5 daqiqadan eskirsa - platforma savdosi vaqtincha to'xtatiladi (foydalanuvchilar
 * o'zaro savdo qila oladi), ma'lumot to'g'rilangach avtomatik qayta yoqiladi.
 *
 * Bozor (market-meyker): har 15 soniyada platforma real narx atrofida
 * 3 pog'onali sotuv va xarid buyurtmalarini yangilaydi (spred ±0.3% .. ±1.5%).
 */

export const REAL_TOKENS = [
  { symbol: "TON", alt: "TONCOIN", name: "Toncoin", cg: "the-open-network", okx: "TON-USDT", supply: 1_000_000 },
  { symbol: "NOT", alt: "NOTCOIN", name: "Notcoin", cg: "notcoin", okx: "NOT-USDT", supply: 1_000_000_000 },
];

const LEVELS = [0.003, 0.008, 0.015];
// Har pog'onadagi buyurtma hajmi (Nex) - .env: REAL_MM_LEVEL_NEX
const LEVEL_NEX = Number(process.env.REAL_MM_LEVEL_NEX ?? 2_000_000);
const MAX_DIVERGENCE = 0.03;
const STALE_MS = 5 * 60_000;
// Narx manbalari har 20 soniyada so'raladi (CoinGecko bepul chegarasiga sig'adi)
const FETCH_EVERY_MS = Number(process.env.REAL_FETCH_MS ?? 20_000);
const DEFAULT_USD_UZS = Number(process.env.USD_UZS_FALLBACK ?? 12800);

const PAIRS: Record<string, { binance: string; bybit: string }> = {
  "the-open-network": { binance: "TONUSDT", bybit: "TONUSDT" },
  notcoin: { binance: "NOTUSDT", bybit: "NOTUSDT" },
};

type Quote = { usd: number; change24h: number | null; image: string | null };
// sources[cgId] = { coingecko: 3.1, okx: 3.11, binance: ..., bybit: ... }
let cache: { at: number; cg: Record<string, Quote>; sources: Record<string, Record<string, number>>; usdUzs: number; usdUzsAt: number } = {
  at: 0, cg: {}, sources: {}, usdUzs: DEFAULT_USD_UZS, usdUzsAt: 0,
};

// Testlarda tashqi so'rovlarni almashtirish uchun
export let fetchJson: (url: string) => Promise<any> = async (url) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "NexTrade/1.0" } });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
};
export function setFetchJson(fn: (url: string) => Promise<any>) { fetchJson = fn; }
export function resetRealCache() { cache = { at: 0, cg: {}, sources: {}, usdUzs: DEFAULT_USD_UZS, usdUzsAt: 0 }; }

const warned = new Map<string, number>();
function warnOnce(key: string, msg: string) {
  // Bir xil xatoni logga har 10 daqiqada bir martadan ko'p yozmaymiz
  const last = warned.get(key) ?? 0;
  if (Date.now() - last > 10 * 60_000) { console.warn(msg); warned.set(key, Date.now()); }
}

async function fetchQuotes() {
  if (Date.now() - cache.at < FETCH_EVERY_MS) return cache;
  const ids = REAL_TOKENS.map((t) => t.cg).join(",");
  const cg: Record<string, Quote> = {};
  const sources: Record<string, Record<string, number>> = {};
  const put = (id: string, src: string, p: number) => { if (p > 0) (sources[id] ??= {})[src] = p; };
  await Promise.all([
    fetchJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h`)
      .then((arr: any[]) => {
        for (const c of arr || []) {
          if (c?.id && Number(c.current_price) > 0) {
            cg[c.id] = { usd: Number(c.current_price), change24h: c.price_change_percentage_24h ?? null, image: c.image ?? null };
            put(c.id, "coingecko", Number(c.current_price));
          }
        }
      })
      .catch((e) => warnOnce("cg", `⚠️ CoinGecko: ${e?.message ?? e}`)),
    ...REAL_TOKENS.flatMap((t) => [
      fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${t.okx}`)
        .then((j: any) => put(t.cg, "okx", Number(j?.data?.[0]?.last)))
        .catch((e) => warnOnce("okx" + t.okx, `⚠️ OKX ${t.okx}: ${e?.message ?? e}`)),
      fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${PAIRS[t.cg].binance}`)
        .then((j: any) => put(t.cg, "binance", Number(j?.price)))
        .catch((e) => warnOnce("bn" + t.cg, `⚠️ Binance ${t.symbol}: ${e?.message ?? e}`)),
      fetchJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${PAIRS[t.cg].bybit}`)
        .then((j: any) => put(t.cg, "bybit", Number(j?.result?.list?.[0]?.lastPrice)))
        .catch((e) => warnOnce("bb" + t.cg, `⚠️ Bybit ${t.symbol}: ${e?.message ?? e}`)),
    ]),
    Date.now() - cache.usdUzsAt > 6 * 3600_000
      ? fetchJson("https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/")
          .then((arr: any[]) => {
            const r = Number(String(arr?.[0]?.Rate ?? "").replace(",", "."));
            if (r > 1000 && r < 100000) { cache.usdUzs = r; cache.usdUzsAt = Date.now(); }
          })
          .catch((e) => warnOnce("cbu", `⚠️ CBU kursi: ${e?.message ?? e}`))
      : Promise.resolve(),
  ]);
  // 24 soatlik o'zgarish va rasm CoinGecko javob bermasa ham eskisi saqlanadi
  for (const id of Object.keys(cache.cg)) if (!cg[id]) cg[id] = { ...cache.cg[id] };
  cache = { ...cache, at: Date.now(), cg, sources };
  return cache;
}

/**
 * Bir necha manbadan ishonchli narx: mediana olinadi, undan 3% dan ko'p farq qiladigan
 * manba chetlatiladi. Ikkita manba bo'lib, ular kelishmasa - savdo to'xtatiladi.
 */
export function pickPrice(prices: number[] | number | undefined, second?: number): { usd: number | null; status: string; sources: number } {
  const list = (Array.isArray(prices) ? prices : [prices, second]).filter((x): x is number => typeof x === "number" && x > 0);
  if (!list.length) return { usd: null, status: "no_data", sources: 0 };
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const good = sorted.filter((p) => Math.abs(p - mid) / mid <= MAX_DIVERGENCE);
  if (list.length === 2 && good.length < 2) return { usd: null, status: "divergence", sources: 2 };
  if (!good.length) return { usd: null, status: "divergence", sources: list.length };
  return { usd: good.reduce((a, b) => a + b, 0) / good.length, status: "ok", sources: good.length };
}

/** Real tokenlar bazada bo'lmasa yaratadi (platforma hisobi egasi). */
export async function ensureRealTokens() {
  const owner = await pool.query("SELECT id FROM users WHERE telegram_id = -1");
  if (!owner.rows[0]) return;
  for (const t of REAL_TOKENS) {
    const ex = await pool.query("SELECT id FROM tokens WHERE oracle_id = $1", [t.cg]);
    if (ex.rows[0]) continue;
    const taken = await pool.query("SELECT 1 FROM tokens WHERE symbol = $1", [t.symbol]);
    const sym = taken.rows[0] ? t.alt : t.symbol;
    await pool.query(
      `INSERT INTO tokens (owner_id, name, symbol, max_supply, circulating_supply, base_price, current_price, curve_k,
                           is_featured, is_real, oracle_id, genesis_seeded, oracle_status)
       VALUES ($1, $2, $3, $4, 0, 1, 1, 1.5, false, true, $5, true, 'no_data')
       ON CONFLICT (symbol) DO NOTHING`,
      [owner.rows[0].id, t.name, sym, t.supply, t.cg]
    );
  }
}

/**
 * Narxlarni yangilaydi va platforma buyurtmalarini real narx atrofida qayta qo'yadi.
 * Qaytaradi: yangilangan tokenlar soni.
 */
export async function refreshRealTokens() {
  const q = await fetchQuotes();
  const nex = await getNexTradePrice();
  const nexUzs = Number(nex.price) || 1;
  const { rows: tokens } = await pool.query("SELECT id, oracle_id FROM tokens WHERE is_real = true AND is_hidden = false");
  let n = 0;
  for (const row of tokens) {
    const c = q.cg[row.oracle_id];
    const pick = pickPrice(Object.values(q.sources[row.oracle_id] ?? {}));
    await inTransaction(async (client) => {
      const t = (await client.query("SELECT * FROM tokens WHERE id = $1 FOR UPDATE", [row.id])).rows[0];
      // Avvalgi market-meyker buyurtmalarini yopamiz
      await client.query(
        "UPDATE orders SET status = 'cancelled', locked_nex = 0, updated_at = NOW() WHERE token_id = $1 AND kind = 'mm' AND status = 'open'",
        [row.id]
      );
      const fresh = pick.usd !== null;
      const lastOk = t.oracle_updated_at ? new Date(t.oracle_updated_at).getTime() : 0;
      if (!fresh) {
        // Ishonchli narx yo'q: platforma savdosi to'xtaydi (narx nazorati)
        const status = Date.now() - lastOk > STALE_MS ? "stale" : pick.status;
        await client.query("UPDATE tokens SET oracle_status = $1 WHERE id = $2", [status, row.id]);
        return { result: 0, after: () => {} };
      }
      const priceNex = round8((pick.usd! * q.usdUzs) / nexUzs);
      await client.query(
        `UPDATE tokens SET current_price = $1, oracle_usd = $2, oracle_change_24h = $3, oracle_updated_at = NOW(),
                oracle_status = 'ok', image_url = COALESCE($4, image_url)
         WHERE id = $5`,
        [priceNex, pick.usd, c?.change24h ?? null, c?.image ?? null, row.id]
      );
      await client.query("INSERT INTO price_ticks (token_id, price) VALUES ($1, $2)", [row.id, priceNex]);

      // Platforma zaxirasi: ta'minot - muomaladagi
      let inventory = floor4(Number(t.max_supply) - Number(t.circulating_supply));
      // Kitob kesishmasin: platforma sotuvi foydalanuvchilarning eng yuqori xaridi ustida,
      // platforma xaridi esa eng arzon sotuvi ostida turadi
      const ub = (await client.query(
        `SELECT MAX(price) FILTER (WHERE side = 'buy') AS bid, MIN(price) FILTER (WHERE side = 'sell') AS ask
         FROM orders WHERE token_id = $1 AND status = 'open' AND user_id IS NOT NULL`,
        [row.id]
      )).rows[0];
      const userBid = Number(ub?.bid ?? 0), userAsk = Number(ub?.ask ?? 0);
      for (const lv of LEVELS) {
        const qty = floor4(LEVEL_NEX / priceNex);
        if (qty < 0.0001) continue;
        let askPx = round8(priceNex * (1 + lv));
        let bidPx = round8(priceNex * (1 - lv));
        if (userBid > 0 && askPx <= userBid) askPx = round8(userBid * (1 + lv));
        if (userAsk > 0 && bidPx >= userAsk) bidPx = round8(userAsk * (1 - lv));
        const askQty = Math.min(qty, inventory);
        if (askQty >= 0.0001) {
          await client.query(
            "INSERT INTO orders (user_id, token_id, side, type, price, amount, kind) VALUES (NULL, $1, 'sell', 'limit', $2, $3, 'mm')",
            [row.id, askPx, askQty]
          );
          inventory = floor4(inventory - askQty);
        }
        await client.query(
          "INSERT INTO orders (user_id, token_id, side, type, price, amount, locked_nex, kind) VALUES (NULL, $1, 'buy', 'limit', $2, $3, $4, 'mm')",
          [row.id, bidPx, qty, buyerPays(qty, bidPx)]
        );
      }
      return { result: 1, after: () => {} };
    });
    n++;
  }
  return n;
}

export async function listRealTokens() {
  const { rows } = await pool.query(
    `SELECT id, name, symbol, image_url, current_price, oracle_usd, oracle_change_24h, oracle_status, oracle_updated_at
     FROM tokens WHERE is_real = true AND is_hidden = false ORDER BY id`
  );
  return rows;
}
