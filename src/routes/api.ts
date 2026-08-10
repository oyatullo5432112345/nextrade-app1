import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getOrCreateUser, getUserHoldings, getReferralCount, getUserLeaderboard, claimDailyBonus } from "../services/userService";
import { getBalanceHistory } from "../services/balanceHistoryService";
import {
  createToken,
  getToken,
  listTopTokens,
  getFeaturedTokens,
  listLeaderboard,
  getTokenHistory,
  getTokenChartData,
  getTokensByOwner,
  searchTokens,
  boostToken,
  getTradeQuote,
  upgradeTokenToPro,
  getProBadgeCost,
} from "../services/tokenService";
import { buyToken, sellToken } from "../services/tradeService";
import { getFavoriteTokens, getFavoriteTokenIds, toggleFavorite } from "../services/favoriteService";
import { getUserAlerts, subscribeAlert, unsubscribeAlert } from "../services/alertService";
import { listFrozenBalances, getTotalFrozen, withdrawFrozen } from "../services/frozenService";
import { getNexTradePrice, getNexTradePriceChart } from "../services/nexTradePriceService";
import { getWalletInfo, sendTransfer, getTransferHistory } from "../services/walletService";

export const apiRouter = Router();

// Har bir async route handlerni xato ushlaydigan qilib o'raydi - shu tufayli
// kutilmagan (masalan, baza) xatolar ham foydalanuvchiga tushunarli JSON
// xabar sifatida qaytadi, xom texnik xato o'rniga.
type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<any>;
function ah(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// Foydalanuvchini ro'yxatdan o'tkazish / olish
apiRouter.post("/user/init", ah(async (req, res) => {
  const schema = z.object({
    telegram_id: z.number(),
    username: z.string().optional(),
    referrer_telegram_id: z.number().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlar noto'g'ri kiritildi" });

  const user = await getOrCreateUser(
    parsed.data.telegram_id,
    parsed.data.username,
    parsed.data.referrer_telegram_id
  );
  res.json(user);
}));

// Foydalanuvchining profil ma'lumotlari: nechta odam taklif qilgani
apiRouter.get("/user/:userId/referrals", ah(async (req, res) => {
  const count = await getReferralCount(Number(req.params.userId));
  res.json({ count });
}));

// Foydalanuvchi o'zi yaratgan tokenlar (profil sahifasi)
apiRouter.get("/user/:userId/created-tokens", ah(async (req, res) => {
  const tokens = await getTokensByOwner(Number(req.params.userId));
  res.json(tokens);
}));

// Foydalanuvchi tokenlari (portfel)
apiRouter.get("/user/:userId/holdings", ah(async (req, res) => {
  const holdings = await getUserHoldings(Number(req.params.userId));
  res.json(holdings);
}));

// Kunlik bonusni olish (24 soatda bir marta)
apiRouter.post("/user/:userId/daily-bonus", ah(async (req, res) => {
  try {
    const result = await claimDailyBonus(Number(req.params.userId));
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

// Foydalanuvchi balansining vaqt bo'yicha tarixi (Portfolio grafigi uchun)
apiRouter.get("/user/:userId/balance-history", ah(async (req, res) => {
  const history = await getBalanceHistory(Number(req.params.userId));
  res.json(history);
}));

// ====== HAMYON (WALLET) - foydalanuvchilar orasida Nex Trade jo'natish ======

// Hamyon kodi va balans
apiRouter.get("/user/:userId/wallet", ah(async (req, res) => {
  const wallet = await getWalletInfo(Number(req.params.userId));
  res.json(wallet);
}));

// O'tkazmalar tarixi (yuborilgan/qabul qilingan)
apiRouter.get("/user/:userId/wallet/history", ah(async (req, res) => {
  const history = await getTransferHistory(Number(req.params.userId));
  res.json(history);
}));

// Boshqa foydalanuvchiga hamyon kodi orqali Nex Trade jo'natish
apiRouter.post("/wallet/transfer", ah(async (req, res) => {
  const schema = z.object({
    from_user_id: z.number(),
    to_wallet_code: z.string().min(4).max(16),
    amount: z.number().positive(),
    note: z.string().max(140).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlarni to'g'ri kiriting" });

  try {
    const result = await sendTransfer(
      parsed.data.from_user_id,
      parsed.data.to_wallet_code,
      parsed.data.amount,
      parsed.data.note
    );
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

// Yangi token yaratish
apiRouter.post("/tokens", ah(async (req, res) => {
  const schema = z.object({
    owner_id: z.number(),
    name: z.string().min(1).max(64),
    symbol: z.string().min(1).max(16),
    max_supply: z.number().positive().max(10000),
    image_url: z.string().url().max(1000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Hamma maydonlarni to'g'ri to'ldiring" });

  try {
    const token = await createToken(
      parsed.data.owner_id,
      parsed.data.name,
      parsed.data.symbol,
      parsed.data.max_supply,
      parsed.data.image_url
    );
    res.json(token);
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "Bu belgi (symbol) allaqachon band. Boshqasini tanlang" });
    }
    res.status(400).json({ error: err.message });
  }
}));

// Token egasi o'z Nex Trade'idan tokeniga mablag' kiritib, narxini
// qaytarilmas tarzda oshiradi ("boost")
apiRouter.post("/tokens/:id/boost", ah(async (req, res) => {
  const schema = z.object({
    user_id: z.number(),
    amount: z.number().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Miqdorni to'g'ri kiriting" });

  try {
    const result = await boostToken(Number(req.params.id), parsed.data.user_id, parsed.data.amount);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

// PRO nishoni narxini bilish uchun (frontendda tugma matnida ko'rsatish uchun)
apiRouter.get("/pro-badge-cost", (_req, res) => {
  res.json({ cost: getProBadgeCost() });
});

// Token egasi ichki Nex Trade sarflab tokenini "PRO" (tasdiqlangan) deb belgilaydi.
// Bu faqat reklama/nishon maqsadida - real pulga aloqasi yo'q.
apiRouter.post("/tokens/:id/pro-upgrade", ah(async (req, res) => {
  const schema = z.object({ user_id: z.number() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "user_id kerak" });

  try {
    const token = await upgradeTokenToPro(Number(req.params.id), parsed.data.user_id);
    res.json(token);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

// Top tokenlar ro'yxati (bozor)
apiRouter.get("/tokens", ah(async (req, res) => {
  const q = req.query.q as string | undefined;
  const tokens = q && q.trim() ? await searchTokens(q.trim()) : await listTopTokens();
  res.json(tokens);
}));

// Platforma tomonidan yaratilgan "gigant" tokenlar (bozorda alohida joyda)
apiRouter.get("/tokens/featured", ah(async (_req, res) => {
  const tokens = await getFeaturedTokens();
  res.json(tokens);
}));

apiRouter.get("/tokens/:id", ah(async (req, res) => {
  const token = await getToken(Number(req.params.id));
  if (!token) return res.status(404).json({ error: "Token topilmadi" });
  res.json(token);
}));

// Savdo tugmasini bosishdan oldin: "shuncha token = shuncha Nex Trade" oldindan ko'rsatish
apiRouter.get("/tokens/:id/quote", ah(async (req, res) => {
  const side = req.query.side === "sell" ? "sell" : "buy";
  const amount = Number(req.query.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Miqdorni kiriting" });

  try {
    const quote = await getTradeQuote(Number(req.params.id), side, amount);
    res.json(quote);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

// Bozor qiymati bo'yicha eng yuqori tokenlar (reyting)
apiRouter.get("/leaderboard", ah(async (_req, res) => {
  const tokens = await listLeaderboard();
  res.json(tokens);
}));

// Eng ko'p Nex Trade balansiga ega foydalanuvchilar reytingi
apiRouter.get("/leaderboard/users", ah(async (_req, res) => {
  const users = await getUserLeaderboard();
  res.json(users);
}));

// Bitta tokenning savdo tarixi (faqat "Savdo tarixi" ro'yxati uchun)
apiRouter.get("/tokens/:id/history", ah(async (req, res) => {
  const history = await getTokenHistory(Number(req.params.id));
  res.json(history);
}));

// Narx grafigi uchun - savdolar + avtomatik tebranishlar birga
apiRouter.get("/tokens/:id/chart", ah(async (req, res) => {
  const chart = await getTokenChartData(Number(req.params.id));
  res.json(chart);
}));

// Sotib olish
apiRouter.post("/trade/buy", ah(async (req, res) => {
  const schema = z.object({
    user_id: z.number(),
    token_id: z.number(),
    amount: z.number().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Miqdorni to'g'ri kiriting" });

  try {
    const result = await buyToken(parsed.data.user_id, parsed.data.token_id, parsed.data.amount);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

// Sotish
apiRouter.post("/trade/sell", ah(async (req, res) => {
  const schema = z.object({
    user_id: z.number(),
    token_id: z.number(),
    amount: z.number().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Miqdorni to'g'ri kiriting" });

  try {
    const result = await sellToken(parsed.data.user_id, parsed.data.token_id, parsed.data.amount);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

// ====== SEVIMLILAR ======

// Foydalanuvchining sevimli tokenlari (to'liq ma'lumot bilan)
apiRouter.get("/user/:userId/favorites", ah(async (req, res) => {
  const tokens = await getFavoriteTokens(Number(req.params.userId));
  res.json(tokens);
}));

// Faqat id'lar - frontendda yulduzcha holatini tez belgilash uchun
apiRouter.get("/user/:userId/favorites/ids", ah(async (req, res) => {
  const ids = await getFavoriteTokenIds(Number(req.params.userId));
  res.json(ids);
}));

// Sevimlilarga qo'shish/olib tashlash
apiRouter.post("/favorites/toggle", ah(async (req, res) => {
  const schema = z.object({
    user_id: z.number(),
    token_id: z.number(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlar noto'g'ri kiritildi" });

  try {
    const result = await toggleFavorite(parsed.data.user_id, parsed.data.token_id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

// ====== BILDIRISHNOMA SOZLAMALARI ======

// Foydalanuvchining faol bildirishnoma obunalari
apiRouter.get("/user/:userId/alerts", ah(async (req, res) => {
  const alerts = await getUserAlerts(Number(req.params.userId));
  res.json(alerts);
}));

// Token uchun bildirishnomaga obuna bo'lish (yoki chegara foizini yangilash)
apiRouter.post("/alerts", ah(async (req, res) => {
  const schema = z.object({
    user_id: z.number(),
    token_id: z.number(),
    threshold_pct: z.number().positive().max(100).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlar noto'g'ri kiritildi" });

  try {
    const alert = await subscribeAlert(
      parsed.data.user_id,
      parsed.data.token_id,
      parsed.data.threshold_pct ?? 5
    );
    res.json(alert);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

// Bildirishnoma obunasidan chiqish
apiRouter.delete("/alerts", ah(async (req, res) => {
  const schema = z.object({
    user_id: z.number(),
    token_id: z.number(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlar noto'g'ri kiritildi" });

  await unsubscribeAlert(parsed.data.user_id, parsed.data.token_id);
  res.json({ ok: true });
}));

// ====== ADMIN: MUZLATILGAN MABLAG' FONDI ======
// Har bir savdo komissiyasining 0.15% qismi shu fondga yig'iladi va faqat
// admin (ADMIN_TELEGRAM_ID) tomonidan bot/mini-appni rivojlantirish uchun
// yechib olinishi mumkin.

// Muzlatilgan mablag'lar ro'yxati (token bo'yicha) va jami summa
apiRouter.get("/admin/frozen", ah(async (req, res) => {
  const adminTelegramId = Number(req.query.admin_telegram_id);
  if (!adminTelegramId || adminTelegramId !== Number(process.env.ADMIN_TELEGRAM_ID ?? "0")) {
    return res.status(403).json({ error: "Bu amal faqat admin uchun ruxsat etilgan" });
  }

  const [balances, total] = await Promise.all([listFrozenBalances(), getTotalFrozen()]);
  res.json({ total, balances });
}));

// Admin muzlatilgan fonddan mablag' yechib oladi (o'z balansiga o'tkaziladi)
apiRouter.post("/admin/frozen/withdraw", ah(async (req, res) => {
  const schema = z.object({
    admin_telegram_id: z.number(),
    token_id: z.number(),
    amount: z.number().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlar noto'g'ri kiritildi" });

  try {
    const result = await withdrawFrozen(
      parsed.data.admin_telegram_id,
      parsed.data.token_id,
      parsed.data.amount
    );
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

// Sog'liqni tekshirish - UptimeRobot yoki boshqa monitoring xizmati uchun
// (bu manzilni tashqi xizmat muntazam chaqirsa, Render serveri "uxlab qolmaydi")
apiRouter.get("/ping", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ====== NEX TRADE (ASOSIY VALYUTA) NARXI ======
// 1 Nex Trade ning real (UZS) qiymati - boshlang'ich 0.9957 UZS, bozorga
// qarab (avtomatik tebranish orqali) ko'payadi/kamayadi.

// Hozirgi narx
apiRouter.get("/nextrade/price", ah(async (_req, res) => {
  const price = await getNexTradePrice();
  res.json(price);
}));

// Narx grafigi (tarix)
apiRouter.get("/nextrade/chart", ah(async (_req, res) => {
  const chart = await getNexTradePriceChart();
  res.json(chart);
}));
