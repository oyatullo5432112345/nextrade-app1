import { pool } from "../db/pool";

/**
 * Foydalanuvchining barcha bildirishnoma obunalari (token nomi bilan birga).
 */
export async function getUserAlerts(userId: number) {
  const result = await pool.query(
    `SELECT a.id, a.token_id, a.threshold_pct, t.name, t.symbol, t.current_price
     FROM token_alerts a
     JOIN tokens t ON t.id = a.token_id
     WHERE a.user_id = $1
     ORDER BY t.name ASC`,
    [userId]
  );
  return result.rows;
}

/**
 * Belgilangan token uchun obuna yaratadi yoki chegara foizini yangilaydi.
 * last_notified_price joriy narxga o'rnatiladi - shu tarzda obuna bo'lgan
 * paytdagi narxdan boshlab foiz o'zgarishi kuzatiladi.
 */
export async function subscribeAlert(
  userId: number,
  tokenId: number,
  thresholdPct: number
) {
  const tokenRes = await pool.query("SELECT current_price FROM tokens WHERE id = $1", [
    tokenId,
  ]);
  if (tokenRes.rows.length === 0) throw new Error("Token topilmadi");
  const currentPrice = tokenRes.rows[0].current_price;

  const result = await pool.query(
    `INSERT INTO token_alerts (user_id, token_id, threshold_pct, last_notified_price)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, token_id)
     DO UPDATE SET threshold_pct = $3, last_notified_price = $4
     RETURNING *`,
    [userId, tokenId, thresholdPct, currentPrice]
  );
  return result.rows[0];
}

export async function unsubscribeAlert(userId: number, tokenId: number) {
  await pool.query("DELETE FROM token_alerts WHERE user_id = $1 AND token_id = $2", [
    userId,
    tokenId,
  ]);
}

/**
 * Belgilangan token uchun barcha faol obunalarni qaytaradi - narx tebranishi
 * xizmati (priceFluctuationService) shulardan foydalanib bildirishnoma yuboradi.
 */
export async function getAlertsForToken(tokenId: number) {
  const result = await pool.query(
    `SELECT a.id, a.user_id, a.threshold_pct, a.last_notified_price, u.telegram_id
     FROM token_alerts a
     JOIN users u ON u.id = a.user_id
     WHERE a.token_id = $1`,
    [tokenId]
  );
  return result.rows;
}

export async function updateLastNotifiedPrice(alertId: number, price: number) {
  await pool.query("UPDATE token_alerts SET last_notified_price = $1 WHERE id = $2", [
    price,
    alertId,
  ]);
}
