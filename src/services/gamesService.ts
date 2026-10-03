import { pool } from "../db/pool";
import { floor4, round4 } from "./pricingService";
import { recordBalanceSnapshot } from "./balanceHistoryService";
import { inTransaction } from "./orderBookService";

/**
 * O'YINLAR (v10)
 *  1) 🔮 Bashorat: "TON/NOT narxi N daqiqadan keyin oshadimi yoki tushadimi?"
 *  2) 🏁 Haftalik turnir: hamma 1000 turnir-Nex bilan teng boshlaydi, faqat TON/NOT savdosi
 *  3) 📣 Narx signallari: real token keskin o'zgarsa - faol o'yinchilarga bot xabari
 *  4) 👥 Do'stlar reytingi: siz, sizni taklif qilgan va siz taklif qilganlar
 */

type Notify = (telegramId: number, text: string) => Promise<void> | void;
const TZ = "Asia/Tashkent";

// ---------------------------------------------------------------
// 1) BASHORAT
// ---------------------------------------------------------------
export const PREDICT_MIN = Number(process.env.PREDICT_MIN ?? 10);
export const PREDICT_MAX = Number(process.env.PREDICT_MAX ?? 1000);
export const PREDICT_PAYOUT = Number(process.env.PREDICT_PAYOUT ?? 1.9); // yutganda tikilgan summa x1.9
export const PREDICT_MINUTES = [15, 60];
const PREDICT_MAX_OPEN = 5;
const FRESH_MS = 3 * 60_000;

async function realToken(tokenId: number) {
  const { rows } = await pool.query(
    "SELECT id, symbol, name, oracle_usd, oracle_status, oracle_updated_at, current_price FROM tokens WHERE id = $1 AND is_real = true AND is_hidden = false",
    [tokenId]
  );
  if (!rows[0]) throw new Error("Bashorat faqat real tokenlar (TON, NOT) uchun");
  return rows[0];
}
function isFresh(t: any) {
  return t.oracle_status === "ok" && t.oracle_updated_at && Date.now() - new Date(t.oracle_updated_at).getTime() < FRESH_MS;
}

export async function placePrediction(userId: number, tokenId: number, direction: "up" | "down", rawStake: number, minutes: number) {
  const stake = floor4(Number(rawStake));
  if (!(stake >= PREDICT_MIN && stake <= PREDICT_MAX)) throw new Error(`Tikish ${PREDICT_MIN} dan ${PREDICT_MAX} Nex gacha bo'lsin`);
  if (!PREDICT_MINUTES.includes(minutes)) throw new Error("Muddat 15 yoki 60 daqiqa bo'lsin");
  if (direction !== "up" && direction !== "down") throw new Error("Yo'nalishni tanlang");
  const t = await realToken(tokenId);
  if (!isFresh(t)) throw new Error("Narx hozir tekshirilmoqda - birozdan keyin urinib ko'ring");
  return inTransaction(async (client) => {
    const u = (await client.query("SELECT nex_trade_balance, is_banned FROM users WHERE id = $1 FOR UPDATE", [userId])).rows[0];
    if (!u || u.is_banned) throw new Error("Foydalanuvchi topilmadi");
    const open = await client.query("SELECT COUNT(*)::int AS n FROM predictions WHERE user_id = $1 AND status = 'open'", [userId]);
    if (open.rows[0].n >= PREDICT_MAX_OPEN) throw new Error(`Bir vaqtda eng ko'pi bilan ${PREDICT_MAX_OPEN} ta bashorat`);
    if (Number(u.nex_trade_balance) < stake) throw new Error("Balansda yetarli Nex yo'q");
    const b = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance - $1 WHERE id = $2 RETURNING nex_trade_balance",
      [stake, userId]
    );
    await recordBalanceSnapshot(userId, b.rows[0].nex_trade_balance, client);
    // Boshlang'ich narx - bashoratdan KEYINGI birinchi yangi narx (narx kechikishidan foydalanib bo'lmasin)
    const ins = await client.query(
      `INSERT INTO predictions (user_id, token_id, direction, stake, minutes, resolve_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($5::int * INTERVAL '1 minute')) RETURNING *`,
      [userId, tokenId, direction, stake, minutes]
    );
    return { result: { prediction: ins.rows[0], newBalance: b.rows[0].nex_trade_balance, symbol: t.symbol }, after: () => {} };
  });
}

