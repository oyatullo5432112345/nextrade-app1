import { pool } from "../db/pool";
import { floor4 } from "./pricingService";
import { walkBook, holdRoom } from "./orderBookService";

/**
 * 🤖 NEX AI (v11) - bozor tahlilchisi.
 *
 * Har bir token uchun real ma'lumotlardan ball hisoblanadi:
 *   • Trend (momentum)      - so'nggi soatlardagi o'rtacha narx uzoqroq o'rtachadan yuqorimi
 *   • RSI                   - haddan tashqari arzonlagan (olish imkoniyati) yoki qizib ketgan
 *   • Buyurtmalar kitobi    - xaridorlar (bids) sotuvchilardan (asks) kuchliroqmi
 *   • Kafolat (pol narx)    - narx kafolatlangan pol narxga qanchalik yaqin (pastga xavf kam)
 *   • 24 soatlik o'zgarish  - me'yoridagi o'sish yaxshi, haddan oshgan o'sish xavfli
 *   • Faollik               - savdo hajmi va egalar soni (ishonchlilik)
 * Natija: signal (Kuchli olish / Olish / Kutish / Olmang), ishonch darajasi,
 * foydalanuvchi balansiga mos tavsiya summa, maqsad narx va himoya narxi.
 *
 * Bu o'yin ichidagi algoritmik tahlil - kafolat bermaydi. Tashqi API/pul talab qilmaydi.
 */

export type Signal = "strong_buy" | "buy" | "hold" | "avoid";
type Txt = { uz: string; ru: string };

export interface TokenAnalysis {
  tokenId: number;
  symbol: string;
  name: string;
  image_url: string | null;
  isReal: boolean;
  price: number;
  score: number;          // -1 .. +1
  signal: Signal;
  confidence: number;     // 0 .. 100
  change24h: number;
  rsi: number | null;
  momentum: number;       // %
  bookImbalance: number;  // -1 .. +1
  floorPrice: number;
  volatility: number;     // soatlik, %
  targetPrice: number;
  stopPrice: number;
  canBuy: boolean;
  canSell: boolean;
  reasons: Txt[];
  factors: { key: string; label: Txt; value: number }[];
}

const CACHE_MS = 60_000;
let cache: { at: number; list: TokenAnalysis[] } = { at: 0, list: [] };
export function resetAiCache() { cache = { at: 0, list: [] }; }

