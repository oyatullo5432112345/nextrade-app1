import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import { getOrCreateUser, getPlatformStats, getUserLeaderboard, claimDailyBonus } from "../services/userService";
import { listFrozenBalances, getTotalFrozen, withdrawFrozen } from "../services/frozenService";

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
    const result = await claimDailyBonus(user.id);
    await ctx.reply(
      `🎁 Kunlik bonus olindi: +${result.bonus} Nex Trade!\n` +
        `💰 Yangi balans: ${Number(result.newBalance).toFixed(2)} Nex Trade`
    );
  } catch (err: any) {
    await ctx.reply(`⏳ ${err.message}`);
  }
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