export async function listPredictions(userId: number) {
  const { rows } = await pool.query(
    `SELECT p.*, t.symbol, t.oracle_usd AS now_price FROM predictions p JOIN tokens t ON t.id = p.token_id
     WHERE p.user_id = $1 ORDER BY p.id DESC LIMIT 20`,
    [userId]
  );
  return { items: rows, payout: PREDICT_PAYOUT, min: PREDICT_MIN, max: PREDICT_MAX, minutes: PREDICT_MINUTES };
}

/** Har daqiqada: boshlang'ich narxni yozadi va muddati kelganlarini hisoblaydi. */
export async function processPredictions(notify?: Notify) {
  // 1) boshlang'ich narx: bashoratdan keyin kelgan birinchi yangi narx
  await pool.query(
    `UPDATE predictions p SET start_price = t.oracle_usd
     FROM tokens t
     WHERE p.token_id = t.id AND p.status = 'open' AND p.start_price IS NULL
       AND t.oracle_status = 'ok' AND t.oracle_updated_at > p.created_at`
  );
  // 2) yakunlash
  const { rows } = await pool.query(
    `SELECT p.*, t.oracle_usd, t.oracle_status, t.oracle_updated_at, t.symbol, u.telegram_id
     FROM predictions p JOIN tokens t ON t.id = p.token_id JOIN users u ON u.id = p.user_id
     WHERE p.status = 'open' AND p.resolve_at <= NOW() ORDER BY p.id LIMIT 500`
  );
  let n = 0;
  for (const p of rows) {
    const fresh = p.oracle_status === "ok" && p.oracle_updated_at && new Date(p.oracle_updated_at) >= new Date(p.resolve_at);
    const tooLate = Date.now() - new Date(p.resolve_at).getTime() > 30 * 60_000;
    let status: string | null = null, payout = 0;
    if (p.start_price === null) {
      if (tooLate) { status = "refund"; payout = Number(p.stake); }
    } else if (fresh) {
      const s = Number(p.start_price), e = Number(p.oracle_usd);
      if (e === s) { status = "refund"; payout = Number(p.stake); }
      else if ((e > s) === (p.direction === "up")) { status = "won"; payout = floor4(Number(p.stake) * PREDICT_PAYOUT); }
      else status = "lost";
    } else if (tooLate) { status = "refund"; payout = Number(p.stake); }
    if (!status) continue;
    const done = await inTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE predictions SET status = $1, payout = $2, end_price = $3, resolved_at = NOW() WHERE id = $4 AND status = 'open' RETURNING id`,
        [status, payout, status === "refund" && p.start_price === null ? null : p.oracle_usd, p.id]
      );
      if (!upd.rows.length) return { result: false, after: () => {} };
      if (payout > 0) {
        const b = await client.query(
          "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
          [payout, p.user_id]
        );
        await recordBalanceSnapshot(Number(p.user_id), b.rows[0].nex_trade_balance, client);
      }
      return { result: true, after: () => {} };
    });
    if (!done) continue;
    n++;
    if (notify) {
      const dir = p.direction === "up" ? "📈 oshadi" : "📉 tushadi";
      const usd = (x: any) => `$${Number(x) < 0.01 ? Number(x).toFixed(6) : Number(x).toFixed(4)}`;
      const text = status === "won"
        ? `🔮 Bashoratingiz to'g'ri chiqdi! $${p.symbol} ${dir}: ${usd(p.start_price)} → ${usd(p.oracle_usd)}\n+${payout} Nex balansingizga qo'shildi 🎉`
        : status === "lost"
          ? `🔮 Bu safar omad kelmadi: $${p.symbol} ${usd(p.start_price)} → ${usd(p.oracle_usd)}. Yana urinib ko'ring!`
          : `🔮 $${p.symbol} bashorati bekor qilindi (narx o'zgarmadi yoki ma'lumot kelmadi) - ${p.stake} Nex qaytarildi.`;
      Promise.resolve(notify(Number(p.telegram_id), text)).catch(() => {});
    }
  }
  return n;
}

