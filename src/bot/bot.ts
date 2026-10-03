import { Bot, InlineKeyboard, InputFile } from "grammy";
import dotenv from "dotenv";
import { getOrCreateUser, getPlatformStats, getUserLeaderboard } from "../services/userService";
import { claimStreakBonus, getLeague, REFERRAL_REWARD } from "../services/engagementService";
import { setBanned, isBannedTelegram, hideToken, deleteComment, getBroadcastTargets, markBotBlocked } from "../services/moderationService";
import { applyStarsPayment, parsePayload, validateStarsPurchase } from "../services/featuresService";
import { pool } from "../db/pool";
import { parseNexPayload, resolveOffer, applyNexPayment } from "../services/nexShopService";
import { setUserGroup, getGroupLeague, createGiveaway, setGiveawayMessage, claimGiveaway } from "../services/groupService";
import { listTokensWithStats } from "../services/marketService";
import { createBackup, restoreBackup, markBackupDone, isDatabaseEmpty, BACKUP_EVERY_HOURS } from "../services/backupService";
import { getAdminStats } from "../services/retentionService";
import {
  registerChat, deactivateChat, setChatActive, setChatInterval, listPromoChats, sendPromoToChat,
  setSetting, getPromoText, DEFAULT_PROMO_TEXT, buildPromoCaption, rememberGroupMember, forgetGroupMember, MIN_INTERVAL_MINUTES, parseIntervalMinutes, formatInterval, PromoSender,
} from "../services/promoService";
import { listFrozenBalances, getTotalFrozen, withdrawFrozen } from "../services/frozenService";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const MINI_APP_URL = process.env.MINI_APP_URL ?? "https://example.com";
const BOT_USERNAME = process.env.BOT_USERNAME ?? "your_bot";
const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? "0");

// BOT_TOKEN bo'lmasa ham (masalan, lokal test) modul yiqilmasligi uchun
// soxta token bilan yaratiladi - index.ts bunday holda botni ishga tushirmaydi.
export const bot = new Bot(BOT_TOKEN || "0:missing-token");

// Bloklangan foydalanuvchilarning xabarlariga bot javob bermaydi
bot.use(async (ctx, next) => {
  const id = ctx.from?.id;
  // To'lov tasdig'i (Stars yechib olingan) har doim qayta ishlanadi - aks holda pul ketib, hech narsa berilmasdi
  if (ctx.message?.successful_payment) return next();
  if (id && id !== ADMIN_TELEGRAM_ID && (await isBannedTelegram(id).catch(() => false))) return;
  await next();
});

// Guruh a'zolarini eslab qolamiz - reklamada navbatma-navbat belgilash uchun
bot.use(async (ctx, next) => {
  const chat: any = ctx.chat;
  const msg: any = ctx.message;
  if (chat && (chat.type === "group" || chat.type === "supergroup") && msg) {
    try {
      if (ctx.from && !msg.sender_chat) await rememberGroupMember(chat.id, ctx.from as any);
      for (const m of msg.new_chat_members ?? []) await rememberGroupMember(chat.id, m);
      if (msg.left_chat_member) await forgetGroupMember(chat.id, msg.left_chat_member.id);
    } catch (err) {
      console.error("⚠️ Guruh a'zosini saqlashda xato:", err);
    }
  }
  await next();
});

/**
 * Bot buyruqlari ro'yxati va chap pastdagi "Menu" tugmasini Mini App'ga
 * bog'laydi - foydalanuvchi /start yozmasdan ham ilovani ocha oladi.
 */
export async function setupBotMenu() {
  await bot.api.setMyCommands([
    { command: "start", description: "🚀 NexTrade'ni ochish" },
    { command: "kunlik", description: "🔥 Kunlik bonus (seriya)" },
    { command: "hamyon", description: "👛 Balans va hamyon kodi" },
    { command: "liga", description: "🏆 Haftalik liga" },
    { command: "top", description: "🔥 Trenddagi tokenlar" },
    { command: "ai", description: "🤖 Nex AI tavsiyalari" },
    { command: "narx", description: "💵 Token narxi: /narx UZB" },
    { command: "guruhlar", description: "🏟 Guruhlar ligasi" },
    { command: "reyting", description: "💎 Eng boy foydalanuvchilar" },
    { command: "referral", description: "👥 Do'stlarni taklif qilish" },
  ]);
  if (MINI_APP_URL.startsWith("https://")) {
    await bot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: "NexTrade", web_app: { url: MINI_APP_URL } },
    });
  }
}

