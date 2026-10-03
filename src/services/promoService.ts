import { pool } from "../db/pool";
import { getDailySlots } from "./tokenService";

/**
 * GURUH VA KANALLARDA AVTOMATIK REKLAMA (v5)
 *
 * - Bot guruh yoki kanalga qo'shilganda chat eslab qolinadi va darhol
 *   birinchi reklama yuboriladi.
 * - Keyin har interval_minutes (standart 10 daqiqa) da rasm + matn + tugma.
 * - Guruhni to'ldirib yubormaslik uchun yangi reklamadan oldin botning
 *   OLDINGI reklamasi o'chiriladi (PROMO_DELETE_PREVIOUS=false - o'chirmaslik).
 * - Guruh adminlari: /reklama_vaqt 30 (daqiqa), /reklama_stop, /reklama_start
 * - Bot egasi (ADMIN): /reklama_matn, /reklama_rasm (rasmga reply), /reklama_hozir, /reklamalar
 * - Bot chiqarib yuborilsa yoki yozish huquqi olinsa - avtomatik to'xtaydi.
 *
 * v13: har bir reklamada guruhning bitta a'zosi navbatma-navbat belgilanadi
 * ("👤 Ali, siz uchun!"). A'zolarni bot guruhda yozganlar va yangi qo'shilganlardan
 * eslab qoladi (bot guruhda admin bo'lishi yoki BotFather'da /setprivacy - Disable kerak).
 * Bir odam TAG_COOLDOWN_HOURS (standart 24) soatda ko'pi bilan bir marta belgilanadi,
 * hali o'ynamaganlar birinchi navbatda. "{joy}" - bugungi haqiqiy bo'sh joylar soni.
 */

export const DEFAULT_PROMO_TEXT =
  "🚀 O'z tokeningizni yarating — shu bot orqali!\n\n" +
  "📈 Tokeningiz narxini haqiqiy birjadagidek xaridor va sotuvchilar belgilaydi, har bir savdodan sizga ulush tushadi.\n\n" +
  "🎁 Kirganingizda 100 Nex start bonusi — birinchi tokeningizga yetadi.\n" +
  "{joy}\n\n" +
  "🕹 Real pul kerak emas.\n" +
  "👇 Hoziroq boshlang: @NexTradexbot";

export const MIN_INTERVAL_MINUTES = Number(process.env.PROMO_MIN_MINUTES ?? 10);
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const DEFAULT_INTERVAL = Number(process.env.PROMO_INTERVAL_MINUTES ?? 10);
const DELETE_PREVIOUS = process.env.PROMO_DELETE_PREVIOUS !== "false";

// ---------------- Sozlamalar ----------------

export async function getSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT value FROM bot_settings WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string | null) {
  if (value === null) {
    await pool.query("DELETE FROM bot_settings WHERE key = $1", [key]);
    return;
  }
  await pool.query(
    `INSERT INTO bot_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

export async function getPromoText() {
  return (await getSetting("promo_text")) ?? DEFAULT_PROMO_TEXT;
}

// ---------------- Chatlar ----------------

export async function registerChat(chatId: number, title: string | undefined, type: string) {
  await pool.query(
    `INSERT INTO promo_chats (chat_id, title, chat_type, is_active, interval_minutes)
     VALUES ($1, $2, $3, true, $4)
     ON CONFLICT (chat_id) DO UPDATE SET title = $2, chat_type = $3, is_active = true`,
    [chatId, title ?? null, type, DEFAULT_INTERVAL]
  );
}

export async function deactivateChat(chatId: number) {
  await pool.query("UPDATE promo_chats SET is_active = false WHERE chat_id = $1", [chatId]);
}

export async function setChatActive(chatId: number, active: boolean) {
  const { rowCount } = await pool.query("UPDATE promo_chats SET is_active = $2 WHERE chat_id = $1", [chatId, active]);
  return Boolean(rowCount);
}

export async function setChatInterval(chatId: number, minutes: number) {
  const m = Math.round(minutes);
  if (!(m >= MIN_INTERVAL_MINUTES && m <= MAX_INTERVAL_MINUTES)) {
    throw new Error(`Oraliq ${MIN_INTERVAL_MINUTES} daqiqadan ${MAX_INTERVAL_MINUTES / 60} soatgacha bo'lishi kerak`);
  }
  const { rowCount } = await pool.query("UPDATE promo_chats SET interval_minutes = $2 WHERE chat_id = $1", [chatId, m]);
  if (!rowCount) throw new Error("Bu chat ro'yxatda yo'q. Botni guruhdan chiqarib, qayta qo'shing");
  return m;
}

/** "30", "30m", "2h", "2 soat", "45 daqiqa" -> daqiqa */
export function parseIntervalMinutes(input: string): number {
  const t = input.trim().toLowerCase();
  const n = parseFloat(t.replace(",", "."));
  if (!n) return 0;
  if (/(h|soat|час)/.test(t)) return Math.round(n * 60);
  return Math.round(n);
}

