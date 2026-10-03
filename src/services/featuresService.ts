import crypto from "crypto";
import { pool } from "../db/pool";
import { recordBalanceSnapshot } from "./balanceHistoryService";
import { containsBadWords } from "./moderationService";

/**
 * v4 FUNKSIYALARI
 *  1) Omad g'ildiragi (kuniga 1 marta)
 *  2) Darajalar va nishonlar
 *  3) Token izohlari
 *  4) Limit buyurtmalar
 *  5) Telegram Stars (PRO nishon, 24 soatlik reklama)
 */

const TZ = "Asia/Tashkent";

// ---------------- 1) OMAD G'ILDIRAGI ----------------

// [mukofot, og'irlik]. O'rtacha ~33 Nex.
export const WHEEL_PRIZES: [number, number][] = [
  [5, 30],
  [10, 25],
  [20, 20],
  [50, 13],
  [100, 8],
  [250, 3],
  [500, 1],
];

function pickPrizeIndex(): number {
  const total = WHEEL_PRIZES.reduce((s, [, w]) => s + w, 0);
  let r = crypto.randomInt(total);
  for (let i = 0; i < WHEEL_PRIZES.length; i++) {
    r -= WHEEL_PRIZES[i][1];
    if (r < 0) return i;
  }
  return 0;
}

