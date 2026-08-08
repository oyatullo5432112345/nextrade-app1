import { pool } from "../db/pool";
import { ABSOLUTE_MIN_PRICE } from "./pricingService";

/**
 * Har TICK_INTERVAL_MS millisekundda barcha tokenlar narxiga kichik,
 * tasodifiy tebranish qo'shadi - xuddi real bozordagidek, savdo bo'lmasa ham
 * narx ozgina pasayib-ko'tarilib turadi.
 *
 * Bu tebranish foydalanuvchi savdosidan (buy/sell) MUSTAQIL ishlaydi va
 * current_price ustiga to'g'ridan-to'g'ri qo'llaniladi. Yuqori chegara yo'q -
 * faqat ABSOLUTE_MIN_PRICE dan pastga tushib ketmasligi ta'minlanadi.
 */

const TICK_INTERVAL_MS = 10_000; // 10 soniya
const MAX_TICK_CHANGE = 0.02; // bitta tikda maksimal ±2% tasodifiy o'zgarish

let intervalHandle: ReturnType<typeof setInterval> | null = null;

function randomChangeFactor(): number {
  const pct = (Math.random() * 2 - 1) * MAX_TICK_CHANGE;
  return 1 + pct;
}

async function tickAllTokens() {
  const client = await pool.connect();
  try {
    const { rows: tokens } = await client.query(
      "SELECT id, current_price FROM tokens"
    );

    for (const token of tokens) {
      const oldPrice = Number(token.current_price);
      let newPrice = oldPrice * randomChangeFactor();
      if (newPrice < ABSOLUTE_MIN_PRICE) newPrice = ABSOLUTE_MIN_PRICE;

      await client.query(
        "UPDATE tokens SET current_price = $1 WHERE id = $2",
        [newPrice, token.id]
      );
      await client.query(
        "INSERT INTO price_ticks (token_id, price) VALUES ($1, $2)",
        [token.id, newPrice]
      );
    }
  } catch (err) {
    console.error("❌ Avtomatik narx tebranishida xatolik:", err);
  } finally {
    client.release();
  }
}

export function startPriceFluctuations() {
  if (intervalHandle) return;
  intervalHandle = setInterval(tickAllTokens, TICK_INTERVAL_MS);
  console.log("✅ Avtomatik narx tebranishi ishga tushdi (har 10 soniyada)");
}

export function stopPriceFluctuations() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