export function formatInterval(minutes: number) {
  if (minutes % 60 === 0) return `${minutes / 60} soat`;
  if (minutes > 60) return `${Math.floor(minutes / 60)} soat ${minutes % 60} daqiqa`;
  return `${minutes} daqiqa`;
}

export async function listPromoChats() {
  const { rows } = await pool.query(
    `SELECT chat_id, title, chat_type, is_active, interval_minutes, posts_sent, last_post_at
     FROM promo_chats WHERE is_bot = false ORDER BY is_active DESC, posts_sent DESC`
  );
  return rows;
}

// ---------------- Guruh a'zolari ----------------

const TAG_ENABLED = process.env.PROMO_TAG !== "false";
const TAG_COOLDOWN_HOURS = Number(process.env.TAG_COOLDOWN_HOURS ?? 24);

export const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Guruhda ko'ringan odamni eslab qoladi (botlar va kanal nomidan yozilganlar hisobga olinmaydi). */
export async function rememberGroupMember(chatId: number, user: { id: number; is_bot?: boolean; first_name?: string; username?: string }) {
  if (!user || user.is_bot || !(user.id > 0)) return;
  await pool.query(
    `INSERT INTO group_members (chat_id, telegram_id, first_name, username, last_seen)
     SELECT $1, $2, $3, $4, NOW() WHERE EXISTS (SELECT 1 FROM promo_chats WHERE chat_id = $1)
     ON CONFLICT (chat_id, telegram_id) DO UPDATE SET first_name = $3, username = $4, last_seen = NOW()`,
    [chatId, user.id, (user.first_name ?? "").slice(0, 64) || null, (user.username ?? "").slice(0, 64) || null]
  );
}

export async function forgetGroupMember(chatId: number, telegramId: number) {
  await pool.query("DELETE FROM group_members WHERE chat_id = $1 AND telegram_id = $2", [chatId, telegramId]);
}

/** Navbatdagi belgilanadigan a'zo: avval hali o'ynamaganlar, eng uzoq belgilanmaganlar. */
export async function pickMemberToTag(chatId: number) {
  if (!TAG_ENABLED) return null;
  const { rows } = await pool.query(
    `SELECT gm.telegram_id, gm.first_name, gm.username
     FROM group_members gm LEFT JOIN users u ON u.telegram_id = gm.telegram_id
     WHERE gm.chat_id = $1
       AND gm.last_seen > NOW() - INTERVAL '60 days'
       AND (gm.last_tagged_at IS NULL OR gm.last_tagged_at < NOW() - ($2::float8 * INTERVAL '1 hour'))
       AND COALESCE(u.is_banned, false) = false
     ORDER BY (u.id IS NOT NULL), gm.last_tagged_at NULLS FIRST, gm.last_seen DESC
     LIMIT 1`,
    [chatId, TAG_COOLDOWN_HOURS]
  );
  return rows[0] ? { telegramId: Number(rows[0].telegram_id), firstName: rows[0].first_name as string | null, username: rows[0].username as string | null } : null;
}

export function mentionHtml(m: { telegramId: number; firstName: string | null; username: string | null }) {
  if (m.username) return `@${escapeHtml(m.username)}`;
  return `<a href="tg://user?id=${m.telegramId}">${escapeHtml((m.firstName || "do'stim").slice(0, 32))}</a>`;
}

/** "{joy}" o'rniga bugungi HAQIQIY bo'sh joylar soni. */
async function slotsLine() {
  const s = await getDailySlots().catch(() => null);
  if (!s || !s.total) return "⏳ Tezlashing — birinchi tokenlar eng ko'p e'tibor oladi!";
  if (!s.left) return `⏳ Bugungi ${s.total} ta joy band bo'ldi — ertaga birinchilardan bo'ling!`;
  return `⏳ Tezlashing — joylar kam: bugun ${s.left} ta joy qoldi (kuniga ${s.total} ta)!`;
}

/** Reklama matni (HTML). chatId berilsa - shu guruhning navbatdagi a'zosi belgilanadi. */
export async function buildPromoCaption(chatId: number | null, sample?: { telegramId: number; firstName: string | null; username: string | null }) {
  let text = await getPromoText();
  const joy = await slotsLine();
  text = text.includes("{joy}") ? text.replace("{joy}", joy) : `${text}\n\n${joy}`;
  const member = sample ?? (chatId && chatId < 0 ? await pickMemberToTag(chatId) : null);
  const tail = member ? `\n\n👤 ${mentionHtml(member)}, siz uchun! Shundan foydalaning 👆` : "";
  // Telegram rasm ostidagi matn chegarasi 1024 belgi
  const room = 1000 - (member ? 70 : 0);
  return { html: escapeHtml(text.slice(0, room)) + tail, tagged: member?.telegramId ?? null };
}

// ---------------- Yuborish ----------------