export async function getWheelStatus(userId: number) {
  const { rows } = await pool.query(
    `SELECT (last_spin_at IS NOT NULL AND
             (last_spin_at::timestamptz AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date) AS spun_today,
            ((date_trunc('day', NOW() AT TIME ZONE '${TZ}') + INTERVAL '1 day') AT TIME ZONE '${TZ}') AS next_at
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows[0]) throw new Error("Foydalanuvchi topilmadi");
  return {
    canSpin: !rows[0].spun_today,
    nextAt: rows[0].next_at,
    prizes: WHEEL_PRIZES.map(([p]) => p),
  };
}

export async function spinWheel(userId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT (last_spin_at IS NOT NULL AND
               (last_spin_at::timestamptz AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date) AS spun_today
       FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (!rows[0]) throw new Error("Foydalanuvchi topilmadi");
    if (rows[0].spun_today) throw new Error("Bugun g'ildirak aylantirilgan. Ertaga qayta urinib ko'ring! 🎡");

    const index = pickPrizeIndex();
    const reward = WHEEL_PRIZES[index][0];
    const upd = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance + $1, last_spin_at = NOW() WHERE id = $2 RETURNING nex_trade_balance",
      [reward, userId]
    );
    await client.query("INSERT INTO wheel_spins (user_id, reward) VALUES ($1, $2)", [userId, reward]);
    await recordBalanceSnapshot(userId, upd.rows[0].nex_trade_balance, client);
    await client.query("COMMIT");
    return { index, reward, newBalance: upd.rows[0].nex_trade_balance };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------- 2) DARAJALAR VA NISHONLAR ----------------

interface Badge { id: string; emoji: string; title: string; desc: string; }
const BADGES: (Badge & { test: (s: any) => boolean })[] = [
  { id: "first_trade", emoji: "🎯", title: "Birinchi qadam", desc: "Birinchi savdo", test: (s) => s.trades >= 1 },
  { id: "trader_10", emoji: "📊", title: "Treyder", desc: "10 ta savdo", test: (s) => s.trades >= 10 },
  { id: "trader_100", emoji: "💹", title: "Birja bo'risi", desc: "100 ta savdo", test: (s) => s.trades >= 100 },
  { id: "creator", emoji: "🛠️", title: "Yaratuvchi", desc: "Token yaratish", test: (s) => s.created >= 1 },
  { id: "pro", emoji: "💎", title: "PRO", desc: "PRO tokenga ega bo'lish", test: (s) => s.pro >= 1 },
  { id: "whale", emoji: "🐳", title: "Kit", desc: "10 000 Nex balans", test: (s) => s.balance >= 10000 },
  { id: "streak_7", emoji: "🔥", title: "Olov", desc: "7 kunlik seriya", test: (s) => s.maxStreak >= 7 },
  { id: "streak_30", emoji: "☄️", title: "Temir iroda", desc: "30 kunlik seriya", test: (s) => s.maxStreak >= 30 },
  { id: "inviter", emoji: "👥", title: "Sardor", desc: "5 ta do'st taklif qilish", test: (s) => s.referrals >= 5 },
  { id: "champion", emoji: "🏆", title: "Chempion", desc: "Ligada top-3", test: (s) => s.podiums >= 1 },
  { id: "season", emoji: "👑", title: "Mavsum qahramoni", desc: "Oylik mavsumda top-3", test: (s) => s.seasons >= 1 },
  { id: "clan", emoji: "🛡️", title: "Jamoa", desc: "Klanga a'zo bo'lish", test: (s) => s.clan >= 1 },
];

export async function getAchievements(userId: number) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM transactions WHERE user_id = $1) AS trades,
       (SELECT COUNT(*)::int FROM tokens WHERE owner_id = $1) AS created,
       (SELECT COUNT(*)::int FROM tokens WHERE owner_id = $1 AND is_pro) AS pro,
       (SELECT COUNT(*)::int FROM users WHERE referred_by = $1 AND referral_rewarded) AS referrals,
       (SELECT COUNT(*)::int FROM league_payouts WHERE user_id = $1 AND rank BETWEEN 1 AND 3) AS podiums,
       (SELECT COUNT(*)::int FROM wheel_spins WHERE user_id = $1) AS spins,
       (SELECT COUNT(*)::int FROM season_results WHERE user_id = $1 AND rank BETWEEN 1 AND 3) AS seasons,
       (CASE WHEN u.clan_id IS NOT NULL THEN 1 ELSE 0 END) AS clan,
       u.max_streak, u.daily_streak, u.nex_trade_balance
     FROM users u WHERE u.id = $1`,
    [userId]
  );
  const r = rows[0];
  if (!r) throw new Error("Foydalanuvchi topilmadi");
  const s = {
    trades: r.trades,
    created: r.created,
    pro: r.pro,
    referrals: r.referrals,
    podiums: r.podiums,
    seasons: r.seasons,
    clan: r.clan,
    maxStreak: Math.max(Number(r.max_streak), Number(r.daily_streak)),
    balance: Number(r.nex_trade_balance),
  };
  // Tajriba (XP): faollik uchun ochko
  const xp = s.trades * 10 + s.created * 50 + s.referrals * 100 + s.maxStreak * 20 + s.podiums * 300 + s.seasons * 1000 + r.spins * 5;
  // Daraja: har keyingi daraja ko'proq XP talab qiladi (100, 400, 900, ...)
  const level = Math.floor(Math.sqrt(xp / 100)) + 1;
  const curLevelXp = (level - 1) ** 2 * 100;
  const nextLevelXp = level ** 2 * 100;
  return {
    xp,
    level,
    progress: (xp - curLevelXp) / (nextLevelXp - curLevelXp),
    nextLevelXp,
    badges: BADGES.map(({ test, ...b }) => ({ ...b, earned: test(s) })),
  };
}

// ---------------- 3) TOKEN IZOHLARI ----------------

const COMMENT_COOLDOWN_SEC = 15;

export async function listComments(tokenId: number, limit = 50) {
  const { rows } = await pool.query(
    `SELECT c.id, c.text, c.created_at, c.user_id, u.username, (t.owner_id = c.user_id) AS is_creator
     FROM token_comments c
     JOIN users u ON u.id = c.user_id
     JOIN tokens t ON t.id = c.token_id
     WHERE c.token_id = $1 AND c.is_deleted = false AND u.is_banned = false
     ORDER BY c.created_at DESC LIMIT $2`,
    [tokenId, limit]
  );
  return rows;
}

