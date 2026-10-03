import { pool } from "./db/pool";
import { sendTelegramMessage, sendBackupToAdmin } from "./bot/bot";
import { processLaunches, sendReminders, payoutPreviousSeason } from "./services/retentionService";
import { announceText } from "./services/announceService";
import { isBackupDue } from "./services/backupService";
import { tickNexTradePrice } from "./services/nexTradePriceService";
import { checkPriceAlerts } from "./services/alertService";
import { checkPumpAnnouncements } from "./services/announceService";
import { payoutPreviousWeek } from "./services/engagementService";
import { ensureRealTokens, refreshRealTokens } from "./services/realTokenService";
import { processPredictions, payoutPreviousTournament, checkRealSignals } from "./services/gamesService";
import { recordAndCheckPicks } from "./services/nexAiService";
import { refreshLiquidity } from "./services/liquidityService";

/**
 * FON VAZIFALARI (v8)
 *  - har 10 soniyada: Nex Trade (UZS) narxi, narx bildirishnomalari, kanal e'lonlari
 *    (token narxlari endi tasodifiy tebranmaydi - ularni faqat savdolar o'zgartiradi)
 *  - har daqiqa: likvidlik buyurtmalari (🤖 MM), IPO tokenlar savdosi ochilganda xabar
 *  - har soat: eslatmalar (faqat kunduzi 10:00-21:00), kunlik zaxira, oylik mavsum mukofoti
 */

async function tashkentHour(): Promise<number> {
  const { rows } = await pool.query("SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Tashkent')::int AS h");
  return rows[0].h;
}

// Nex Trade - asosiy valyuta, barqaror (±0.5%)
const NEX_TRADE_MAX_TICK_CHANGE = 0.005;
const PRICE_TICK_RETENTION_DAYS = Number(process.env.PRICE_TICK_RETENTION_DAYS ?? 8);
let fastTick = 0;
let fastRunning = false;

async function fastJobs() {
  if (fastRunning) return;
  fastRunning = true;
  fastTick++;
  try {
    await tickNexTradePrice(NEX_TRADE_MAX_TICK_CHANGE, fastTick % 6 === 1);
  } catch (err) {
    console.error("❌ Nex Trade narxida xatolik:", err);
  }
  try {
    await checkPriceAlerts();
  } catch (err) {
    console.error("❌ Narx bildirishnomalarida xatolik:", err);
  }
  try {
    await checkPumpAnnouncements();
  } catch (err) {
    console.error("❌ Kanal e'lonida xatolik:", err);
  }
  fastRunning = false;
}

