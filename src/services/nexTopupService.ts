import { pool } from "../db/pool";
import { recordBalanceSnapshot } from "./balanceHistoryService";
import { getNexTradePrice } from "./nexTradePriceService";

/**
 * "Nex Tradex to'ldirish / Nex Tradex Chiqarish" - avvalgi "Pul kiritish /
 * Pul chiqarish" (real bank kartalari - Humo/Uzcard/Click/Payme) o'rniga.
 *
 * MUHIM: bu yerda HECH QANDAY real to'lov amaliyoti YO'Q. Nex Trade
 * platformaning o'z ICHKI valyutasi bo'lgani uchun (real pul emas), uni
 * to'ldirish/chiqarish uchun bank litsenziyasi kerak emas - shu sabab bu
 * funksiya to'g'ridan-to'g'ri foydalanuvchi balansini o'zgartiradi.
 * Ekranda "joriy UZS narxida taxminan shuncha bo'ladi" deb ko'rsatiladi -
 * bu faqat ma'lumot uchun (nexTradePriceService dagi joriy narx asosida).
 */

export const TOPUP_MIN_AMOUNT = 2000;
export const TOPUP_PRESETS = [2000, 5000, 10000];

export const WITHDRAW_MIN_AMOUNT = 5000;
export const WITHDRAW_PRESETS = [5000, 10000, 20000];

/**
 * Frontendga: minimal miqdorlar, chiroyli tugmalar uchun tayyor summalar va
 * 1 Nex Trade ning joriy UZS qiymati.
 */
export async function getTopupWithdrawInfo() {
  const priceRow = await getNexTradePrice();
  return {
    topupMin: TOPUP_MIN_AMOUNT,
    topupPresets: TOPUP_PRESETS,
    withdrawMin: WITHDRAW_MIN_AMOUNT,
    withdrawPresets: WITHDRAW_PRESETS,
    nexTradePriceUzs: Number(priceRow.price),
  };
}

/**
 * Nex Tradex to'ldirish - eng kami 2000 Nex Trade. Hech qanday real to'lov
 * so'ralmaydi, kartadan pul yechilmaydi - shunchaki tanlangan (yoki qo'lda
 * kiritilgan, min. 2000) miqdor to'g'ridan-to'g'ri balansga qo'shiladi.
 */
export async function topupNexTradex(userId: number, amount: number) {
  if (!amount || amount < TOPUP_MIN_AMOUNT) {
    throw new Error(`Eng kami ${TOPUP_MIN_AMOUNT} Nex Tradex to'ldirish mumkin`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const userRes = await client.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (userRes.rows.length === 0) throw new Error("Foydalanuvchi topilmadi");

    const priceRow = await getNexTradePrice();
    const uzsValue = amount * Number(priceRow.price);

    const updated = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
      [amount, userId]
    );
    await recordBalanceSnapshot(userId, updated.rows[0].nex_trade_balance, client);

    await client.query(
      "INSERT INTO nex_topups (user_id, amount, uzs_value) VALUES ($1, $2, $3)",
      [userId, amount, uzsValue]
    );

    await client.query("COMMIT");
    return { newBalance: updated.rows[0].nex_trade_balance, amount, uzsValue };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Nex Tradex chiqarish - eng kami 5000 Nex Trade. Balansdan yechiladi va
 * (hozircha) real pulga aylanmaydi - faqat ichki hisobdan chiqarilgani
 * qayd etiladi (kelajakda to'lov tizimi ulanganda shu yozuvlar asosida
 * haqiqiy UZS o'tkazmasi amalga oshiriladi).
 */
export async function withdrawNexTradex(userId: number, amount: number) {
  if (!amount || amount < WITHDRAW_MIN_AMOUNT) {
    throw new Error(`Eng kami ${WITHDRAW_MIN_AMOUNT} Nex Tradex chiqarish mumkin`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const userRes = await client.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (userRes.rows.length === 0) throw new Error("Foydalanuvchi topilmadi");
    const user = userRes.rows[0];

    if (Number(user.nex_trade_balance) < amount) {
      throw new Error("Balansda yetarli Nex Trade yo'q");
    }

    const priceRow = await getNexTradePrice();
    const uzsValue = amount * Number(priceRow.price);

    const updated = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance - $1 WHERE id = $2 RETURNING nex_trade_balance",
      [amount, userId]
    );
    await recordBalanceSnapshot(userId, updated.rows[0].nex_trade_balance, client);

    await client.query(
      "INSERT INTO nex_withdrawals (user_id, amount, uzs_value) VALUES ($1, $2, $3)",
      [userId, amount, uzsValue]
    );

    await client.query("COMMIT");
    return { newBalance: updated.rows[0].nex_trade_balance, amount, uzsValue };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