bot.command("start", async (ctx) => {
  const telegramId = ctx.from?.id;
  const username = ctx.from?.username;
  if (!telegramId) return;

  const payload = ctx.match;
  let referrerTelegramId: number | undefined;
  if (typeof payload === "string" && payload.startsWith("ref_")) {
    const parsed = Number(payload.replace("ref_", ""));
    if (!isNaN(parsed)) referrerTelegramId = parsed;
  }

  const user = await getOrCreateUser(telegramId, username, referrerTelegramId);
  // Guruh reklamasi orqali kelgan bo'lsa - shu guruh jamoasiga qo'shamiz (guruhlar ligasi)
  if (typeof payload === "string" && payload.startsWith("grp_")) {
    const gid = Number(payload.slice(4));
    if (gid) await setUserGroup(telegramId, gid).catch(() => null);
  }
  const isRu = (ctx.from?.language_code ?? "").startsWith("ru");
  await pool.query(
    "UPDATE users SET bot_blocked = false, language = COALESCE(language, $2) WHERE id = $1",
    [user.id, isRu ? "ru" : "uz"]
  ).catch(() => {});

  const keyboard = new InlineKeyboard().webApp("🚀 NexTrade'ni ochish", MINI_APP_URL);

  // Faqat YANGI foydalanuvchiga (eski foydalanuvchiga referal bonusi berilmaydi)
  const bonusNote = referrerTelegramId && (user as any).is_new
    ? `\n\n🎁 Siz do'stingiz taklifi bilan keldingiz! Birinchi savdoingizni qiling - ikkalangizga +${REFERRAL_REWARD} Nex Trade beriladi.`
    : "";

  if (isRu) {
    await ctx.reply(
      `👋 Добро пожаловать в NexTrade!\n\n` +
        `💰 Ваш баланс: ${Number(user.nex_trade_balance).toFixed(2)} Nex Trade\n\n` +
        `🪙 Создайте свой токен, покупайте чужие и продавайте с прибылью.\n` +
        `🔥 Заходите каждый день — ежедневный бонус растёт до 100 Nex\n` +
        `🏆 Попадите в топ-10 недельной лиги — получите награду\n` +
        `🕹 Это игра: реальные деньги не нужны.\n\n` +
        `Откройте приложение кнопкой ниже 👇`,
      { reply_markup: new InlineKeyboard().webApp("🚀 Открыть NexTrade", MINI_APP_URL) }
    );
    return;
  }

  await ctx.reply(
    `👋 NexTrade'ga xush kelibsiz!\n\n` +
      `💰 Balansingiz: ${Number(user.nex_trade_balance).toFixed(2)} Nex Trade\n\n` +
      `🪙 O'z tokeningizni yarating, boshqalarnikini sotib oling va foyda bilan soting.\n` +
      `🔥 Har kuni kiring - kunlik bonus seriyasi 100 Nex gacha o'sadi\n` +
      `🏆 Haftalik ligada top-10 ga kiring - mukofot oling${bonusNote}\n\n` +
      `Pastdagi tugma orqali ilovani oching 👇`,
    { reply_markup: keyboard }
  );
});

bot.command("referral", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const link = `https://t.me/${BOT_USERNAME}?start=ref_${telegramId}`;
  await ctx.reply(
    `👥 Do'stlaringizni taklif qiling!\n\n` +
      `Do'stingiz shu havola orqali kirib, birinchi savdosini qilganda ikkalangizga ham +${REFERRAL_REWARD} Nex Trade beriladi.\n\n` +
      `Sizning shaxsiy havolangiz:\n${link}`
  );
});

bot.command("hamyon", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getOrCreateUser(telegramId, ctx.from?.username);
  const keyboard = new InlineKeyboard().webApp("👛 Hamyonni ochish", MINI_APP_URL);
  await ctx.reply(
    `👛 Sizning hamyoningiz\n\n` +
      `💰 Balans: ${Number(user.nex_trade_balance).toFixed(2)} Nex Trade\n` +
      `🔑 Hamyon kodi: ${(user as any).wallet_code ?? "-"}\n\n` +
      `Do'stingiz sizga Nex Trade jo'natishi uchun shu kodni yuboring.`,
    { reply_markup: keyboard }
  );
});

bot.command("reyting", async (ctx) => {
  const top = await getUserLeaderboard(10);
  if (top.length === 0) {
    await ctx.reply("Hozircha reytingda hech kim yo'q.");
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.map((u, i) => {
    const medal = medals[i] ?? `${i + 1}.`;
    const name = u.username ? `@${u.username}` : `Foydalanuvchi #${u.id}`;
    return `${medal} ${name} — ${Number(u.nex_trade_balance).toFixed(2)} Nex Trade`;
  });

  await ctx.reply(`🏆 Eng boy foydalanuvchilar reytingi\n\n${lines.join("\n")}`);
});

bot.command("kunlik", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getOrCreateUser(telegramId, ctx.from?.username);

  try {
    const result = await claimStreakBonus(user.id);
    await ctx.reply(
      `🎁 Kunlik bonus: +${result.bonus} Nex Trade!\n` +
        `🔥 Seriya: ${result.streak} kun ketma-ket\n` +
        `💰 Balans: ${Number(result.newBalance).toFixed(2)} Nex Trade\n\n` +
        `Ertaga kelsangiz: +${result.nextReward} Nex. Seriyani uzmang!`
    );
  } catch (err: any) {
    await ctx.reply(`⏳ ${err.message}`);
  }
});

bot.command("liga", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getOrCreateUser(telegramId, ctx.from?.username);
  const league = await getLeague(user.id);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = league.top.map((u) => {
    const name = u.username ? `@${u.username}` : "Foydalanuvchi";
    return `${medals[u.rank - 1] ?? u.rank + "."} ${name} — +${u.pnl.toFixed(2)} Nex (🎁 ${u.prize})`;
  });
  const endsAt = new Date(league.endsAt);
  const hoursLeft = Math.max(0, Math.round((endsAt.getTime() - Date.now()) / 3_600_000));
  const keyboard = new InlineKeyboard().webApp("🏆 Ligani ochish", MINI_APP_URL);
  await ctx.reply(
    `🏆 Haftalik liga\n` +
      `⏳ Tugashiga ${Math.floor(hoursLeft / 24)} kun ${hoursLeft % 24} soat qoldi\n\n` +
      (lines.length ? lines.join("\n") : "Hali hech kim foyda bilan sotmadi - birinchi bo'ling!") +
      (league.me ? `\n\nSiz: ${league.me.rank}-o'rin (+${league.me.pnl.toFixed(2)} Nex)` : ""),
    { reply_markup: keyboard }
  );
});

// Muzlatilgan fond (savdo komissiyasining 0.15% qismi) holatini ko'rish - faqat admin
bot.command("muzlatilgan", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId || telegramId !== ADMIN_TELEGRAM_ID) {
    return;
  }

  const [balances, total] = await Promise.all([listFrozenBalances(), getTotalFrozen()]);

  if (balances.length === 0) {
    await ctx.reply("❄️ Hozircha muzlatilgan mablag' yo'q.");
    return;
  }

  const lines = balances.map(
    (b: any) => `• ${b.name} ($${b.symbol}, id:${b.token_id}) — ${Number(b.amount).toFixed(4)} Nex Trade`
  );

  await ctx.reply(
    `❄️ Muzlatilgan mablag'lar (bot/mini-app rivojlantirish fondi)\n\n${lines.join("\n")}\n\n` +
      `💰 Jami: ${total.toFixed(4)} Nex Trade\n\n` +
      `Yechib olish uchun: /yechish <token_id> <miqdor>`
  );
});

