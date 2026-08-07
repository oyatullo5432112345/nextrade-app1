import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import { getOrCreateUser } from "../services/userService";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const MINI_APP_URL = process.env.MINI_APP_URL ?? "https://example.com";

export const bot = new Bot(BOT_TOKEN);

bot.command("start", async (ctx) => {
  const telegramId = ctx.from?.id;
  const username = ctx.from?.username;
  if (!telegramId) return;

  await getOrCreateUser(telegramId, username);

  const keyboard = new InlineKeyboard().webApp(
    "🚀 NexTrade'ni ochish",
    MINI_APP_URL
  );

  await ctx.reply(
    "NexTrade platformasiga xush kelibsiz!\n\n" +
      "Sizga boshlang'ich 100 ta Nex Trade token berildi. " +
      "O'z tokeningizni yarating yoki boshqalarnikini soting-oling!",
    { reply_markup: keyboard }
  );
});

bot.catch((err) => {
  console.error("Bot xatosi:", err);
});
