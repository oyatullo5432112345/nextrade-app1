import { pool } from "../db/pool";
import { placeOrder, cancelOrder } from "./orderBookService";
import { floor4, round8 } from "./pricingService";

/**
 * BOT-O'YINCHILAR (v15) - ochiq belgilangan sun'iy o'yinchilar.
 *
 * Maqsad: o'yinchilar kam paytda ham bozor, reyting, klan va guruhlar "jonli" bo'lsin.
 * Halollik qoidalari:
 *  - Har bir bot nomi "🤖" bilan boshlanadi, users.is_bot = true. Savdo lentasida ham 🤖 belgisi.
 *  - Botlar HECH QANDAY mukofot olmaydi (liga, mavsum, turnir, referal) - to'lovlar faqat
 *    haqiqiy foydalanuvchilarga (telegram_id > 0). Statistikada haqiqiy odamlar alohida sanaladi.
 *  - Botlar bir-biri bilan savdo qilmaydi (soxta hajm yo'q): faqat bot bo'lmagan buyurtmalarga
 *    (IPO, haqiqiy foydalanuvchi, platforma) qarshi oladi, sotishni esa kitobga limit buyurtma
 *    qilib qo'yadi - uni faqat haqiqiy foydalanuvchi sotib oladi.
 *  - Platforma likvidligi (MM) va kafolat devoriga sotmaydi - ular haqiqiy o'yinchilar uchun.
 *
 * Iqtisod himoyasi: botlar 24 soatda jami BOT_DAILY_NEX, bitta tokenga BOT_TOKEN_DAILY_NEX dan
 * ko'p sarflamaydi; token kamida BOT_MIN_AGE_HOURS soatlik va BOT_MIN_HOLDERS ta haqiqiy egali bo'lishi kerak
 * (yaratuvchi botlarni o'z tokeniga "sog'ib" ololmasin).
 */

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function botConfig() {
  return {
    enabled: (process.env.BOT_PLAYERS_ENABLED ?? "true").toLowerCase() !== "false",
    count: Math.min(500, Math.max(0, Math.floor(num(process.env.BOT_PLAYERS, 150)))),
    actionsPerTick: Math.max(1, Math.floor(num(process.env.BOT_ACTIONS_PER_TICK, 6))),
    startNex: num(process.env.BOT_START_NEX, 3000),
    dailyNex: num(process.env.BOT_DAILY_NEX, 8000),
    tokenDailyNex: num(process.env.BOT_TOKEN_DAILY_NEX, 250),
    minAgeHours: num(process.env.BOT_MIN_AGE_HOURS, 3),
    minHolders: num(process.env.BOT_MIN_HOLDERS, 2),
  };
}

export const BOT_TG_BASE = -1_000_000; // bot telegram_id = BOT_TG_BASE - i (haqiqiy ID doim musbat)

const NAMES = [
  "Sardor", "Jasur", "Bekzod", "Aziz", "Dilshod", "Sherzod", "Jamshid", "Otabek", "Ulug'bek", "Shoxrux",
  "Bobur", "Doston", "Farrux", "Islom", "Javlon", "Kamron", "Lazizbek", "Mirjalol", "Nodir", "Oybek",
  "Po'lat", "Rustam", "Sanjar", "Temur", "Umid", "Xurshid", "Yusuf", "Zafar", "Abdulla", "Akmal",
  "Dilnoza", "Madina", "Malika", "Nigora", "Sevara", "Shahnoza", "Zarina", "Kamola", "Gulnoza", "Feruza",
  "Mohira", "Nilufar", "Laylo", "Munisa", "Robiya", "Sabina", "Iroda", "Charos", "Durdona", "E'zoza",
];
const TAILS = ["", "_trader", "_invest", "_pro", "_kit", "_uz", "_crypto", "_bull", "_hodl", "_x"];
const STYLES = ["trend", "arzon", "aralash"] as const;