// Muzlatilgan fonddan mablag' yechib olish (o'z balansiga o'tadi) - faqat admin
bot.command("yechish", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId || telegramId !== ADMIN_TELEGRAM_ID) {
    return;
  }

  const args = (typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/);
  const tokenId = Number(args[0]);
  const amount = Number(args[1]);

  if (!args[0] || !args[1] || !tokenId || !amount || amount <= 0) {
    await ctx.reply("Format: /yechish <token_id> <miqdor>\nMasalan: /yechish 3 1.5");
    return;
  }

  try {
    const result = await withdrawFrozen(telegramId, tokenId, amount);
    await ctx.reply(
      `✅ ${amount} Nex Trade muzlatilgan fonddan yechib olindi.\n` +
        `❄️ Ushbu tokenda qolgan muzlatilgan mablag': ${result.newFrozenBalance.toFixed(4)}\n` +
        `💰 Yangilangan balansingiz: ${Number(result.adminNewBalance).toFixed(4)} Nex Trade`
    );
  } catch (err: any) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
});

/**
 * Umumiy xabar yuborish (bildirishnomalar uchun). Foydalanuvchi botni
 * bloklagan bo'lsa ham xato tashlamaydi.
 */
export async function sendTelegramMessage(telegramId: number, text: string): Promise<void> {
  if (!telegramId || telegramId <= 0) return;
  try {
    await bot.api.sendMessage(telegramId, text);
  } catch (err: any) {
    console.error("⚠️ Xabar yuborib bo'lmadi:", telegramId, err?.description ?? err?.message ?? err);
  }
}

// ====================== ADMIN: MODERATSIYA ======================
function adminOnly(ctx: any): boolean {
  return ctx.from?.id === ADMIN_TELEGRAM_ID;
}
function arg(ctx: any): string {
  return (typeof ctx.match === "string" ? ctx.match : "").trim();
}

bot.command("ban", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const a = arg(ctx);
  if (!a) return void (await ctx.reply("Format: /ban @username yoki /ban 123456789 (telegram ID)"));
  try {
    const u = await setBanned(a, true);
    await ctx.reply(`🚫 Bloklandi: ${u.username ? "@" + u.username : u.telegramId}`);
  } catch (err: any) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
});

bot.command("unban", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const a = arg(ctx);
  if (!a) return void (await ctx.reply("Format: /unban @username yoki /unban 123456789"));
  try {
    const u = await setBanned(a, false);
    await ctx.reply(`✅ Blokdan chiqarildi: ${u.username ? "@" + u.username : u.telegramId}`);
  } catch (err: any) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
});

bot.command("tokenochir", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const a = arg(ctx);
  if (!a) return void (await ctx.reply("Format: /tokenochir BELGI (masalan /tokenochir UZB) yoki /tokenochir 12 (token ID)"));
  try {
    const r = await hideToken(a);
    await ctx.reply(
      `🗑 ${r.name} ($${r.symbol}) bozordan olib tashlandi.\n` +
        `💸 ${r.refunds.length} ta egaga tokenlari joriy narxda Nex Trade qilib qaytarildi.`
    );
    for (const x of r.refunds) {
      await sendTelegramMessage(
        x.telegramId,
        `ℹ️ ${r.name} ($${r.symbol}) tokeni qoidabuzarlik sababli bozordan olib tashlandi.\n` +
          `Sizdagi tokenlar joriy narxda qaytarildi: +${x.refund.toFixed(4)} Nex Trade.`
      );
    }
  } catch (err: any) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
});

bot.command("izohochir", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const id = Number(arg(ctx));
  if (!id) return void (await ctx.reply("Format: /izohochir 15 (izoh ID - ilovada izoh yonida ko'rinadi)"));
  try {
    await deleteComment(id);
    await ctx.reply("🗑 Izoh o'chirildi");
  } catch (err: any) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
});

/**
 * OMMAVIY XABAR: /xabar Matn  — hamma foydalanuvchiga matn yuboradi.
 * Yoki istalgan xabarga (rasm, video, premium emojili post) JAVOB (reply)
 * qilib /xabar yozing — o'sha xabar aynan nusxalanib yuboriladi.
 * Telegram cheklovi sababli sekundiga ~20 ta xabar yuboriladi.
 */
let broadcasting = false;
bot.command("xabar", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const text = arg(ctx);
  const replied = ctx.message?.reply_to_message;
  if (!text && !replied) {
    return void (await ctx.reply(
      "📢 Ommaviy xabar:\n• /xabar Matn — hammaga matn yuboradi\n• Istalgan xabarga reply qilib /xabar — o'sha xabarni (rasm, video bilan) nusxalaydi"
    ));
  }
  if (broadcasting) return void (await ctx.reply("⏳ Oldingi xabar hali yuborilmoqda, kuting"));

  const targets = await getBroadcastTargets();
  await ctx.reply(`📤 ${targets.length} ta foydalanuvchiga yuborish boshlandi...`);
  broadcasting = true;
  const adminChat = ctx.chat!.id;
  const fromChat = ctx.chat!.id;
  const messageId = replied?.message_id;

  // Webhook javobini kutdirmaslik uchun fonda yuboramiz
  (async () => {
    let ok = 0, blocked = 0, failed = 0;
    for (const t of targets) {
      try {
        if (messageId) await bot.api.copyMessage(t.telegramId, fromChat, messageId);
        else await bot.api.sendMessage(t.telegramId, text);
        ok++;
      } catch (err: any) {
        const code = err?.error_code;
        if (code === 403) { blocked++; await markBotBlocked(t.id).catch(() => {}); }
        else if (code === 429) {
          const wait = (err?.parameters?.retry_after ?? 5) * 1000;
          await new Promise((r) => setTimeout(r, wait));
          failed++;
        } else failed++;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    broadcasting = false;
    await bot.api.sendMessage(adminChat, `✅ Xabar yuborildi: ${ok} ta\n🚫 Botni bloklagan: ${blocked} ta\n⚠️ Xato: ${failed} ta`).catch(() => {});
  })();
});

// ====================== GURUH/KANAL REKLAMASI ======================
export const promoSender: PromoSender = {
  async sendPhoto(chatId, photo, caption, button) {
    const msg: any = await bot.api.sendPhoto(chatId, photo, {
      caption,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] },
    });
    const sizes = msg?.photo ?? [];
    return { fileId: sizes.length ? sizes[sizes.length - 1].file_id : undefined, messageId: msg?.message_id };
  },
  async sendText(chatId, text, button) {
    const msg: any = await bot.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] },
    });
    return { messageId: msg?.message_id };
  },
  async deleteMessage(chatId, messageId) {
    await bot.api.deleteMessage(chatId, messageId);
  },
};

