import { pool } from "../db/pool";

// Nex Trade (asosiy valyuta)ning boshlang'ich real qiymati - 1 Nex Trade = 0.9957 UZS.
// Bu narx bozorga qarab (avtomatik tebranish + kelajakda savdo hajmiga bog'liq
// holda) ko'payib yoki kamayib turishi mumkin, lekin hech qachon 0 dan pastga
// tushmaydi.
export const NEX_TRADE_STARTING_PRICE = 0.9957;
const NEX_TRADE_MIN_PRICE = 0.0001;

/**
 * Hozirgi Nex Trade narxini (UZS da) qaytaradi. Agar hali qator mavjud
 * bo'lmasa (masalan eski bazada), boshlang'ich narx bilan yaratib qo'yadi.
 */
export async function getNexTradePrice() {
  const result = await pool.query("SELECT price, updated_at FROM nex_trade_price WHERE id = 1");
  if (result.rows.length > 0) return result.rows[0];

  const inserted = await pool.query(
    "INSERT INTO nex_trade_price (id, price) VALUES (1, $1) ON CONFLICT (id) DO NOTHING RETURNING price, updated_at",
    [NEX_TRADE_STARTING_PRICE]
  );
  if (inserted.rows.length > 0) return inserted.rows[0];

  const retry = await pool.query("SELECT price, updated_at FROM nex_trade_price WHERE id = 1");
  return retry.rows[0];
}

/**
 * Grafik uchun Nex Trade narxining so'nggi tebranishlari tarixi.
 */
export async function getNexTradePriceChart(limit = 100) {
  const result = await pool.query(
    "SELECT price, created_at FROM nex_trade_price_ticks ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return result.rows.reverse(); // eskidan yangiga - grafik uchun qulay
}

// NEX NARXI NAZORATI (v9): narx tasodifan cheksiz "suzib" ketmasligi uchun
// maqsadli narxga (NEX_TARGET_UZS) asta qaytadi va ±NEX_BAND oralig'idan chiqmaydi.
export const NEX_TARGET_UZS = Number(process.env.NEX_TARGET_UZS ?? NEX_TRADE_STARTING_PRICE);
export const NEX_BAND = Number(process.env.NEX_BAND ?? 0.05); // ±5%
const NEX_PULL = 0.03; // har tikda farqning 3% i qaytariladi

export function nextNexPrice(oldPrice: number, maxChangePct: number, rnd = Math.random()) {
  const pct = (rnd * 2 - 1) * maxChangePct;
  let p = oldPrice * (1 + pct);
  p += (NEX_TARGET_UZS - p) * NEX_PULL;
  const lo = NEX_TARGET_UZS * (1 - NEX_BAND), hi = NEX_TARGET_UZS * (1 + NEX_BAND);
  return Math.min(hi, Math.max(lo, Math.max(p, NEX_TRADE_MIN_PRICE)));
}

/** Bir tik - jobs.ts tomonidan har 10 soniyada chaqiriladi. */
export async function tickNexTradePrice(maxChangePct: number, record = true) {
  const current = await pool.query("SELECT price FROM nex_trade_price WHERE id = 1");
  const oldPrice = current.rows.length > 0 ? Number(current.rows[0].price) : NEX_TRADE_STARTING_PRICE;
  const newPrice = nextNexPrice(oldPrice, maxChangePct);
  await pool.query(
    `INSERT INTO nex_trade_price (id, price, updated_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET price = $1, updated_at = NOW()`,
    [newPrice]
  );
  if (record) await pool.query("INSERT INTO nex_trade_price_ticks (price) VALUES ($1)", [newPrice]);
}
