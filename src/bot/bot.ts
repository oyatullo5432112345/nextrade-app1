import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import { getOrCreateUser, getPlatformStats } from "../services/userService";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const MINI_APP_URL = process.env.MINI_APP_URL ?? "https://example.com";
const BOT_USERNAME = process.env.BOT_USERNAME ?? "your_bot";
const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? "0");

export const bot = new Bot(BOT_TOKEN);

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

  const keyboard = new InlineKeyboard().webApp("🚀 NexTrade'ni ochish", MINI_APP_URL);

  const bonusNote = referrerTelegramId
    ? "\n\n🎁 Referal havolasi orqali kirganingiz uchun qo'shimcha bonus qo'shildi!"
    : "";

  await ctx.reply(
    `NexTrade platformasiga xush kelibsiz!\n\n` +
      `💰 Balansingiz: ${user.nex_trade_balance} Nex Trade\n\n` +
      `NexTrade — bu o'zingizning shaxsiy tokeningizni yaratib, boshqa foydalanuvchilar bilan erkin savdo qilishingiz mumkin bo'lgan platforma. ` +
      `Token narxi faqat bozor talabiga (sotib olish/sotish) qarab avtomatik o'zgaradi.${bonusNote}\n\n` +
      `Pastdagi tugma orqali ilovani oching 👇\n\n` +
      `Do'stlaringizni taklif qilib bonus olish uchun /referral buyrug'ini yuboring.`,
    { reply_markup: keyboard }
  );
});

bot.command("referral", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const link = `https://t.me/${BOT_USERNAME}?start=ref_${telegramId}`;
  await ctx.reply(
    `👥 Do'stlaringizni taklif qiling va bonus Nex Trade oling!\n\n` +
      `Har bir yangi do'stingiz ushbu havola orqali qo'shilganda, ikkalangizga ham qo'shimcha bonus beriladi.\n\n` +
      `Sizning shaxsiy havolangiz:\n${link}`
  );
});

bot.catch((err) => {
  console.error("Bot xatosi:", err);
});

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