// Bot guruh/kanalga qo'shilganda yoki chiqarilganda Telegram shu xabarni yuboradi
bot.on("my_chat_member", async (ctx) => {
  const upd: any = (ctx as any).myChatMember;
  const chat = upd?.chat;
  if (!chat || chat.type === "private") return;
  const status = upd.new_chat_member?.status;
  if (status === "member" || status === "administrator") {
    const wasIn = ["member", "administrator"].includes(upd.old_chat_member?.status);
    await registerChat(chat.id, chat.title, chat.type);
    if (!wasIn) {
      console.log(`➕ Bot qo'shildi: ${chat.title} (${chat.id})`);
      if (ADMIN_TELEGRAM_ID) {
        await sendTelegramMessage(ADMIN_TELEGRAM_ID, `➕ Bot yangi ${chat.type === "channel" ? "kanalga" : "guruhga"} qo'shildi: ${chat.title ?? chat.id}`);
      }
      // Birinchi reklamani bir necha soniyadan keyin yuboramiz (huquqlar o'rnatilishi uchun)
      setTimeout(() => sendPromoToChat(chat.id, promoSender).catch(() => {}), 5000);
    }
  } else if (status === "left" || status === "kicked") {
    await deactivateChat(chat.id);
    console.log(`➖ Bot chiqarildi: ${chat.title} (${chat.id})`);
  }
});

/** Guruhda buyruq yozgan odam shu guruh admini ekanini tekshiradi. */
async function isChatAdmin(ctx: any): Promise<boolean> {
  const chat = ctx.chat;
  if (!chat || chat.type === "private") return false;
  if (chat.type === "channel") return true; // kanalda faqat adminlar yoza oladi
  if (ctx.message?.sender_chat?.id === chat.id) return true; // anonim admin
  if (ctx.from?.id === ADMIN_TELEGRAM_ID) return true;
  try {
    const m: any = await bot.api.getChatMember(chat.id, ctx.from.id);
    return m.status === "creator" || m.status === "administrator";
  } catch {
    return false;
  }
}

bot.command("reklama_vaqt", async (ctx) => {
  if (!(await isChatAdmin(ctx))) return;
  const m = parseIntervalMinutes(arg(ctx));
  if (!m) {
    return void (await ctx.reply(
      `Format:\n/reklama_vaqt 10 — har 10 daqiqada\n/reklama_vaqt 2 soat — har 2 soatda\n(kamida ${MIN_INTERVAL_MINUTES} daqiqa)`
    ));
  }
  try {
    const set = await setChatInterval(ctx.chat!.id, m);
    await ctx.reply(`✅ Endi reklama har ${formatInterval(set)}da bir marta yuboriladi`);
  } catch (err: any) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
});

bot.command("reklama_stop", async (ctx) => {
  if (!(await isChatAdmin(ctx))) return;
  await setChatActive(ctx.chat!.id, false);
  await ctx.reply("⏸ Bu chatda avtomatik reklama to'xtatildi. Qayta yoqish: /reklama_start");
});

bot.command("reklama_start", async (ctx) => {
  if (!(await isChatAdmin(ctx))) return;
  const chat: any = ctx.chat;
  await registerChat(chat.id, chat.title, chat.type);
  await ctx.reply("▶️ Avtomatik reklama yoqildi. Oraliqni o'zgartirish: /reklama_vaqt 30 (daqiqa) yoki /reklama_vaqt 2 soat");
});

// --- Bot egasi uchun ---
bot.command("reklama_matn", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const replied: any = ctx.message?.reply_to_message;
  const text = arg(ctx) || replied?.text || replied?.caption || "";
  if (!text) {
    const cur = await getPromoText();
    return void (await ctx.reply(
      `📝 Joriy reklama matni:\n\n${cur}\n\n` +
        `O'zgartirish: /reklama_matn Yangi matn (yoki matnga reply qilib /reklama_matn)\nStandartga qaytarish: /reklama_matn standart\n\n` +
        `{joy} - bugungi bo'sh joylar soni shu yerga qo'yiladi. Guruh a'zosi belgisi matn oxiriga avtomatik qo'shiladi`
    ));
  }
  if (text.trim().toLowerCase() === "standart") {
    await setSetting("promo_text", null);
    return void (await ctx.reply("✅ Standart matn tiklandi"));
  }
  if (text.length > 1024) return void (await ctx.reply(`⚠️ Matn juda uzun (${text.length}). Rasm ostidagi matn 1024 belgidan oshmasin`));
  await setSetting("promo_text", text);
  await ctx.reply("✅ Reklama matni yangilandi. Ko'rish uchun: /reklama_test");
});