export async function addComment(userId: number, tokenId: number, rawText: string) {
  const text = rawText.replace(/\s+/g, " ").trim().slice(0, 280);
  if (text.length < 1) throw new Error("Izoh bo'sh bo'lmasin");
  if (containsBadWords(text)) throw new Error("Izohda nomaqbul so'zlar bor. Iltimos, madaniyatli yozing 🙏");

  const tok = await pool.query("SELECT is_hidden FROM tokens WHERE id = $1", [tokenId]);
  if (!tok.rows[0] || tok.rows[0].is_hidden) throw new Error("Token topilmadi");

  const recent = await pool.query(
    `SELECT 1 FROM token_comments WHERE user_id = $1 AND created_at > NOW() - ($2::int * INTERVAL '1 second') LIMIT 1`,
    [userId, COMMENT_COOLDOWN_SEC]
  );
  if (recent.rows.length) throw new Error(`Juda tez yozyapsiz. ${COMMENT_COOLDOWN_SEC} soniya kuting`);

  const { rows } = await pool.query(
    "INSERT INTO token_comments (token_id, user_id, text) VALUES ($1, $2, $3) RETURNING id, text, created_at",
    [tokenId, userId, text]
  );
  return rows[0];
}

// 4) Limit buyurtmalar v8 dan boshlab order book'da: orderBookService.ts

// ---------------- 5) TELEGRAM STARS ----------------

export const STARS_PRO_PRICE = Number(process.env.STARS_PRO_PRICE ?? 50);
export const STARS_PROMO_PRICE = Number(process.env.STARS_PROMO_PRICE ?? 25);
export type StarsKind = "pro" | "promo";

export function starsPrices() {
  return { pro: STARS_PRO_PRICE, promo: STARS_PROMO_PRICE };
}

/** To'lovdan oldin tekshiruv: token bor, egasi shu foydalanuvchi, PRO bo'lmagan. */
export async function validateStarsPurchase(kind: StarsKind, tokenId: number, userId: number) {
  const { rows } = await pool.query("SELECT id, name, symbol, owner_id, is_pro, is_hidden FROM tokens WHERE id = $1", [tokenId]);
  const t = rows[0];
  if (!t || t.is_hidden) throw new Error("Token topilmadi");
  if (Number(t.owner_id) !== userId) throw new Error("Faqat token yaratuvchisi sotib ola oladi");
  if (kind === "pro" && t.is_pro) throw new Error("Bu token allaqachon PRO");
  return t;
}

export function buildPayload(kind: StarsKind, tokenId: number, userId: number) {
  return `${kind}:${tokenId}:${userId}`;
}

export function parsePayload(payload: string) {
  const [kind, tokenId, userId] = payload.split(":");
  if ((kind !== "pro" && kind !== "promo") || !Number(tokenId) || !Number(userId)) return null;
  return { kind: kind as StarsKind, tokenId: Number(tokenId), userId: Number(userId) };
}

/** Muvaffaqiyatli to'lovdan keyin. charge_id UNIQUE - takror kelsa qayta qo'llanmaydi. */
export async function applyStarsPayment(payload: string, chargeId: string, stars: number, payerTelegramId: number) {
  const p = parsePayload(payload);
  if (!p) throw new Error("Noto'g'ri to'lov ma'lumoti");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("SELECT id FROM users WHERE id = $1 AND telegram_id = $2", [p.userId, payerTelegramId]);
    if (!u.rows[0]) throw new Error("To'lovchi mos kelmadi");
    const ins = await client.query(
      `INSERT INTO stars_payments (user_id, token_id, kind, stars, charge_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (charge_id) DO NOTHING RETURNING id`,
      [p.userId, p.tokenId, p.kind, stars, chargeId]
    );
    if (ins.rows.length === 0) {
      await client.query("COMMIT");
      return { already: true, kind: p.kind };
    }
    if (p.kind === "pro") {
      await client.query("UPDATE tokens SET is_pro = true, pro_since = NOW() WHERE id = $1", [p.tokenId]);
    } else {
      await client.query(
        "UPDATE tokens SET promoted_until = GREATEST(COALESCE(promoted_until, NOW()), NOW()) + INTERVAL '24 hours' WHERE id = $1",
        [p.tokenId]
      );
    }
    const t = await client.query("SELECT name, symbol FROM tokens WHERE id = $1", [p.tokenId]);
    await client.query("COMMIT");
    return { already: false, kind: p.kind, token: t.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