export const BOT_CLANS = [
  { name: "🤖 Robo Lochinlar", tag: "RLOCH" },
  { name: "🤖 Robo Burgutlar", tag: "RBURG" },
  { name: "🤖 Robo Sherlar", tag: "RSHER" },
  { name: "🤖 Robo Bo'rilar", tag: "RBORI" },
  { name: "🤖 Robo Qoplonlar", tag: "RQOPL" },
  { name: "🤖 Robo Shunqorlar", tag: "RSHUN" },
];
export const BOT_GROUPS = [
  { id: -990_000_000_001, title: "🤖 Bot guruhi: Toshkent treyderlari" },
  { id: -990_000_000_002, title: "🤖 Bot guruhi: Samarqand birjasi" },
  { id: -990_000_000_003, title: "🤖 Bot guruhi: Farg'ona investorlari" },
  { id: -990_000_000_004, title: "🤖 Bot guruhi: Buxoro kitlari" },
];
const CLAN_BOTS = 12; // har bot-klanda nechta bot (haqiqiy o'yinchilarga ham joy qoladi)

export function botName(i: number) {
  const base = NAMES[i % NAMES.length];
  const tail = TAILS[Math.floor(i / NAMES.length) % TAILS.length];
  const n = Math.floor(i / (NAMES.length * TAILS.length));
  return `🤖 ${base}${tail}${n ? n + 1 : ""}`;
}

