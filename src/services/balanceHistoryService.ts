import { Pool, PoolClient } from "pg";
import { pool } from "../db/pool";

/**
 * Foydalanuvchi balansi o'zgargan har bir joyda chaqiriladi (savdo, bonus,
 * komissiya va h.k.) - Portfolio grafigi shu tarixdan chiziladi.
 * Agar client berilsa (tranzaksiya ichida), o'sha client orqali yozadi -
 * aks holda umumiy pool'dan foydalanadi.
 */
export async function recordBalanceSnapshot(
  userId: number,
  newBalance: number | string,
  client?: PoolClient | Pool
) {
  const runner = client ?? pool;
  await runner.query(
    "INSERT INTO balance_history (user_id, balance) VALUES ($1, $2)",
    [userId, newBalance]
  );
}

/**
 * Portfolio grafigi uchun foydalanuvchining balans tarixini qaytaradi
 * (eskidan yangiga tartiblangan).
 */
export async function getBalanceHistory(userId: number, limit = 100) {
  const result = await pool.query(
    "SELECT balance, created_at FROM balance_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit]
  );
  return result.rows.reverse();
}