bot.command("reklama_rasm", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const replied: any = ctx.message?.reply_to_message;
  if (arg(ctx).toLowerCase() === "standart") {
    await setSetting("promo_photo_file_id", null);
    return void (await ctx.reply("✅ Standart rasm (promo.jpg) tiklandi"));
  }
  const photos = replied?.photo;
  if (!photos?.length) return void (await ctx.reply("Rasmni botga yuboring, keyin o'sha rasmga reply qilib /reklama_rasm yozing"));
  await setSetting("promo_photo_file_id", photos[photos.length - 1].file_id);
  await ctx.reply("✅ Reklama rasmi yangilandi. Ko'rish uchun: /reklama_test");
});

bot.command("reklama_test", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const f: any = ctx.from;
  const { html: text } = await buildPromoCaption(null, { telegramId: f.id, firstName: f.first_name ?? null, username: f.username ?? null });
  try {
    const { getSetting } = await import("../services/promoService");
    const fileId = await getSetting("promo_photo_file_id");
    const base = (process.env.WEBHOOK_URL ?? process.env.RENDER_EXTERNAL_URL ?? process.env.MINI_APP_URL ?? "").replace(/\/+$/, "");
    const photo = fileId ?? `${base}/promo.jpg`;
    await promoSender.sendPhoto(ctx.chat!.id, photo, text, {
      text: "🚀 O'yinni boshlash",
      url: `https://t.me/${BOT_USERNAME}?start=promo`,
    });
  } catch (err: any) {
    await ctx.reply(`⚠️ Rasm yuborilmadi: ${err?.description ?? err?.message}\n\n${text}`);
  }
});

bot.command("reklamalar", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const chats = await listPromoChats();
  const active = chats.filter((c: any) => c.is_active);
  const mem = await pool.query("SELECT chat_id, COUNT(*)::int AS n FROM group_members GROUP BY chat_id");
  const memMap = new Map(mem.rows.map((r: any) => [Number(r.chat_id), r.n]));
  const lines = active.slice(0, 30).map((c: any) =>
    `• ${c.title ?? c.chat_id} (${c.chat_type === "channel" ? "kanal" : "guruh"}) — har ${formatInterval(c.interval_minutes)}, ${c.posts_sent} ta post` +
    (c.chat_type === "channel" ? "" : `, 👤 ${memMap.get(Number(c.chat_id)) ?? 0} a'zo eslab qolingan`)
  );
  await ctx.reply(
    `📢 Reklama chatlari: ${active.length} ta faol, ${chats.length - active.length} ta o'chgan\n\n` +
      (lines.join("\n") || "Hali bot hech qaysi guruh yoki kanalga qo'shilmagan") +
      `\n\nHammasiga hozir yuborish: /reklama_hozir`
  );
});

bot.command("reklama_hozir", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const chats = (await listPromoChats()).filter((c: any) => c.is_active);
  await ctx.reply(`📤 ${chats.length} ta chatga yuborilmoqda...`);
  const adminChat = ctx.chat!.id;
  (async () => {
    let ok = 0;
    for (const c of chats) {
      if (await sendPromoToChat(Number(c.chat_id), promoSender)) ok++;
      await new Promise((r) => setTimeout(r, 400));
    }
    await bot.api.sendMessage(adminChat, `✅ Reklama ${ok}/${chats.length} ta chatga yuborildi`).catch(() => {});
  })();
});

// ====================== GURUH BUYRUQLARI ======================
function fmtPct(n: number) {
  return `${n >= 0 ? "▲ +" : "▼ "}${n.toFixed(1)}%`;
}

bot.command("narx", async (ctx) => {
  const q = arg(ctx).replace(/^\$/, "");
  if (!q) return void (await ctx.reply("Format: /narx BELGI (masalan /narx UZB)"));
  const list = await listTokensWithStats({ search: q, sort: "volume", limit: 3 });
  const t: any = list.find((x: any) => x.symbol.toUpperCase() === q.toUpperCase()) ?? list[0];
  if (!t) return void (await ctx.reply(`🔍 "${q}" topilmadi`));
  await ctx.reply(
    `🪙 ${t.name} ($${t.symbol})${t.is_pro ? " ✅" : ""}\n\n` +
      `💵 Narx: ${Number(t.current_price).toFixed(4)}\n` +
      `📊 24 soat: ${fmtPct(Number(t.change_24h))}\n` +
      `💰 24s hajm: ${Number(t.volume_24h).toFixed(2)} Nex\n` +
      `📦 Muomalada: ${Number(t.circulating_supply)} / ${Number(t.max_supply)}`,
    { reply_markup: { inline_keyboard: [[{ text: "🚀 Savdo qilish", url: `https://t.me/${BOT_USERNAME}?start=promo` }]] } }
  );
});

bot.command("top", async (ctx) => {
  const list = await listTokensWithStats({ featured: false, sort: "trend", limit: 7 });
  if (!list.length) return void (await ctx.reply("Hali tokenlar yo'q"));
  const lines = list.map((t: any, i: number) => `${i + 1}. $${t.symbol} — ${Number(t.current_price).toFixed(4)}  ${fmtPct(Number(t.change_24h))}`);
  await ctx.reply(`🔥 Trenddagi tokenlar (24 soat)\n\n${lines.join("\n")}`, {
    reply_markup: { inline_keyboard: [[{ text: "🚀 NexTrade'ni ochish", url: `https://t.me/${BOT_USERNAME}?start=promo` }]] },
  });
});