/** Eski grafik nuqtalarini tozalash (har token uchun eng oxirgisi saqlanadi - 24s o'zgarish uchun kerak). */
export async function cleanupOldTicks() {
  try {
    const a = await pool.query(
      `DELETE FROM price_ticks p WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
         AND id <> (SELECT q.id FROM price_ticks q WHERE q.token_id = p.token_id ORDER BY q.created_at DESC, q.id DESC LIMIT 1)`,
      [PRICE_TICK_RETENTION_DAYS]
    );
    const b = await pool.query(
      `DELETE FROM nex_trade_price_ticks WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [PRICE_TICK_RETENTION_DAYS]
    );
    if ((a.rowCount ?? 0) + (b.rowCount ?? 0) > 0) console.log(`🧹 Eski grafik nuqtalari o'chirildi: ${a.rowCount} + ${b.rowCount}`);
  } catch (err) {
    console.error("❌ Eski narx nuqtalarini tozalashda xatolik:", err);
  }
}

async function minuteJobs() {
  try {
    const n = await processPredictions(sendTelegramMessage);
    if (n) console.log(`🔮 ${n} ta bashorat yakunlandi`);
  } catch (err) {
    console.error("❌ Bashoratlarda xato:", err);
  }
  try {
    const n = await processLaunches(sendTelegramMessage, announceText);
    if (n) console.log(`🚀 ${n} ta IPO token savdosi ochildi`);
  } catch (err) {
    console.error("❌ IPO ochilishida xato:", err);
  }
}

async function hourlyJobs() {
  await cleanupOldTicks();
  try {
    await recordAndCheckPicks();
  } catch (err) {
    console.error("❌ Nex AI tarixida xato:", err);
  }
  try {
    const n = await payoutPreviousTournament(sendTelegramMessage);
    if (n) console.log(`🏁 Turnir: ${n} ta g'olib`);
  } catch (err) {
    console.error("❌ Turnir mukofotida xato:", err);
  }
  try {
    const n = await payoutPreviousWeek(sendTelegramMessage);
    if (n > 0) console.log(`🏆 Haftalik liga: ${n} ta g'olibga mukofot berildi`);
  } catch (err) {
    console.error("❌ Haftalik liga mukofotida xatolik:", err);
  }
  try {
    const h = await tashkentHour();
    if (h >= 10 && h <= 21) {
      const n = await sendReminders(sendTelegramMessage);
      if (n) console.log(`🔔 ${n} ta eslatma yuborildi`);
    }
  } catch (err) {
    console.error("❌ Eslatmalarda xato:", err);
  }
  try {
    if (await isBackupDue()) {
      if (await sendBackupToAdmin()) console.log("💾 Zaxira Telegram'ga yuborildi va qadaldi");
    }
  } catch (err) {
    console.error("❌ Zaxirada xato:", err);
  }
  try {
    const n = await payoutPreviousSeason(sendTelegramMessage);
    if (n) console.log(`👑 Oylik mavsum: ${n} ta g'olib`);
  } catch (err) {
    console.error("❌ Mavsum mukofotida xato:", err);
  }
}

let started = false;
export function startJobs() {
  if (started) return;
  started = true;
  setInterval(fastJobs, 10_000);
  // Real tokenlar (TON, NOT): narx kuzatuvi va platforma buyurtmalari - har 15 soniyada
  let realRunning = false;
  const realJob = async () => {
    if (realRunning) return;
    realRunning = true;
    try { await refreshRealTokens(); } catch (err) { console.error("❌ Real token narxida xato:", err); }
    realRunning = false;
  };
  ensureRealTokens().then(realJob).catch((err) => console.error("❌ Real tokenlarni yaratishda xato:", err));
  setInterval(realJob, 15_000);
  // Foydalanuvchi tokenlari uchun likvidlik (platforma limit buyurtmalari) - har daqiqada
  let mmRunning = false;
  const mmJob = async () => {
    if (mmRunning) return;
    mmRunning = true;
    try { await refreshLiquidity(); } catch (err) { console.error("❌ Likvidlik xatosi:", err); }
    mmRunning = false;
  };
  setTimeout(mmJob, 20_000);
  setInterval(mmJob, 60_000);
  // Narx signallari - har 5 daqiqada
  setInterval(() => { checkRealSignals(sendTelegramMessage).catch((err) => console.error("❌ Signal xatosi:", err)); }, 5 * 60_000);
  // Render bepul tarifi 15 daqiqa so'rov bo'lmasa serverni uxlatadi - o'zimizni har 10 daqiqada "uyg'otib" turamiz
  const selfUrl = (process.env.RENDER_EXTERNAL_URL ?? process.env.WEBHOOK_URL ?? "").replace(/\/+$/, "");
  if (selfUrl && process.env.KEEP_ALIVE !== "false") {
    setInterval(() => { fetch(`${selfUrl}/api/ping`).catch(() => {}); }, 10 * 60_000);
    console.log("⏰ Keep-alive yoqildi (har 10 daqiqada /api/ping)");
  }
  setInterval(minuteJobs, 60_000);
  setInterval(hourlyJobs, 60 * 60_000);
  setTimeout(hourlyJobs, 60_000);
}