// ---------------------------------------------------------------
// 2) HAFTALIK TURNIR
// ---------------------------------------------------------------
export const TOURNAMENT_START_CASH = 1000;
export const TOURNAMENT_PRIZES = (process.env.TOURNAMENT_PRIZES ?? "3000,1500,700,300,300").split(",").map(Number).filter((x) => x > 0);
export const TOURNAMENT_MIN_TRADES = 3;
const T_FEE = 0.001;

function weekKey(offsetWeeks = 0, now = new Date()) {
  // Toshkent bo'yicha dushanba sanasi
  const t = new Date(now.getTime() + 5 * 3600_000);
  const day = (t.getUTCDay() + 6) % 7; // dushanba = 0
  const monday = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - day + offsetWeeks * 7));
  return monday.toISOString().slice(0, 10);
}
function weekEndsAt(now = new Date()) {
  const k = weekKey(1, now);
  return new Date(`${k}T00:00:00+05:00`).toISOString();
}

async function tournamentPrices() {
  const { rows } = await pool.query(
    "SELECT id, symbol, name, image_url, current_price, oracle_status, oracle_updated_at FROM tokens WHERE is_real = true AND is_hidden = false ORDER BY id"
  );
  return rows.map((r) => ({ id: Number(r.id), symbol: r.symbol, name: r.name, image_url: r.image_url, price: Number(r.current_price), fresh: isFresh(r) }));
}
function entryValue(e: any, prices: Map<string, number>) {
  let v = Number(e.cash);
  for (const [sym, qty] of Object.entries(e.holdings || {})) v += Number(qty) * (prices.get(sym) ?? 0);
  return v;
}

export async function getTournament(userId: number) {
  const wk = weekKey();
  const prices = await tournamentPrices();
  const pm = new Map(prices.map((p) => [p.symbol, p.price]));
  const { rows } = await pool.query(
    `SELECT e.*, u.username FROM tournament_entries e JOIN users u ON u.id = e.user_id WHERE e.week_key = $1`,
    [wk]
  );
  const ranked = rows
    .map((e) => ({ userId: Number(e.user_id), username: e.username, value: entryValue(e, pm), trades: e.trades, holdings: e.holdings, cash: Number(e.cash) }))
    .sort((a, b) => b.value - a.value);
  const meIdx = ranked.findIndex((r) => r.userId === userId);
  const last = await pool.query(
    `SELECT p.rank, p.reward, p.value, u.username FROM tournament_payouts p LEFT JOIN users u ON u.id = p.user_id
     WHERE p.week_key = (SELECT MAX(week_key) FROM tournament_payouts) AND p.user_id IS NOT NULL ORDER BY p.rank LIMIT 3`
  );
  return {
    weekKey: wk,
    endsAt: weekEndsAt(),
    startCash: TOURNAMENT_START_CASH,
    prizes: TOURNAMENT_PRIZES,
    minTrades: TOURNAMENT_MIN_TRADES,
    prices,
    players: ranked.length,
    top: ranked.slice(0, 10).map((r, i) => ({ rank: i + 1, username: r.username, value: round4(r.value), trades: r.trades, isMe: r.userId === userId })),
    me: meIdx >= 0 ? { rank: meIdx + 1, ...ranked[meIdx], value: round4(ranked[meIdx].value) } : null,
    lastWinners: last.rows.map((r) => ({ rank: r.rank, username: r.username, reward: Number(r.reward) })),
  };
}