// 🤖 Nex AI: bugungi tavsiyalar (shaxsiy yoki guruhda)
bot.command("ai", async (ctx) => {
  const { analyzeAll } = await import("../services/nexAiService");
  const list = (await analyzeAll())
    .filter((a) => (a.signal === "strong_buy" || a.signal === "buy") && a.canBuy)
    .sort((x, y) => y.score * y.confidence - x.score * x.confidence).slice(0, 3);
  if (!list.length) return void (await ctx.reply("🤖 Nex AI: hozir ishonchli olish signali yo'q - bozorni kuzatib turing."));
  const lines = list.map((a, i) =>
    `${i + 1}. ${a.signal === "strong_buy" ? "🟢🟢" : "🟢"} $${a.symbol} — ${a.price < 1 ? a.price.toPrecision(4) : a.price.toFixed(2)} Nex · ishonch ${a.confidence}%\n   ${a.reasons[0]?.uz ?? ""}`);
  await ctx.reply(`🤖 Nex AI tavsiyalari\n\n${lines.join("\n\n")}\n\nBalansingizga mos summani ilovada ko'ring 👇\n⚠️ O'yin ichidagi algoritmik tahlil, kafolat bermaydi.`, {
    reply_markup: { inline_keyboard: [[{ text: "🤖 Nex AI'ni ochish", url: `https://t.me/${BOT_USERNAME}?start=promo` }]] },
  });
});

// Guruhda: o'yinchi shu guruh jamoasiga qo'shiladi
bot.command("qoshil", async (ctx) => {
  const chat: any = ctx.chat;
  if (!chat || chat.type === "private") return void (await ctx.reply("Bu buyruq guruh ichida yoziladi: guruh jamoasiga qo'shilasiz"));
  const title = await setUserGroup(ctx.from!.id, chat.id);
  if (title === null) {
    return void (await ctx.reply(`Avval botga kiring: @${BOT_USERNAME} → /start, keyin shu yerda /qoshil yozing`));
  }
  await ctx.reply(`✅ Siz "${title}" jamoasidasiz! Foydangiz guruhlar ligasida shu guruhga qo'shiladi 🏆\nReyting: /guruhlar`);
});

bot.command("guruhlar", async (ctx) => {
  const list = await getGroupLeague(10);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = list.map((g) => `${medals[g.rank - 1] ?? g.rank + "."} ${g.title ?? "Guruh"} — +${g.pnl.toFixed(2)} Nex (${g.members} o'yinchi)`);
  await ctx.reply(
    `🏟 Guruhlar ligasi (shu hafta)\n\n${lines.join("\n") || "Hali guruhlar yo'q"}\n\nGuruhingizni qo'shish: guruhda /qoshil yozing`
  );
});

// ====================== GIVEAWAY ======================
// /giveaway 50 100            - shu chatga (guruh/kanal) post
// /giveaway 50 100 @kanal     - shaxsiy chatdan kanalga post
bot.command("giveaway", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const [a, n, target] = arg(ctx).split(/\s+/);
  const amount = Number(a), count = Number(n);
  if (!amount || !count) {
    return void (await ctx.reply("Format: /giveaway 50 100 — birinchi 100 kishiga 50 Nex\nKanalga: /giveaway 50 100 @kanal_nomi"));
  }
  try {
    const chatId: any = target ? target : ctx.chat!.id;
    const gw = await createGiveaway(typeof chatId === "number" ? chatId : 0, amount, count);
    const msg: any = await bot.api.sendMessage(
      chatId,
      `🎁 GIVEAWAY!\n\nBirinchi ${count} kishiga +${amount} Nex Trade tekin!\n👇 Tugmani bosing (avval @${BOT_USERNAME} ga /start bosgan bo'lishingiz kerak)`,
      { reply_markup: { inline_keyboard: [[{ text: `🎁 Olish (0/${count})`, callback_data: `gw:${gw.id}` }]] } }
    );
    await pool.query("UPDATE giveaways SET chat_id = $2 WHERE id = $1", [gw.id, msg.chat?.id ?? 0]);
    await setGiveawayMessage(gw.id, msg.message_id);
    if (target) await ctx.reply(`✅ Giveaway ${target} ga joylandi`);
  } catch (err: any) {
    await ctx.reply(`⚠️ ${err?.description ?? err?.message}`);
  }
});

bot.on("callback_query:data", async (ctx) => {
  const data = (ctx as any).callbackQuery.data as string;
  if (!data.startsWith("gw:")) return void (await (ctx as any).answerCallbackQuery());
  try {
    const r = await claimGiveaway(Number(data.slice(3)), ctx.from!.id);
    await (ctx as any).answerCallbackQuery({ text: `🎉 +${r.reward} Nex balansingizga qo'shildi!`, show_alert: true });
    // Tugmadagi hisoblagichni har 5 ta olishda (yoki tugaganda) yangilaymiz - Telegram cheklovlari uchun
    if (r.messageId && (r.finished || r.claims % 5 === 0 || r.claims <= 3)) {
      await bot.api.editMessageReplyMarkup(r.chatId, r.messageId, {
        reply_markup: r.finished
          ? { inline_keyboard: [[{ text: `✅ Tugadi (${r.claims}/${r.max})`, url: `https://t.me/${BOT_USERNAME}?start=promo` }]] }
          : { inline_keyboard: [[{ text: `🎁 Olish (${r.claims}/${r.max})`, callback_data: data }]] },
      }).catch(() => {});
    }
  } catch (err: any) {
    const msg = err?.message === "NEED_START" ? `Avval @${BOT_USERNAME} ga kirib /start bosing, keyin qayta urinib ko'ring` : err?.message;
    await (ctx as any).answerCallbackQuery({ text: msg ?? "Xatolik", show_alert: true }).catch(() => {});
  }
});

