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

/**
 * XATOLIK TUZATILDI: foydalanuvchi 🔔 tugmasini bosib obuna bo'lardi, lekin
 * bildirishnoma HECH QACHON yuborilmasdi - getAlertsForToken() yozilgan,
 * ammo hech qayerda chaqirilmagan edi.
 *
 * Endi har tikda (10 soniya) narxi obuna paytidagi / oxirgi xabardagi
 * narxdan threshold_pct foizdan ko'proq o'zgargan obunalar topiladi va
 * botdan xabar yuboriladi.
 */
export async function checkPriceAlerts() {
  const { rows } = await pool.query(
    `SELECT a.id, a.threshold_pct, a.last_notified_price, u.telegram_id,
            t.id AS token_id, t.name, t.symbol, t.current_price
     FROM token_alerts a
     JOIN tokens t ON t.id = a.token_id
     JOIN users u ON u.id = a.user_id
     WHERE a.last_notified_price IS NOT NULL
       AND a.last_notified_price > 0
       AND ABS(t.current_price - a.last_notified_price) / a.last_notified_price * 100 >= a.threshold_pct
     LIMIT 25`
  );
  if (rows.length === 0) return;

  const { sendTelegramMessage } = await import("../bot/bot");

  for (const r of rows) {
    const oldP = Number(r.last_notified_price);
    const newP = Number(r.current_price);
    const pct = ((newP - oldP) / oldP) * 100;
    const arrow = pct >= 0 ? "📈" : "📉";

    // Avval yangilaymiz - xabar yuborilmasa ham qayta-qayta urinib spam qilmaslik uchun
    await updateLastNotifiedPrice(r.id, newP);

    if (Number(r.telegram_id) > 0) {
      await sendTelegramMessage(
        Number(r.telegram_id),
        `${arrow} ${r.name} ($${r.symbol}) narxi ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% o'zgardi\n\n` +
          `${oldP.toFixed(4)} → ${newP.toFixed(4)}`
      );
    }
  }
}
