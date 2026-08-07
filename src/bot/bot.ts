import { pool } from "../db/pool";

const INITIAL_NEX_TRADE_BALANCE = 100;
const REFERRAL_BONUS = 20; // taklif qilgan va qilingan foydalanuvchiga qo'shimcha bonus

export interface User {
  id: number;
  telegram_id: number;
  username: string | null;
  nex_trade_balance: string;
  referred_by: number | null;
}

/**
 * Foydalanuvchini topadi yoki yo'q bo'lsa, 100 ta Nex Trade balans bilan yaratadi.
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
    return existing.rows[0];
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
        await client.query(
          "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2",
          [REFERRAL_BONUS, referrerId]
        );
      }
    }

    const initialBalance =
      INITIAL_NEX_TRADE_BALANCE + (referrerId ? REFERRAL_BONUS : 0);

    const created = await client.query<User>(
      `INSERT INTO users (telegram_id, username, nex_trade_balance, referred_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [telegramId, username ?? null, initialBalance, referrerId]
    );

    await client.query("COMMIT");
    return created.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getUserHoldings(userId: number) {
  const result = await pool.query(
    `SELECT h.token_id, t.name, t.symbol, h.amount, t.current_price
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

export const userService = {
  getOrCreateUser,
  getUserHoldings,
  getReferralCount,
  getPlatformStats,
};