export async function joinTournament(userId: number) {
  await pool.query(
    `INSERT INTO tournament_entries (week_key, user_id, cash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [weekKey(), userId, TOURNAMENT_START_CASH]
  );
  return getTournament(userId);
}

/** Turnir savdosi: buy - `amount` turnir-Nex sarflanadi; sell - `amount` ta token sotiladi. */
export async function tournamentTrade(userId: number, symbol: string, side: "buy" | "sell", rawAmount: number) {
  const wk = weekKey();
  const prices = await tournamentPrices();
  const p = prices.find((x) => x.symbol === symbol);
  if (!p) throw new Error("Turnirda faqat real tokenlar (TON, NOT)");
  if (!p.fresh || !(p.price > 0)) throw new Error("Narx hozir tekshirilmoqda - birozdan keyin urinib ko'ring");
  const amount = Number(rawAmount);
  if (!(amount > 0)) throw new Error("Miqdorni kiriting");
  return inTransaction(async (client) => {
    const e = (await client.query("SELECT * FROM tournament_entries WHERE week_key = $1 AND user_id = $2 FOR UPDATE", [wk, userId])).rows[0];
    if (!e) throw new Error("Avval turnirga qo'shiling");
    const holdings: Record<string, number> = { ...(e.holdings || {}) };
    let cash = Number(e.cash);
    let qty: number;
    if (side === "buy") {
      const spend = floor4(amount);
      if (spend > cash + 1e-9) throw new Error(`Turnir hisobingizda ${cash} Nex bor`);
      qty = Math.floor((spend * (1 - T_FEE)) / p.price * 1e6) / 1e6;
      if (!(qty > 0)) throw new Error("Summa juda kichik");
      cash = round4(cash - spend);
      holdings[symbol] = Number(((holdings[symbol] ?? 0) + qty).toFixed(6));
    } else {
      qty = Math.floor(amount * 1e6) / 1e6;
      const have = Number(holdings[symbol] ?? 0);
      if (qty > have + 1e-9) throw new Error(`Sizda ${have} ta $${symbol} bor`);
      const got = floor4(qty * p.price * (1 - T_FEE));
      cash = round4(cash + got);
      const left = Number((have - qty).toFixed(6));
      if (left > 0) holdings[symbol] = left; else delete holdings[symbol];
    }
    await client.query(
      "UPDATE tournament_entries SET cash = $1, holdings = $2, trades = trades + 1, updated_at = NOW() WHERE week_key = $3 AND user_id = $4",
      [cash, JSON.stringify(holdings), wk, userId]
    );
    return { result: { side, symbol, qty, price: p.price, cash, holdings }, after: () => {} };
  });
}

/** O'tgan hafta turnir g'oliblariga real Nex mukofot (bir marta). */
export async function payoutPreviousTournament(notify?: Notify) {
  const wk = weekKey(-1);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query("SELECT pg_try_advisory_xact_lock(778899) AS ok");
    if (!lock.rows[0].ok) { await client.query("ROLLBACK"); return 0; }
    const done = await client.query("SELECT 1 FROM tournament_payouts WHERE week_key = $1 LIMIT 1", [wk]);
    if (done.rows.length) { await client.query("ROLLBACK"); return 0; }
    const prices = new Map((await tournamentPrices()).map((p) => [p.symbol, p.price]));
    const { rows } = await client.query(
      `SELECT e.*, u.telegram_id FROM tournament_entries e JOIN users u ON u.id = e.user_id
       WHERE e.week_key = $1 AND e.trades >= $2 AND u.is_banned = false`,
      [wk, TOURNAMENT_MIN_TRADES]
    );
    const ranked = rows.map((e) => ({ e, value: entryValue(e, prices) }))
      .filter((r) => r.value > TOURNAMENT_START_CASH)
      .sort((a, b) => b.value - a.value)
      .slice(0, TOURNAMENT_PRIZES.length);
    const msgs: [number, string][] = [];
    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i], reward = TOURNAMENT_PRIZES[i];
      await client.query("INSERT INTO tournament_payouts (week_key, rank, user_id, value, reward) VALUES ($1, $2, $3, $4, $5)",
        [wk, i + 1, r.e.user_id, round4(r.value), reward]);
      const b = await client.query("UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance", [reward, r.e.user_id]);
      await recordBalanceSnapshot(Number(r.e.user_id), b.rows[0].nex_trade_balance, client);
      msgs.push([Number(r.e.telegram_id), `🏁 Haftalik turnirda ${i + 1}-o'rin! Portfel: ${round4(r.value)} turnir-Nex.\n+${reward} Nex balansingizga qo'shildi 🎉`]);
    }
    // G'olib bo'lmasa ham hafta "yopildi" deb belgilaymiz
    if (!ranked.length) await client.query("INSERT INTO tournament_payouts (week_key, rank, user_id, reward) VALUES ($1, 0, NULL, 0)", [wk]);
    await client.query("COMMIT");
    if (notify) for (const [tg, text] of msgs) Promise.resolve(notify(tg, text)).catch(() => {});
    return ranked.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------
// 3) NARX SIGNALLARI
// ---------------------------------------------------------------
export const SIGNAL_PCT = Number(process.env.SIGNAL_PCT ?? 5);
const SIGNAL_COOLDOWN_H = 3;
const SIGNAL_MAX_USERS = Number(process.env.SIGNAL_MAX_USERS ?? 500);

/** Real token oxirgi signaldan beri SIGNAL_PCT% dan ko'p o'zgarsa - faol o'yinchilarga xabar. */
export async function checkRealSignals(notify: Notify) {
  const { rows } = await pool.query(
    `SELECT t.id, t.symbol, t.name, t.oracle_usd, t.oracle_status, s.last_price, s.last_at
     FROM tokens t LEFT JOIN real_signal_state s ON s.token_id = t.id
     WHERE t.is_real = true AND t.is_hidden = false AND t.oracle_status = 'ok' AND t.oracle_usd > 0`
  );
  let sent = 0;
  for (const t of rows) {
    const price = Number(t.oracle_usd);
    if (t.last_price === null) {
      await pool.query("INSERT INTO real_signal_state (token_id, last_price) VALUES ($1, $2) ON CONFLICT (token_id) DO NOTHING", [t.id, price]);
      continue;
    }
    const last = Number(t.last_price);
    const pct = ((price - last) / last) * 100;
    if (Math.abs(pct) < SIGNAL_PCT) continue;
    if (Date.now() - new Date(t.last_at).getTime() < SIGNAL_COOLDOWN_H * 3600_000) continue;
    await pool.query("UPDATE real_signal_state SET last_price = $1, last_at = NOW() WHERE token_id = $2", [price, t.id]);
    const users = await pool.query(
      `SELECT telegram_id FROM users
       WHERE telegram_id > 0 AND signals_enabled = true AND is_banned = false AND bot_blocked = false
         AND last_seen_at > NOW() - INTERVAL '7 days'
       ORDER BY last_seen_at DESC LIMIT $1`,
      [SIGNAL_MAX_USERS]
    );
    const usd = price < 0.01 ? price.toFixed(6) : price.toFixed(3);
    const text = pct > 0
      ? `🚀 $${t.symbol} ${pct.toFixed(1)}% ko'tarildi: $${usd}\nFoydada sotasizmi yoki bashorat qilasizmi? 🔮`
      : `📉 $${t.symbol} ${Math.abs(pct).toFixed(1)}% tushdi: $${usd}\nArzon paytida olasizmi? 🛒`;
    for (const u of users.rows) {
      await Promise.resolve(notify(Number(u.telegram_id), text)).catch(() => {});
      await new Promise((r) => setTimeout(r, 40)); // Telegram cheklovi (sekundiga ~25 xabar)
      sent++;
    }
  }
  return sent;
}