const clamp = (x: number, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

function ema(values: number[], period: number) {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  if (gain + loss === 0) return 50;
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/** Bitta tokenning ma'lumotlaridan tahlil (sof funksiya - testlanadi). */
export function scoreToken(d: {
  tokenId: number; symbol: string; name: string; image_url: string | null; isReal: boolean;
  price: number; price24h: number | null; closes: number[]; volume24h: number; trades24h: number; holders: number;
  bidValue: number; askValue: number; floorPrice: number; oracleChange?: number | null;
  anyBids?: boolean; anyAsks?: boolean;
}): TokenAnalysis {
  const reasons: Txt[] = [];
  const price = d.price;
  const change24h = d.oracleChange !== undefined && d.oracleChange !== null
    ? d.oracleChange
    : d.price24h && d.price24h > 0 ? ((price - d.price24h) / d.price24h) * 100 : 0;

  // Soatlik yopilish narxlari (eng oxirgisi - joriy narx)
  const closes = [...d.closes, price].filter((x) => x > 0);
  const short = ema(closes.slice(-12), 4), long = ema(closes.slice(-48), 16);
  const momentum = long > 0 ? ((short - long) / long) * 100 : 0;
  const r = rsi(closes);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const volatility = rets.length > 2 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * 100 : 3;

  // 1) Trend
  const fMomentum = clamp(momentum / 8);
  if (momentum > 2) reasons.push({ uz: `📈 Trend yuqoriga: qisqa o'rtacha narx uzun o'rtachadan ${fmtPct(momentum)} yuqori`, ru: `📈 Тренд вверх: короткая средняя выше длинной на ${fmtPct(momentum)}` });
  else if (momentum < -2) reasons.push({ uz: `📉 Trend pastga: ${fmtPct(momentum)}`, ru: `📉 Тренд вниз: ${fmtPct(momentum)}` });

  // 2) RSI
  let fRsi = 0;
  if (r !== null) {
    fRsi = r < 30 ? clamp((30 - r) / 20) : r > 70 ? -clamp((r - 70) / 20) : 0;
    if (r < 30) reasons.push({ uz: `🧲 RSI ${r.toFixed(0)} - haddan tashqari arzonlagan, qaytish ehtimoli bor`, ru: `🧲 RSI ${r.toFixed(0)} - перепродан, возможен отскок` });
    if (r > 70) reasons.push({ uz: `🔥 RSI ${r.toFixed(0)} - qizib ketgan, tuzatish (tushish) ehtimoli bor`, ru: `🔥 RSI ${r.toFixed(0)} - перекуплен, возможна коррекция` });
  }

  // 3) Buyurtmalar kitobi
  const totalBook = d.bidValue + d.askValue;
  const bookImbalance = totalBook > 0 ? (d.bidValue - d.askValue) / totalBook : 0;
  const fBook = d.isReal ? 0 : clamp(bookImbalance * 1.2);
  if (!d.isReal && totalBook > 0) {
    if (bookImbalance > 0.25) reasons.push({ uz: `🟢 Xaridorlar kuchli: o'yinchilarning xarid buyurtmalari sotuvdan ko'p (muvozanat ${Math.round(bookImbalance * 100)}%)`, ru: `🟢 Покупатели сильнее: заявок на покупку на ${Math.round(bookImbalance * 100)}% больше` });
    if (bookImbalance < -0.25) reasons.push({ uz: `🔴 Sotuvchilar ko'p: narx bosim ostida`, ru: `🔴 Продавцов больше: давление на цену` });
  }

  // 4) Kafolat (pol narx) - pastga xavf
  let fFloor = 0;
  if (d.floorPrice > 0 && price > 0) {
    const ratio = price / d.floorPrice;
    fFloor = ratio <= 1.15 ? 1 : ratio <= 1.5 ? 0.6 : ratio <= 2.5 ? 0.25 : 0;
    reasons.push({
      uz: `🛡 Kafolatlangan pol narx ${d.floorPrice.toPrecision(3)} - narx undan atigi ${((ratio - 1) * 100).toFixed(0)}% yuqori${ratio <= 1.5 ? " (pastga xavf kam)" : ""}`,
      ru: `🛡 Гарантированная мин. цена ${d.floorPrice.toPrecision(3)} - цена выше на ${((ratio - 1) * 100).toFixed(0)}%${ratio <= 1.5 ? " (риск снижения мал)" : ""}`,
    });
  }

  // 5) 24 soatlik o'zgarish
  let fChange = 0;
  if (change24h > 80) { fChange = -0.8; reasons.push({ uz: `⚠️ 24 soatda ${fmtPct(change24h)} - juda tez o'sgan, kech qolish xavfi`, ru: `⚠️ За 24ч ${fmtPct(change24h)} - слишком быстрый рост, риск опоздать` }); }
  else if (change24h > 3) { fChange = clamp(change24h / 40, 0, 0.6); reasons.push({ uz: `✅ 24 soatda ${fmtPct(change24h)} - barqaror o'sish`, ru: `✅ За 24ч ${fmtPct(change24h)} - стабильный рост` }); }
  else if (change24h < -40) { fChange = -0.5; reasons.push({ uz: `📉 24 soatda ${fmtPct(change24h)} - kuchli tushish`, ru: `📉 За 24ч ${fmtPct(change24h)} - сильное падение` }); }
  else if (change24h < -5) { fChange = -0.2; reasons.push({ uz: `📉 24 soatda ${fmtPct(change24h)}`, ru: `📉 За 24ч ${fmtPct(change24h)}` }); }

  // 6) Faollik (ishonchlilik)
  const activity = d.isReal ? 1 : clamp(Math.log10(1 + d.trades24h) / 1.5 * 0.5 + Math.log10(1 + d.holders) / 1.5 * 0.5, 0, 1);
  if (!d.isReal && d.trades24h === 0) reasons.push({ uz: `💤 So'nggi 24 soatda savdo bo'lmagan - ma'lumot kam`, ru: `💤 За 24ч не было сделок - мало данных` });
  if (d.isReal) reasons.push({ uz: `🌍 Real kriptovalyuta - narx jahon bozoriga bog'liq`, ru: `🌍 Реальная криптовалюта - цена зависит от мирового рынка` });

  const canBuy = (d.anyAsks ?? d.askValue > 0) || d.isReal;
  const canSell = (d.anyBids ?? d.bidValue > 0) || d.isReal;
  if (!canSell && !d.isReal) reasons.push({ uz: `⚠️ Hozir xaridor yo'q - olgach sotish qiyin bo'lishi mumkin`, ru: `⚠️ Сейчас нет покупателей - продать может быть сложно` });

  let score = fMomentum * 0.25 + fRsi * 0.15 + fBook * 0.2 + fFloor * 0.15 + fChange * 0.15 + (activity - 0.5) * 0.1;
  if (!canSell && !d.isReal) score -= 0.15;
  score = clamp(score);
  const signal: Signal = score >= 0.3 ? "strong_buy" : score >= 0.1 ? "buy" : score > -0.12 ? "hold" : "avoid";
  const dataPts = Math.min(1, closes.length / 24);
  const confidence = Math.round(clamp(0.25 + activity * 0.35 + dataPts * 0.25 + Math.abs(score) * 0.3, 0, 0.95) * 100);

  const vol = clamp(volatility / 100, 0.01, 0.3);
  const targetPrice = price * (1 + Math.max(0.05, vol * 3));
  const stopPrice = Math.max(d.floorPrice, price * (1 - Math.max(0.04, vol * 2)));

  return {
    tokenId: d.tokenId, symbol: d.symbol, name: d.name, image_url: d.image_url, isReal: d.isReal,
    price, score: Math.round(score * 1000) / 1000, signal, confidence,
    change24h, rsi: r === null ? null : Math.round(r), momentum: Math.round(momentum * 10) / 10,
    bookImbalance: Math.round(bookImbalance * 100) / 100, floorPrice: d.floorPrice,
    volatility: Math.round(volatility * 10) / 10, targetPrice, stopPrice, canBuy, canSell,
    reasons: reasons.slice(0, 5),
    factors: [
      { key: "trend", label: { uz: "Trend", ru: "Тренд" }, value: Math.round(fMomentum * 100) },
      { key: "rsi", label: { uz: "RSI", ru: "RSI" }, value: Math.round(fRsi * 100) },
      { key: "book", label: { uz: "Kitob", ru: "Стакан" }, value: Math.round(fBook * 100) },
      { key: "floor", label: { uz: "Kafolat", ru: "Гарантия" }, value: Math.round(fFloor * 100) },
      { key: "change", label: { uz: "24 soat", ru: "24 часа" }, value: Math.round(fChange * 100) },
      { key: "activity", label: { uz: "Faollik", ru: "Активность" }, value: Math.round(activity * 100) },
    ],
  };
}

/** Barcha faol tokenlar tahlili (60 soniya keshlanadi). */
export async function analyzeAll(): Promise<TokenAnalysis[]> {
  if (Date.now() - cache.at < CACHE_MS) return cache.list;
  const { rows: tokens } = await pool.query(
    `SELECT t.id, t.symbol, t.name, t.image_url, t.current_price, t.floor_price, t.is_real, t.oracle_change_24h, t.oracle_status,
       COALESCE(
         (SELECT price FROM price_ticks WHERE token_id = t.id AND created_at <= NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 1),
         (SELECT price FROM transactions WHERE token_id = t.id AND tape = true AND created_at > NOW() - INTERVAL '24 hours' ORDER BY id ASC LIMIT 1),
         t.base_price) AS p24,
       (SELECT COALESCE(SUM(total_cost), 0) FROM transactions WHERE token_id = t.id AND tape = true AND created_at > NOW() - INTERVAL '24 hours') AS vol24,
       (SELECT COUNT(*)::int FROM transactions WHERE token_id = t.id AND tape = true AND created_at > NOW() - INTERVAL '24 hours') AS trades24,
       (SELECT COUNT(*)::int FROM holdings WHERE token_id = t.id AND amount > 0) AS holders
     FROM tokens t
     WHERE t.is_hidden = false AND (t.listed_at IS NULL OR t.listed_at <= NOW()) AND t.is_featured = false
       AND (t.is_real = false OR t.oracle_status = 'ok')
     ORDER BY t.is_real DESC, (SELECT MAX(created_at) FROM transactions x WHERE x.token_id = t.id) DESC NULLS LAST
     LIMIT 200`
  );
  if (!tokens.length) { cache = { at: Date.now(), list: [] }; return []; }
  const ids = tokens.map((t) => Number(t.id));
  const [closesRes, bookRes] = await Promise.all([
    pool.query(
      `SELECT token_id, floor(extract(epoch FROM created_at) / 3600) AS h, AVG(price) AS p FROM (
         SELECT token_id, price, created_at FROM price_ticks WHERE token_id = ANY($1::int[]) AND created_at > NOW() - INTERVAL '48 hours'
         UNION ALL
         SELECT token_id, price, created_at FROM transactions WHERE token_id = ANY($1::int[]) AND tape = true AND created_at > NOW() - INTERVAL '48 hours'
       ) x GROUP BY token_id, h ORDER BY token_id, h`,
      [ids]
    ),
    // Foydalanuvchilar buyurtmalari (narxdan ±10%) - talab/taklif muvozanati.
    // Platforma buyurtmalari (IPO zinapoyasi, kafolat) muvozanatga kirmaydi, lekin olish/sotish imkonini bildiradi.
    pool.query(
      `SELECT o.token_id,
         COALESCE(SUM((o.amount - o.filled) * o.price) FILTER (WHERE o.user_id IS NOT NULL AND o.side = 'buy' AND o.price >= t.current_price * 0.9), 0) AS bids,
         COALESCE(SUM((o.amount - o.filled) * o.price) FILTER (WHERE o.user_id IS NOT NULL AND o.side = 'sell' AND o.price <= t.current_price * 1.1), 0) AS asks,
         BOOL_OR(o.side = 'buy') AS any_bids, BOOL_OR(o.side = 'sell') AS any_asks
       FROM orders o JOIN tokens t ON t.id = o.token_id
       WHERE o.status = 'open' AND o.token_id = ANY($1::int[]) GROUP BY o.token_id`,
      [ids]
    ),
  ]);
  const closes = new Map<number, number[]>();
  for (const r of closesRes.rows) {
    const k = Number(r.token_id);
    if (!closes.has(k)) closes.set(k, []);
    closes.get(k)!.push(Number(r.p));
  }
  const book = new Map(bookRes.rows.map((r) => [Number(r.token_id), { bids: Number(r.bids), asks: Number(r.asks), anyBids: Boolean(r.any_bids), anyAsks: Boolean(r.any_asks) }]));
  const list = tokens.map((t) => scoreToken({
    tokenId: Number(t.id), symbol: t.symbol, name: t.name, image_url: t.image_url, isReal: t.is_real,
    price: Number(t.current_price), price24h: t.p24 === null ? null : Number(t.p24),
    closes: closes.get(Number(t.id)) ?? [], volume24h: Number(t.vol24), trades24h: t.trades24, holders: t.holders,
    bidValue: book.get(Number(t.id))?.bids ?? 0, askValue: book.get(Number(t.id))?.asks ?? 0,
    anyBids: book.get(Number(t.id))?.anyBids ?? false, anyAsks: book.get(Number(t.id))?.anyAsks ?? false,
    floorPrice: Number(t.floor_price) || 0, oracleChange: t.is_real ? (t.oracle_change_24h === null ? null : Number(t.oracle_change_24h)) : undefined,
  }));
  cache = { at: Date.now(), list };
  return list;
}

/** Foydalanuvchiga mos tavsiya summa: balansdan foiz, ishonchga ko'ra, egalik chegarasi va bozordagi taklifga sig'adigan. */
async function personalize(a: TokenAnalysis, userId: number, balance: number) {
  if (a.signal !== "strong_buy" && a.signal !== "buy") return null;
  const share = (a.signal === "strong_buy" ? 0.12 : 0.06) * (a.confidence / 100 + 0.3);
  let budget = floor4(balance * share);
  if (budget < 1) return null;
  const tok = (await pool.query("SELECT * FROM tokens WHERE id = $1", [a.tokenId])).rows[0];
  const room = (await holdRoom(pool, userId, tok)).room;
  if (room < 0.0001) return null;
  const w = await walkBook(a.tokenId, "buy", { budget, maxQty: room }, userId);
  if (w.qty < 0.0001) return null;
  // Narxni 3% dan ko'p siljitadigan summani tavsiya qilmaymiz
  if (w.worstPrice && w.bestPrice && w.worstPrice > w.bestPrice * 1.03) {
    const w2 = await walkBook(a.tokenId, "buy", { budget: budget / 2, maxQty: room }, userId);
    if (w2.qty >= 0.0001) return { nex: w2.pay, qty: w2.qty };
  }
  return { nex: w.pay, qty: w.qty };
}

/** Bosh sahifa: eng yaxshi tavsiyalar + portfeldagi tokenlar bo'yicha maslahat. */
export async function getAiPicks(userId: number) {
  const all = await analyzeAll();
  const u = await pool.query("SELECT nex_trade_balance FROM users WHERE id = $1", [userId]);
  const balance = Number(u.rows[0]?.nex_trade_balance ?? 0);
  const buys = all.filter((a) => (a.signal === "strong_buy" || a.signal === "buy") && a.canBuy)
    .sort((x, y) => y.score * y.confidence - x.score * x.confidence).slice(0, 5);
  const picks = [];
  for (const a of buys) picks.push({ ...a, suggestion: await personalize(a, userId, balance) });
  const avoid = all.filter((a) => a.signal === "avoid").sort((x, y) => x.score - y.score).slice(0, 3);

  // Portfel: foydaga chiqqanlarni sotish, xavflilaridan chiqish
  const { rows: hs } = await pool.query(
    "SELECT token_id, amount, avg_cost FROM holdings WHERE user_id = $1 AND amount > 0", [userId]
  );
  const byId = new Map(all.map((a) => [a.tokenId, a]));
  const portfolio = [];
  for (const h of hs) {
    const a = byId.get(Number(h.token_id));
    if (!a) continue;
    const cost = Number(h.avg_cost), pnl = cost > 0 ? ((a.price - cost) / cost) * 100 : 0;
    let action: "take_profit" | "cut" | "hold" | "add" = "hold";
    if (pnl >= 25 && a.signal !== "strong_buy") action = "take_profit";
    else if (a.signal === "avoid" && pnl < -10) action = "cut";
    else if (a.signal === "strong_buy") action = "add";
    portfolio.push({ tokenId: a.tokenId, symbol: a.symbol, amount: Number(h.amount), pnl: Math.round(pnl * 10) / 10, signal: a.signal, action,
      sellQty: action === "take_profit" ? floor4(Number(h.amount) / 2) : action === "cut" ? Number(h.amount) : 0 });
  }
  return { generatedAt: new Date(cache.at).toISOString(), balance, analyzed: all.length, picks, avoid, portfolio, accuracy: await getAccuracy() };
}

/** Bitta token uchun to'liq tahlil (token sahifasi). */
export async function analyzeOne(tokenId: number, userId: number) {
  const all = await analyzeAll();
  let a = all.find((x) => x.tokenId === tokenId);
  if (!a) {
    resetAiCache();
    a = (await analyzeAll()).find((x) => x.tokenId === tokenId);
  }
  if (!a) throw new Error("Bu token hozircha tahlil qilinmaydi (IPO, yashirin yoki platforma tokeni)");
  const u = await pool.query("SELECT nex_trade_balance FROM users WHERE id = $1", [userId]);
  return { ...a, suggestion: await personalize(a, userId, Number(u.rows[0]?.nex_trade_balance ?? 0)), accuracy: await getAccuracy() };
}

/** Soatda bir marta: tavsiyalarni yozib boramiz, 24 soatdan keyin natijasini tekshiramiz. */
export async function recordAndCheckPicks() {
  await pool.query(
    `UPDATE ai_picks p SET checked_price = t.current_price, checked_at = NOW()
     FROM tokens t WHERE p.token_id = t.id AND p.checked_at IS NULL AND p.created_at <= NOW() - INTERVAL '24 hours'`
  );
  const recent = await pool.query("SELECT 1 FROM ai_picks WHERE created_at > NOW() - INTERVAL '55 minutes' LIMIT 1");
  if (recent.rows.length) return 0;
  resetAiCache();
  const all = await analyzeAll();
  const top = all.filter((a) => a.signal === "strong_buy" || a.signal === "buy").sort((x, y) => y.score - x.score).slice(0, 5);
  for (const a of top) {
    await pool.query("INSERT INTO ai_picks (token_id, signal, score, price) VALUES ($1, $2, $3, $4)", [a.tokenId, a.signal, a.score, a.price]);
  }
  return top.length;
}

/** So'nggi 7 kundagi tekshirilgan tavsiyalardan necha foizi 24 soatda foyda berdi. */
export async function getAccuracy() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE checked_price > price)::int AS good,
            AVG((checked_price - price) / NULLIF(price, 0)) * 100 AS avg_pct
     FROM ai_picks WHERE checked_at IS NOT NULL AND created_at > NOW() - INTERVAL '8 days'`
  );
  const r = rows[0];
  return { checked: r.n, hitRate: r.n ? Math.round((r.good / r.n) * 100) : null, avgPct: r.avg_pct === null ? null : Math.round(Number(r.avg_pct) * 10) / 10 };
}
