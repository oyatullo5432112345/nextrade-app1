import { pool } from "../db/pool";

const INITIAL_NEX_TRADE_BALANCE = 100;

export interface User {
  id: number;
  telegram_id: number;
  username: string | null;
  nex_trade_balance: string;
}

/**
 * Foydalanuvchini topadi yoki yo'q bo'lsa, 100 ta Nex Trade balans bilan yaratadi.
 */
export async function getOrCreateUser(
  telegramId: number,
  username?: string
): Promise<User> {
  const existing = await pool.query<User>(
    "SELECT * FROM users WHERE telegram_id = $1",
    [telegramId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const created = await pool.query<User>(
    `INSERT INTO users (telegram_id, username, nex_trade_balance)
     VALUES ($1, $2, $3) RETURNING *`,
    [telegramId, username ?? null, INITIAL_NEX_TRADE_BALANCE]
  );

  return created.rows[0];
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