export async function setSignals(userId: number, enabled: boolean) {
  await pool.query("UPDATE users SET signals_enabled = $1 WHERE id = $2", [enabled, userId]);
  return { enabled };
}

// ---------------------------------------------------------------
// 4) DO'STLAR REYTINGI (shu hafta foyda bilan sotuvlar bo'yicha)
// ---------------------------------------------------------------
export async function getFriendsLeague(userId: number) {
  const { rows } = await pool.query(
    `WITH circle AS (
       SELECT id FROM users WHERE id = $1
       UNION SELECT referred_by FROM users WHERE id = $1 AND referred_by IS NOT NULL
       UNION SELECT id FROM users WHERE referred_by = $1
     )
     SELECT u.id, u.username,
            COALESCE((SELECT SUM(t.realized_pnl) FROM transactions t
                      WHERE t.user_id = u.id AND t.type = 'sell' AND t.realized_pnl IS NOT NULL
                        AND t.created_at >= ((date_trunc('week', NOW() AT TIME ZONE '${TZ}')) AT TIME ZONE '${TZ}')::timestamp), 0) AS pnl
     FROM users u JOIN circle c ON c.id = u.id
     WHERE u.telegram_id > 0`,
    [userId]
  );
  const list = rows
    .map((r) => ({ userId: Number(r.id), username: r.username, pnl: Number(r.pnl) }))
    .sort((a, b) => b.pnl - a.pnl)
    .map((r, i) => ({ rank: i + 1, username: r.username, pnl: r.pnl, isMe: r.userId === userId }));
  return { friends: list, count: list.length - 1 };
}