// ====================== INLINE REJIM ======================
// Istalgan chatda: @NexTradexbot UZB  -> token kartasi
bot.on("inline_query", async (ctx) => {
  const q = String((ctx as any).inlineQuery.query ?? "").trim().replace(/^\$/, "").slice(0, 32);
  const list = q
    ? await listTokensWithStats({ search: q, sort: "volume", limit: 10 })
    : await listTokensWithStats({ featured: false, sort: "trend", limit: 10 });
  const results = list.map((t: any) => ({
    type: "article",
    id: `t${t.id}`,
    title: `$${t.symbol} · ${Number(t.current_price).toFixed(4)}  ${fmtPct(Number(t.change_24h))}`,
    description: `${t.name} — 24s hajm: ${Number(t.volume_24h).toFixed(2)} Nex`,
    input_message_content: {
      message_text:
        `🪙 ${t.name} ($${t.symbol})\n` +
        `💵 Narx: ${Number(t.current_price).toFixed(4)}  ${fmtPct(Number(t.change_24h))}\n\n` +
        `🎮 NexTrade — Telegram'dagi token birjasi o'yini. Tekin 100 Nex bilan boshlang!`,
    },
    reply_markup: { inline_keyboard: [[{ text: `🚀 $${t.symbol} ni sotib olish`, url: `https://t.me/${BOT_USERNAME}?start=promo` }]] },
  }));
  await (ctx as any).answerInlineQuery(results, { cache_time: 30 });
});

// ====================== ZAXIRA NUSXA ======================
// Zaxira qayerga yuboriladi: BACKUP_CHAT_ID (yopiq kanal, bot admin) yoki adminning shaxsiy chati
const BACKUP_CHAT_ID = Number(process.env.BACKUP_CHAT_ID ?? 0) || ADMIN_TELEGRAM_ID;

export async function sendBackupToAdmin(reason = `Avtomatik zaxira (har ${BACKUP_EVERY_HOURS} soatda)`) {
  if (!BACKUP_CHAT_ID) return false;
  // Bo'sh bazaning zaxirasi yaxshi zaxira ustidan qadalib qolmasin
  if (await isDatabaseEmpty()) return false;
  const b = await createBackup();
  const users = b.counts.users ?? 0, trades = b.counts.transactions ?? 0, tokens = b.counts.tokens ?? 0;
  const msg = await bot.api.sendDocument(BACKUP_CHAT_ID, new InputFile(b.buffer, b.filename), {
    caption: `💾 ${reason}\n👥 ${users} foydalanuvchi · 🪙 ${tokens} token · 🔁 ${trades} savdo\n\n` +
      `📌 Oxirgi zaxira doim qadalgan turadi. Baza o'chib ketsa, yangi bo'sh baza ulanganda server uni o'zi tiklaydi.\n` +
      `Qo'lda tiklash: shu faylga reply qilib /tiklash`,
    disable_notification: true,
  });
  // Qadab qo'yamiz - server keyin aynan shu (eng oxirgi) faylni topadi
  await bot.api.pinChatMessage(BACKUP_CHAT_ID, msg.message_id, { disable_notification: true })
    .catch((err: any) => console.error("⚠️ Zaxirani qadab bo'lmadi:", err?.description ?? err));
  await markBackupDone();
  return true;
}

/**
 * Baza bo'sh bo'lsa (masalan, Render bepul bazasi o'chib, yangisi ulangan) -
 * Telegram'da qadalgan oxirgi zaxiradan hamma ma'lumotni avtomatik tiklaydi.
 */
export async function autoRestoreFromTelegram(): Promise<boolean> {
  if (!BOT_TOKEN || !BACKUP_CHAT_ID || process.env.AUTO_RESTORE === "false") return false;
  if (!(await isDatabaseEmpty())) return false;
  const chat: any = await bot.api.getChat(BACKUP_CHAT_ID);
  const doc = chat?.pinned_message?.document;
  if (!doc || !/^nextrade-backup-.*\.json\.gz$/.test(doc.file_name ?? "")) {
    console.log("ℹ️ Avto-tiklash: qadalgan zaxira topilmadi - yangi baza sifatida ishga tushadi");
    return false;
  }
  const file: any = await bot.api.getFile(doc.file_id);
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`Zaxira faylini yuklab bo'lmadi (${res.status})`);
  const counts = await restoreBackup(Buffer.from(await res.arrayBuffer()));
  const text = `♻️ Baza bo'sh edi - qadalgan zaxiradan avtomatik tiklandi (${doc.file_name})\n` +
    `👥 ${counts.users ?? 0} foydalanuvchi, 🪙 ${counts.tokens ?? 0} token, 🔁 ${counts.transactions ?? 0} savdo`;
  console.log(text);
  if (ADMIN_TELEGRAM_ID) await bot.api.sendMessage(ADMIN_TELEGRAM_ID, text).catch(() => {});
  return true;
}

bot.command("zaxira", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.reply("💾 Zaxira tayyorlanmoqda...");
  try {
    await sendBackupToAdmin("Qo'lda olingan zaxira");
  } catch (err: any) {
    await ctx.reply(`⚠️ ${err?.description ?? err?.message}`);
  }
});

bot.command("tiklash", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const doc: any = ctx.message?.reply_to_message?.document;
  if (!doc) return void (await ctx.reply("Zaxira fayliga (.json.gz) reply qilib /tiklash yozing"));
  try {
    const file: any = await bot.api.getFile(doc.file_id);
    const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const counts = await restoreBackup(buf);
    await ctx.reply(`✅ Tiklandi!\n👥 ${counts.users ?? 0} foydalanuvchi, 🪙 ${counts.tokens ?? 0} token, 🔁 ${counts.transactions ?? 0} savdo`);
  } catch (err: any) {
    await ctx.reply(`⚠️ ${err?.message}`);
  }
});

bot.command("statistika", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const s: any = await getAdminStats();
  await ctx.reply(
    `📊 NexTrade statistikasi\n\n` +
      `👥 Jami o'yinchi: ${s.users}\n🆕 Bugun yangi: ${s.new_today}\n🔥 Bugun faol: ${s.active_today}\n📅 7 kunda faol: ${s.active_7d}\n` +
      `🔁 Kechagilarning bugun qaytgani: ${s.retention_d1 === null ? "—" : Math.round(s.retention_d1 * 100) + "%"} (${s.retention_cohort} kishidan)\n\n` +
      `🪙 Tokenlar: ${s.tokens}\n📈 Bugun savdo: ${s.trades_today} ta (${s.volume_today.toFixed(2)} Nex)\n` +
      `📢 Reklama chatlari: ${s.promo_chats}\n⭐ Jami Stars: ${s.stars_total}\n🚫 Botni bloklagan: ${s.blocked_bot}`
  );
});