/** Botlarni, bot-klanlarni va bot-guruhlarni yaratadi (bor bo'lsa - tegmaydi). */
export async function ensureBotPlayers() {
  const cfg = botConfig();
  if (!cfg.enabled || cfg.count === 0) return 0;
  const have = (await pool.query("SELECT COUNT(*)::int n FROM users WHERE is_bot = true")).rows[0].n as number;
  let created = 0;
  for (let i = have; i < cfg.count; i++) {
    const r = await pool.query(
      `INSERT INTO users (telegram_id, username, nex_trade_balance, is_bot, last_seen_at, created_at)
       VALUES ($1, $2, $3, true, NOW(), NOW() - (random() * INTERVAL '20 days'))
       ON CONFLICT (telegram_id) DO NOTHING RETURNING id`,
      [BOT_TG_BASE - i, botName(i), cfg.startNex]
    );
    if (r.rows.length) created++;
  }
  // Bot-guruhlar (reklama yuborilmaydi: is_active = false, is_bot = true)
  for (const g of BOT_GROUPS) {
    await pool.query(
      `INSERT INTO promo_chats (chat_id, title, chat_type, is_active, interval_minutes, is_bot)
       VALUES ($1, $2, 'supergroup', false, 10080, true) ON CONFLICT (chat_id) DO NOTHING`,
      [g.id, g.title]
    );
  }
  const bots = (await pool.query("SELECT id, clan_id, group_chat_id FROM users WHERE is_bot = true ORDER BY id")).rows;
  // Bot-klanlar
  for (let c = 0; c < BOT_CLANS.length; c++) {
    const members = bots.slice(c * CLAN_BOTS, (c + 1) * CLAN_BOTS);
    if (!members.length) break;
    let clan = (await pool.query("SELECT id, owner_id FROM clans WHERE tag = $1", [BOT_CLANS[c].tag])).rows[0];
    if (!clan) {
      clan = (await pool.query(
        "INSERT INTO clans (name, tag, owner_id) VALUES ($1, $2, $3) ON CONFLICT (tag) DO NOTHING RETURNING id, owner_id",
        [BOT_CLANS[c].name, BOT_CLANS[c].tag, members[0].id]
      )).rows[0];
    }
    if (!clan) continue;
    const owner = (await pool.query("SELECT is_bot FROM users WHERE id = $1", [clan.owner_id])).rows[0];
    if (!owner?.is_bot) continue; // shu belgi bilan haqiqiy o'yinchining klani bor - tegmaymiz
    const ids = members.filter((m: any) => !m.clan_id).map((m: any) => m.id);
    if (ids.length) await pool.query("UPDATE users SET clan_id = $1 WHERE id = ANY($2::int[])", [clan.id, ids]);
  }
  // Guruhlar ligasi: botlar bot-guruhlarga taqsimlanadi
  for (let k = 0; k < bots.length; k++) {
    if (bots[k].group_chat_id) continue;
    await pool.query("UPDATE users SET group_chat_id = $1 WHERE id = $2", [BOT_GROUPS[k % BOT_GROUPS.length].id, bots[k].id]);
  }
  if (created) console.log(`🤖 ${created} ta bot-o'yinchi yaratildi`);
  return created;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

/** Botlar 24 soatda (umuman yoki bitta tokenga) qancha Nex sarflagan. */
async function botSpent24h(tokenId: number | null) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(t.total_cost), 0) AS v FROM transactions t JOIN users u ON u.id = t.user_id
     WHERE u.is_bot = true AND t.type = 'buy' AND t.created_at > NOW() - INTERVAL '24 hours'
       AND ($1::int IS NULL OR t.token_id = $1)`,
    [tokenId]
  );
  return Number(rows[0].v);
}

/** Botlar savdo qilishi mumkin bo'lgan tokenlar (24 soatlik o'zgarish bilan). */
async function eligibleTokens() {
  const cfg = botConfig();
  const { rows } = await pool.query(
    `SELECT t.id, t.symbol, t.is_real, t.current_price,
            (SELECT p.price FROM price_ticks p WHERE p.token_id = t.id AND p.created_at <= NOW() - INTERVAL '24 hours'
               ORDER BY p.created_at DESC LIMIT 1) AS p24
     FROM tokens t JOIN users o ON o.id = t.owner_id
     WHERE t.is_hidden = false AND (t.listed_at IS NULL OR t.listed_at <= NOW()) AND o.is_bot = false
       AND ((t.is_real = true AND t.oracle_status = 'ok')
         OR (t.is_real = false
             AND t.created_at <= NOW() - make_interval(secs => $1::float8 * 3600)
             AND (SELECT COUNT(*) FROM holdings h JOIN users hu ON hu.id = h.user_id
                  WHERE h.token_id = t.id AND h.amount > 0 AND hu.is_bot = false AND hu.telegram_id > 0) >= $2))`,
    [cfg.minAgeHours, cfg.minHolders]
  );
  return rows.map((r: any) => {
    const p = Number(r.current_price), p24 = Number(r.p24 ?? 0);
    return { id: Number(r.id), symbol: r.symbol as string, isReal: Boolean(r.is_real), price: p, change: p24 > 0 ? (p - p24) / p24 : 0 };
  });
}

/** Eng arzon BOT BO'LMAGAN sotuvchi (IPO, haqiqiy foydalanuvchi yoki platforma). Eng arzoni bot bo'lsa - null. */
async function bestNonBotAsk(tokenId: number) {
  const { rows } = await pool.query(
    `SELECT o.price, o.amount - o.filled AS rem, COALESCE(u.is_bot, false) AS bot
     FROM orders o LEFT JOIN users u ON u.id = o.user_id
     WHERE o.token_id = $1 AND o.side = 'sell' AND o.status = 'open' ORDER BY o.price ASC, o.id ASC LIMIT 1`,
    [tokenId]
  );
  const r = rows[0];
  if (!r || r.bot) return null;
  return { price: Number(r.price), rem: Number(r.rem) };
}

/** Bitta botning bitta harakati. Qaytaradi: nima qilingani (yoki null). */
export async function botAct(bot: { id: number; idx: number }, tokens: Awaited<ReturnType<typeof eligibleTokens>>, budgetLeft: number) {
  const cfg = botConfig();
  const u = (await pool.query("SELECT nex_trade_balance FROM users WHERE id = $1", [bot.id])).rows[0];
  let balance = Number(u?.nex_trade_balance ?? 0);
  if (balance < cfg.startNex * 0.1) {
    // Bot "hamyoni" to'ldiriladi - umumiy sarf limiti baribir cheklaydi
    await pool.query("UPDATE users SET nex_trade_balance = $1 WHERE id = $2", [cfg.startNex, bot.id]);
    balance = cfg.startNex;
  }
  await pool.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1", [bot.id]);

  // 1) Sotuvga qo'yish: foydada bo'lsa yoki tasodifan - narxdan yuqoriroqqa limit buyurtma
  const holds = (await pool.query(
    `SELECT h.token_id, h.amount, h.avg_cost, t.current_price FROM holdings h JOIN tokens t ON t.id = h.token_id
     WHERE h.user_id = $1 AND h.amount > 0 AND t.is_hidden = false`,
    [bot.id]
  )).rows;
  const openSells = Number((await pool.query(
    "SELECT COUNT(*)::int n FROM orders WHERE user_id = $1 AND side = 'sell' AND status = 'open'", [bot.id]
  )).rows[0].n);
  if (holds.length && openSells < 3 && Math.random() < 0.4) {
    const h = pick(holds);
    const cur = Number(h.current_price), cost = Number(h.avg_cost) || cur;
    const pnl = cost > 0 ? (cur - cost) / cost : 0;
    const share = pnl > 0.08 ? rnd(0.5, 1) : rnd(0.15, 0.4);
    const qty = floor4(Number(h.amount) * share);
    const price = round8(Math.max(cur, cost) * (1 + rnd(0.02, 0.09)));
    if (qty >= 0.0001 && qty * price >= 0.01) {
      try {
        await placeOrder({ userId: bot.id, tokenId: Number(h.token_id), side: "sell", type: "limit", amount: qty, price });
        return { action: "sell_limit", tokenId: Number(h.token_id), qty, price };
      } catch { /* chegaradan oshsa - keyingi safar */ }
    }
  }

  // 2) Sotib olish: uslubga qarab token tanlanadi
  if (!tokens.length || budgetLeft < 1) return null;
  const style = STYLES[bot.idx % STYLES.length];
  let pool2 = tokens;
  if (style === "trend") pool2 = tokens.filter((t) => t.change >= 0);
  if (style === "arzon") pool2 = tokens.filter((t) => t.change <= 0);
  if (!pool2.length) pool2 = tokens;
  const tok = pick(pool2);
  const ask = await bestNonBotAsk(tok.id);
  // Juda qimmat qo'yilgan sotuvni olmaydi (botlarni qimmatga "sog'ib" bo'lmasin)
  if (!ask || ask.price > tok.price * 1.05) return null;
  const tokenLeft = cfg.tokenDailyNex - (await botSpent24h(tok.id));
  const spend = Math.min(balance * rnd(0.02, 0.08), tokenLeft, budgetLeft, ask.price * ask.rem * 1.0025);
  const qty = floor4(spend / (ask.price * 1.0025));
  if (qty < 0.0001 || qty * ask.price < 0.01) return null;
  try {
    // Faqat shu eng arzon (bot bo'lmagan) narx darajasiga qarshi; qolgani kitobda turmaydi
    const r = await placeOrder({ userId: bot.id, tokenId: tok.id, side: "buy", type: "limit", amount: qty, price: ask.price });
    if (r.status === "open") await cancelOrder(bot.id, r.orderId).catch(() => {});
    return r.filled > 0 ? { action: "buy", tokenId: tok.id, qty: r.filled, price: r.avgPrice } : null;
  } catch {
    return null;
  }
}

/** 2 soatdan eski bot sotuv buyurtmalarini yopadi (kitob eskirgan narxlar bilan to'lmasin). */
async function expireBotOrders() {
  const { rows } = await pool.query(
    `SELECT o.id, o.user_id FROM orders o JOIN users u ON u.id = o.user_id
     WHERE u.is_bot = true AND o.status = 'open' AND o.created_at < NOW() - INTERVAL '2 hours' LIMIT 50`
  );
  for (const r of rows) await cancelOrder(Number(r.user_id), Number(r.id)).catch(() => {});
  return rows.length;
}

/** Fon vazifasi: bir nechta tasodifiy bot harakat qiladi. */
export async function runBotPlayers() {
  const cfg = botConfig();
  if (!cfg.enabled) return 0;
  await expireBotOrders();
  const bots = (await pool.query(
    `SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS idx FROM users
     WHERE is_bot = true AND is_banned = false ORDER BY random() LIMIT $1`,
    [cfg.actionsPerTick]
  )).rows;
  if (!bots.length) return 0;
  const tokens = await eligibleTokens();
  let done = 0;
  for (const b of bots) {
    const left = cfg.dailyNex - (await botSpent24h(null));
    const r = await botAct({ id: Number(b.id), idx: Number(b.idx) }, tokens, left).catch(() => null);
    if (r) done++;
  }
  return done;
}

/** Statistikada: haqiqiy o'yinchilar va botlar alohida. */
export async function getPlayerCounts() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE telegram_id > 0)::int AS real,
            COUNT(*) FILTER (WHERE is_bot = true)::int AS bots,
            COUNT(*) FILTER (WHERE telegram_id > 0 AND last_seen_at > NOW() - INTERVAL '24 hours')::int AS real_active,
            COUNT(*) FILTER (WHERE is_bot = true AND last_seen_at > NOW() - INTERVAL '24 hours')::int AS bots_active
     FROM users`
  );
  return rows[0] as { real: number; bots: number; real_active: number; bots_active: number };
}
