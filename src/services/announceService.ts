import { pool } from "../db/pool";

/**
 * TELEGRAM KANALGA AVTOMATIK E'LONLAR (v3)
 *
 * .env: ANNOUNCE_CHAT_ID = @kanal_nomi  (yoki -100xxxxxxxxxx)
 * Bot shu kanalda ADMIN bo'lishi va xabar yozish huquqiga ega bo'lishi kerak.
 * ANNOUNCE_CHAT_ID bo'lmasa - hech narsa yuborilmaydi.
 *
 *  - Yangi token yaratilganda
 *  - Token narxi oxirgi e'londan beri +50% (PUMP_ANNOUNCE_PCT) o'sganda
 */

const CHAT_ID = (process.env.ANNOUNCE_CHAT_ID ?? "").trim();
const BOT_USERNAME = process.env.BOT_USERNAME ?? "NexTradexbot";
const PUMP_PCT = Number(process.env.PUMP_ANNOUNCE_PCT ?? 50);
const MAX_PER_CHECK = 3;

export function announcementsEnabled() {
  return Boolean(CHAT_ID);
}

function openButton(text = "🚀 NexTrade'ni ochish") {
  return { inline_keyboard: [[{ text, url: `https://t.me/${BOT_USERNAME}?start=kanal` }]] };
}

async function send(text: string) {
  if (!CHAT_ID) return;
  const { bot } = await import("../bot/bot");
  try {
    await bot.api.sendMessage(CHAT_ID, text, { reply_markup: openButton() });
  } catch (err: any) {
    console.error("⚠️ Kanalga e'lon yuborib bo'lmadi:", err?.description ?? err?.message ?? err);
  }
}

/** Kanalga ixtiyoriy matn (IPO ochilishi va h.k.) */
export async function announceText(text: string) {
  await send(text);
}

export async function announceNewToken(token: { name: string; symbol: string; current_price: any; max_supply: any }, creatorUsername?: string | null) {
  if (!CHAT_ID) return;
  await send(
    `🆕 Yangi token bozorga chiqdi!\n\n` +
      `🪙 ${token.name} ($${token.symbol})\n` +
      `💵 Boshlang'ich narx: ${Number(token.current_price).toFixed(4)}\n` +
      `📦 Jami miqdor: ${Number(token.max_supply).toLocaleString("en-US")} ta\n` +
      (creatorUsername ? `👤 Yaratuvchi: @${creatorUsername}\n` : "") +
      `\nBirinchilardan bo'lib sotib oling - narx arzon paytida! 👇`
  );
}

/**
 * Har tikda chaqiriladi. Narxi oxirgi e'lon narxidan PUMP_PCT% ko'p o'sgan
 * tokenlar haqida e'lon beradi. Narx yarmidan ko'proq tushsa, mo'ljal narx
 * jimgina pastga tushiriladi (keyingi o'sish yana e'lon qilinishi uchun).
 */
export async function checkPumpAnnouncements() {
  // Hali mo'ljal narxi yo'q tokenlar uchun - joriy narxni belgilaymiz (e'lonsiz)
  await pool.query("UPDATE tokens SET last_announced_price = current_price WHERE last_announced_price IS NULL");
  await pool.query(
    "UPDATE tokens SET last_announced_price = current_price WHERE current_price < last_announced_price * 0.5"
  );
  if (!CHAT_ID) return;

  const { rows } = await pool.query(
    `WITH c AS (
       SELECT id, last_announced_price AS old_price FROM tokens
       WHERE last_announced_price > 0 AND current_price >= last_announced_price * (1 + $1::numeric / 100)
       ORDER BY current_price / last_announced_price DESC
       LIMIT $2
       FOR UPDATE
     )
     UPDATE tokens t SET last_announced_price = t.current_price
     FROM c WHERE t.id = c.id
     RETURNING t.name, t.symbol, t.current_price, c.old_price`,
    [PUMP_PCT, MAX_PER_CHECK]
  );

  for (const t of rows) {
    const pct = ((Number(t.current_price) - Number(t.old_price)) / Number(t.old_price)) * 100;
    await send(
      `🚀 ${t.name} ($${t.symbol}) keskin o'smoqda!\n\n` +
        `📈 +${pct.toFixed(0)}%  (${Number(t.old_price).toFixed(4)} → ${Number(t.current_price).toFixed(4)})\n\n` +
        `Trend'ni o'tkazib yubormang! 👇`
    );
  }
}