export interface PromoSender {
  /** caption/text - HTML (parse_mode: HTML) */
  sendPhoto(chatId: number, photo: string, caption: string, button: { text: string; url: string }): Promise<{ fileId?: string; messageId?: number }>;
  sendText(chatId: number, text: string, button: { text: string; url: string }): Promise<{ messageId?: number }>;
  deleteMessage?(chatId: number, messageId: number): Promise<void>;
}

function botLink(chatId?: number) {
  // Guruhdagi reklama orqali kirgan o'yinchi avtomatik shu guruh jamoasiga qo'shiladi (guruhlar ligasi)
  const payload = chatId ? `grp_${chatId}` : "promo";
  return `https://t.me/${process.env.BOT_USERNAME ?? "NexTradexbot"}?start=${payload}`;
}

/** Rasm manbai: avval saqlangan file_id (tez), bo'lmasa serverdagi promo.jpg. */
async function photoSource(): Promise<string | null> {
  const fileId = await getSetting("promo_photo_file_id");
  if (fileId) return fileId;
  const base = (process.env.WEBHOOK_URL ?? process.env.RENDER_EXTERNAL_URL ?? process.env.MINI_APP_URL ?? "").replace(/\/+$/, "");
  return base.startsWith("https://") ? `${base}/promo.jpg` : null;
}

/**
 * Bitta chatga reklama yuboradi. Xato bo'lsa (bot chiqarilgan, huquq yo'q)
 * chat o'chiriladi. true - yuborildi.
 */
export async function sendPromoToChat(chatId: number, sender: PromoSender): Promise<boolean> {
  const { html: text, tagged } = await buildPromoCaption(chatId);
  const button = { text: "🚀 O'yinni boshlash", url: botLink(chatId) };
  try {
    // Oldingi reklamani o'chiramiz - guruhda doim faqat bitta (eng yangi) reklama turadi
    if (DELETE_PREVIOUS && sender.deleteMessage) {
      const prev = await pool.query("SELECT last_message_id FROM promo_chats WHERE chat_id = $1", [chatId]);
      const prevId = Number(prev.rows[0]?.last_message_id ?? 0);
      if (prevId) await sender.deleteMessage(chatId, prevId).catch(() => {});
    }

    const photo = await photoSource();
    let messageId: number | undefined;
    if (photo) {
      const r = await sender.sendPhoto(chatId, photo, text, button);
      messageId = r.messageId;
      // Telegram qaytargan file_id ni saqlab qo'yamiz - keyingi safar rasm qayta yuklanmaydi
      if (r.fileId && !(await getSetting("promo_photo_file_id"))) await setSetting("promo_photo_file_id", r.fileId);
    } else {
      messageId = (await sender.sendText(chatId, text, button)).messageId;
    }
    await pool.query(
      "UPDATE promo_chats SET last_post_at = NOW(), posts_sent = posts_sent + 1, last_message_id = $2 WHERE chat_id = $1",
      [chatId, messageId ?? null]
    );
    if (tagged) {
      await pool.query(
        "UPDATE group_members SET last_tagged_at = NOW(), tagged_count = tagged_count + 1 WHERE chat_id = $1 AND telegram_id = $2",
        [chatId, tagged]
      );
    }
    return true;
  } catch (err: any) {
    const code = err?.error_code;
    const desc = String(err?.description ?? err?.message ?? "");
    // 403: chiqarib yuborilgan / bloklangan; 400: chat topilmadi yoki yozish huquqi yo'q
    if (code === 403 || (code === 400 && /chat not found|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|kicked/i.test(desc))) {
      await deactivateChat(chatId);
      console.log(`ℹ️ Reklama: chat ${chatId} o'chirildi (${desc})`);
    } else {
      console.error(`⚠️ Reklama yuborilmadi (${chatId}):`, desc);
    }
    return false;
  }
}

/** Vaqti kelgan chatlarga reklama yuboradi (har 10 daqiqada chaqiriladi). */
export async function runPromoCycle(sender: PromoSender): Promise<number> {
  const { rows } = await pool.query(
    `SELECT chat_id FROM promo_chats
     WHERE is_active = true AND is_bot = false
       AND (last_post_at IS NULL OR last_post_at <= NOW() - (interval_minutes * INTERVAL '1 minute') + INTERVAL '30 seconds')
     ORDER BY last_post_at NULLS FIRST
     LIMIT 100`
  );
  let sent = 0;
  for (const r of rows) {
    if (await sendPromoToChat(Number(r.chat_id), sender)) sent++;
    await new Promise((res) => setTimeout(res, 200));
  }
  return sent;
}

let promoHandle: ReturnType<typeof setInterval> | null = null;
export function startPromoScheduler(sender: PromoSender) {
  if (promoHandle) return;
  const tick = () =>
    runPromoCycle(sender)
      .then((n) => n > 0 && console.log(`📢 Reklama ${n} ta chatga yuborildi`))
      .catch((err) => console.error("❌ Reklama siklida xato:", err));
  // Har daqiqada tekshiradi - har bir chat o'z oralig'i kelganda oladi
  promoHandle = setInterval(tick, 60 * 1000);
  setTimeout(tick, 30_000);
}
