import { pool } from "../db/pool";

/**
 * Foydalanuvchining sevimli tokenlar ro'yxatini token ma'lumotlari bilan qaytaradi.
 */
export async function getFavoriteTokens(userId: number) {
  const result = await pool.query(
    `SELECT t.* FROM favorites f
     JOIN tokens t ON t.id = f.token_id
     WHERE f.user_id = $1
     ORDER BY f.created_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Faqat token id'lari - frontendda yulduzcha holatini tez tekshirish uchun.
 */
export async function getFavoriteTokenIds(userId: number): Promise<number[]> {
  const result = await pool.query(
    "SELECT token_id FROM favorites WHERE user_id = $1",
    [userId]
  );
  return result.rows.map((r) => r.token_id);
}

/**
 * Sevimlilarga qo'shish/olib tashlash (toggle). Natija: joriy holat.
 */
export async function toggleFavorite(
  userId: number,
  tokenId: number
): Promise<{ favorited: boolean }> {
  const existing = await pool.query(
    "SELECT id FROM favorites WHERE user_id = $1 AND token_id = $2",
    [userId, tokenId]
  );

  if (existing.rows.length > 0) {
    await pool.query("DELETE FROM favorites WHERE user_id = $1 AND token_id = $2", [
      userId,
      tokenId,
    ]);
    return { favorited: false };
  }

  await pool.query(
    "INSERT INTO favorites (user_id, token_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [userId, tokenId]
  );
  return { favorited: true };
}
