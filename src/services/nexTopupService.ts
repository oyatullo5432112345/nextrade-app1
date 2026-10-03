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

// Bepul to'ldirish cheksiz bo'lsa, istalgan odam balansini millionlarga
// chiqarib, reyting va butun iqtisodni buzib yuboradi. Shuning uchun 24 soat
// ichida jami to'ldirish chegarasi qo'yildi (.env: TOPUP_DAILY_LIMIT, 0 = cheksiz).
export const TOPUP_DAILY_LIMIT = Number(process.env.TOPUP_DAILY_LIMIT ?? 10000);

export const WITHDRAW_MIN_AMOUNT = 5000;

// v10: bepul to'ldirish o'chiq (faqat lokal sinov uchun yoqish mumkin)
export const TOPUP_FREE_ENABLED = process.env.TOPUP_FREE_ENABLED === "true";
// Mablag' chiqarish ochiladigan sana (Toshkent vaqti)
export const WITHDRAW_OPENS_AT = new Date(`${process.env.WITHDRAW_OPEN_DATE ?? "2026-12-08"}T00:00:00+05:00`);
const UZ_MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
export function withdrawOpenLabel() {
  const d = new Date(WITHDRAW_OPENS_AT.getTime() + 5 * 3600_000);
  return `${d.getUTCDate()}-${UZ_MONTHS[d.getUTCMonth()]}`;
}
// 1 ⭐ = shuncha Nex (do'kondagi asosiy paket narxi bo'yicha)
export const NEX_PER_STAR = 100;

/** Chiqarish oynasi uchun kurslar: 1 birlik = necha Nex. */
export async function getWithdrawInfo() {
  const nex = await getNexTradePrice();
  const nexUzs = Number(nex.price) || 1;
  const { rows } = await pool.query(
    "SELECT symbol, current_price, oracle_usd, image_url FROM tokens WHERE is_real = true AND is_hidden = false AND oracle_status = 'ok'"
  );
  const usdUzs = rows.length && Number(rows[0].oracle_usd) > 0
    ? (Number(rows[0].current_price) * nexUzs) / Number(rows[0].oracle_usd)
    : Number(process.env.USD_UZS_FALLBACK ?? 12800);
  const options = [
    { code: "STARS", label: "⭐ Telegram Stars", nexPerUnit: NEX_PER_STAR, decimals: 0 },
    { code: "USD", label: "💵 USD (USDT)", nexPerUnit: usdUzs / nexUzs, decimals: 2 },
    ...rows.map((r) => ({ code: r.symbol, label: r.symbol === "TON" ? "💎 Toncoin (TON)" : `🪙 ${r.symbol}`, nexPerUnit: Number(r.current_price), decimals: r.symbol === "TON" ? 4 : 2, image: r.image_url })),
  ];
  return { opensAt: WITHDRAW_OPENS_AT.toISOString(), opensLabel: withdrawOpenLabel(), open: Date.now() >= WITHDRAW_OPENS_AT.getTime(), minNex: WITHDRAW_MIN_AMOUNT, options };
}
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
    topupDailyLimit: TOPUP_DAILY_LIMIT,
    nexTradePriceUzs: Number(priceRow.price),
  };
}

/**
 * Nex Tradex to'ldirish - eng kami 2000 Nex Trade. Hech qanday real to'lov
 * so'ralmaydi, kartadan pul yechilmaydi - shunchaki tanlangan (yoki qo'lda
 * kiritilgan, min. 2000) miqdor to'g'ridan-to'g'ri balansga qo'shiladi.
 */
export async function topupNexTradex(userId: number, amount: number) {
  // v10: bepul to'ldirish butunlay o'chirildi - Nex endi Telegram Stars orqali sotib olinadi
  if (!TOPUP_FREE_ENABLED) throw new Error("Bepul to'ldirish o'chirilgan. Nex'ni ⭐ Telegram Stars orqali sotib oling");
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

    if (TOPUP_DAILY_LIMIT > 0) {
      const usedRes = await client.query(
        "SELECT COALESCE(SUM(amount), 0) AS used FROM nex_topups WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'",
        [userId]
      );
      const used = Number(usedRes.rows[0].used);
      if (used + amount > TOPUP_DAILY_LIMIT) {
        const left = Math.max(TOPUP_DAILY_LIMIT - used, 0);
        throw new Error(
          left >= TOPUP_MIN_AMOUNT
            ? `24 soatda eng ko'pi ${TOPUP_DAILY_LIMIT} Nex Tradex to'ldirish mumkin. Hozir yana ${left} gacha to'ldira olasiz`
            : `24 soatlik to'ldirish chegarasi (${TOPUP_DAILY_LIMIT}) tugadi. Ertaga qayta urinib ko'ring`
        );
      }
    }

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
  if (Date.now() < WITHDRAW_OPENS_AT.getTime()) {
    throw new Error(`🗓 Mablag' chiqarish ${withdrawOpenLabel()} kuni ochiladi`);
  }
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