// ====================== TELEGRAM STARS TO'LOVLARI ======================
bot.on("pre_checkout_query", async (ctx) => {
  const q = ctx.preCheckoutQuery;
  // Nex do'koni (Stars -> Nex)
  const np = parseNexPayload(q.invoice_payload);
  if (np) {
    try {
      const u = await pool.query("SELECT id FROM users WHERE id = $1 AND telegram_id = $2", [np.userId, q.from.id]);
      if (!u.rows[0]) throw new Error("To'lovchi mos kelmadi");
      const r = await resolveOffer(np.userId, np.offerId, np.dayKey);
      if (r.offer.stars !== q.total_amount) throw new Error("Narx o'zgardi - sahifani yangilang");
      await ctx.answerPreCheckoutQuery(true);
    } catch (err: any) {
      await ctx.answerPreCheckoutQuery(false, String(err?.message ?? "To'lovni amalga oshirib bo'lmadi"));
    }
    return;
  }
  const p = parsePayload(q.invoice_payload);
  try {
    if (!p) throw new Error("Noto'g'ri to'lov");
    await validateStarsPurchase(p.kind, p.tokenId, p.userId);
    await ctx.answerPreCheckoutQuery(true);
  } catch (err: any) {
    await ctx.answerPreCheckoutQuery(false, String(err?.message ?? "To'lovni amalga oshirib bo'lmadi"));
  }
});

bot.on("message:successful_payment", async (ctx) => {
  const sp = ctx.message.successful_payment;
  if (parseNexPayload(sp.invoice_payload)) {
    try {
      const r = await applyNexPayment(sp.invoice_payload, sp.telegram_payment_charge_id, sp.total_amount, ctx.from!.id);
      if (!r.already) await ctx.reply(`✅ Rahmat! Balansingizga +${r.nex.toLocaleString("ru-RU")} Nex qo'shildi.`);
    } catch (err: any) {
      console.error("❌ Nex to'lovini qo'llashda xato:", err);
      await ctx.reply("⚠️ To'lov qabul qilindi, lekin Nex qo'shishda xato bo'ldi. Admin tekshiradi.").catch(() => {});
      if (ADMIN_TELEGRAM_ID) sendTelegramMessage(ADMIN_TELEGRAM_ID, `⚠️ Nex to'lovi xatosi: ${sp.telegram_payment_charge_id} - ${err?.message ?? err}`);
    }
    return;
  }
  try {
    const r = await applyStarsPayment(sp.invoice_payload, sp.telegram_payment_charge_id, sp.total_amount, ctx.from!.id);
    if (r.already) return;
    await ctx.reply(
      r.kind === "pro"
        ? `✅ Rahmat! ${r.token?.name} ($${r.token?.symbol}) endi PRO tokeni!`
        : `📣 Rahmat! ${r.token?.name} ($${r.token?.symbol}) 24 soat davomida bozorning eng tepasida turadi!`
    );
  } catch (err: any) {
    console.error("❌ Stars to'lovini qo'llashda xato:", err);
    await ctx.reply("⚠️ To'lov qabul qilindi, lekin qo'llashda xato bo'ldi. Admin bilan bog'laning.");
  }
});

bot.catch((err) => {
  console.error("Bot xatosi:", err);
});

/**
 * Token yaratuvchisiga, uning tokenidan savdo (sotib olish/sotish) bo'lganda
 * ulushiga qo'shilgan komissiya haqida Telegram orqali xabar yuboradi.
 *
 * tradeService.ts dagi buyToken/sellToken funksiyalari tranzaksiya muvaffaqiyatli
 * COMMIT bo'lgandan keyin shu funksiyani chaqiradi. Xabar yuborish xatoga uchrasa
 * (masalan, foydalanuvchi botni bloklagan bo'lsa) bu savdo natijasiga ta'sir
 * qilmasligi kerak - shuning uchun xato shu yerning o'zida ushlanadi.
 */
export async function notifyCreatorCommission(
  creatorTelegramId: number,
  tokenName: string,
  tokenSymbol: string,
  commissionAmount: number,
  tradeType: "buy" | "sell"
): Promise<void> {
  const actionLabel = tradeType === "buy" ? "sotib olindi" : "sotildi";
  try {
    await bot.api.sendMessage(
      creatorTelegramId,
      `💰 Sizga bonus qo'shildi!\n\n` +
        `${tokenName} ($${tokenSymbol}) tokeningizdan ${actionLabel}.\n` +
        `+${commissionAmount.toFixed(4)} Nex Trade "Bonuslar" jamg'armangizga qo'shildi.\n` +
        `Ilovadagi Profil > Bonuslar bo'limidan haftada 1 marta asosiy balansingizga o'tkazib olishingiz mumkin.`
    );
  } catch (err) {
    console.error("⚠️ Yaratuvchiga komissiya xabarini yuborib bo'lmadi:", err);
  }
}

bot.command("stats", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId || telegramId !== ADMIN_TELEGRAM_ID) {
    return;
  }

  const stats = await getPlatformStats();
  await ctx.reply(
    `📊 Platforma statistikasi\n\n` +
      `👥 Foydalanuvchilar: ${stats.total_users}\n` +
      `🪙 Yaratilgan tokenlar: ${stats.total_tokens}\n` +
      `💰 Muomaladagi Nex Trade: ${Number(stats.total_nex_trade_circulating).toFixed(2)}\n` +
      `🔁 Jami savdolar: ${stats.total_trades}\n` +
      `📈 Savdo hajmi: ${Number(stats.total_volume).toFixed(2)} Nex Trade`
  );
});
