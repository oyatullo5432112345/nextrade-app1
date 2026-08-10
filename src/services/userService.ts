import { pool } from "../db/pool";
import { recordBalanceSnapshot } from "./balanceHistoryService";

// .env faylida INITIAL_BALANCE, REFERRAL_BONUS, DAILY_BONUS orqali sozlash mumkin
const INITIAL_NEX_TRADE_BALANCE = Number(process.env.INITIAL_BALANCE ?? 100);
const REFERRAL_BONUS = Number(process.env.REFERRAL_BONUS ?? 1); // taklif qilgan va qilingan foydalanuvchiga qo'shimcha bonus
const DAILY_BONUS = Number(process.env.DAILY_BONUS ?? 1); // har 24 soatda bir marta olinadigan bonus

export interface User {
  id: number;
  telegram_id: number;
  username: string | null;
  nex_trade_balance: string;
  referred_by: number | null;
}

/**
 * Foydalanuvchini topadi yoki yo'q bo'lsa, 10 ta Nex Trade balans bilan yaratadi.
 * Agar referrerTelegramId berilgan bo'lsa (referal havolasi orqali kirgan bo'lsa),
 * ikkala tomonga ham qo'shimcha REFERRAL_BONUS beriladi.
 */
export async function getOrCreateUser(
  telegramId: number,
  username?: string,
  referrerTelegramId?: number
): Promise<User> {
  const existing = await pool.query<User>(
    "SELECT * FROM users WHERE telegram_id = $1",
    [telegramId]
  );

  if (existing.rows.length > 0) {
    return { ...existing.rows[0], is_new: false } as User & { is_new: boolean };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let referrerId: number | null = null;
    if (referrerTelegramId && referrerTelegramId !== telegramId) {
      const referrer = await client.query<User>(
        "SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE",
        [referrerTelegramId]
      );
      if (referrer.rows.length > 0) {
        referrerId = referrer.rows[0].id;
        const referrerRes = await client.query(
          "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
          [REFERRAL_BONUS, referrerId]
        );
        await recordBalanceSnapshot(referrerId, referrerRes.rows[0].nex_trade_balance, client);
      }
    }

    const initialBalance =
      INITIAL_NEX_TRADE_BALANCE + (referrerId ? REFERRAL_BONUS : 0);

    const created = await client.query<User>(
      `INSERT INTO users (telegram_id, username, nex_trade_balance, referred_by, wallet_code)
       VALUES ($1, $2, $3, $4, 'NX-' || UPPER(SUBSTRING(MD5($1::text || random()::text) FROM 1 FOR 6)))
       RETURNING *`,
      [telegramId, username ?? null, initialBalance, referrerId]
    );
    await recordBalanceSnapshot(created.rows[0].id, created.rows[0].nex_trade_balance, client);

    await client.query("COMMIT");
    return { ...created.rows[0], is_new: true } as User & { is_new: boolean };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Kunlik bonusni olish. Foydalanuvchi so'nggi 24 soat ichida bonus
 * olmagan bo'lsa, balansiga DAILY_BONUS qo'shiladi. Aks holda xato qaytaradi.
 */
export async function claimDailyBonus(
  userId: number
): Promise<{ newBalance: string; bonus: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const userRes = await client.query<User & { last_daily_bonus_at: Date | null }>(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (userRes.rows.length === 0) throw new Error("Foydalanuvchi topilmadi");
    const user = userRes.rows[0];

    if (user.last_daily_bonus_at) {
      const hoursSince =
        (Date.now() - new Date(user.last_daily_bonus_at).getTime()) / (1000 * 60 * 60);
      if (hoursSince < 24) {
        const hoursLeft = Math.ceil(24 - hoursSince);
        throw new Error(`Kunlik bonusni ${hoursLeft} soatdan keyin qayta olishingiz mumkin`);
      }
    }

    const updated = await client.query<User>(
      `UPDATE users
       SET nex_trade_balance = nex_trade_balance + $1, last_daily_bonus_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [DAILY_BONUS, userId]
    );

    await client.query("COMMIT");
    await recordBalanceSnapshot(userId, updated.rows[0].nex_trade_balance);
    return { newBalance: updated.rows[0].nex_trade_balance, bonus: DAILY_BONUS };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getUserHoldings(userId: number) {
  const result = await pool.query(
    `SELECT h.token_id, t.name, t.symbol, t.image_url, h.amount, t.current_price
     FROM holdings h
     JOIN tokens t ON t.id = h.token_id
     WHERE h.user_id = $1 AND h.amount > 0`,
    [userId]
  );
  return result.rows;
}

/**
 * Admin uchun umumiy platforma statistikasi.
 */
export async function getReferralCount(userId: number): Promise<number> {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE referred_by = $1",
    [userId]
  );
  return result.rows[0].count;
}

/**
 * Eng ko'p Nex Trade balansiga ega foydalanuvchilar reytingi.
 */
export async function getUserLeaderboard(limit = 10) {
  const result = await pool.query(
    `SELECT id, username, nex_trade_balance
     FROM users
     ORDER BY nex_trade_balance DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getPlatformStats() {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM users) AS total_users,
      (SELECT COUNT(*)::int FROM tokens) AS total_tokens,
      (SELECT COALESCE(SUM(nex_trade_balance), 0) FROM users) AS total_nex_trade_circulating,
      (SELECT COUNT(*)::int FROM transactions) AS total_trades,
      (SELECT COALESCE(SUM(total_cost), 0) FROM transactions WHERE type = 'buy') AS total_volume
  `);
  return result.rows[0];
  }
