import { Router } from "express";
import { z } from "zod";
import { getOrCreateUser, getUserHoldings, getReferralCount } from "../services/userService";
import {
  createToken,
  getToken,
  listTopTokens,
  listLeaderboard,
  getTokenHistory,
  getTokenChartData,
  getTokensByOwner,
  searchTokens,
} from "../services/tokenService";
import { buyToken, sellToken } from "../services/tradeService";

export const apiRouter = Router();

// Foydalanuvchini ro'yxatdan o'tkazish / olish
apiRouter.post("/user/init", async (req, res) => {
  const schema = z.object({
    telegram_id: z.number(),
    username: z.string().optional(),
    referrer_telegram_id: z.number().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const user = await getOrCreateUser(
    parsed.data.telegram_id,
    parsed.data.username,
    parsed.data.referrer_telegram_id
  );
  res.json(user);
});

// Foydalanuvchining profil ma'lumotlari: nechta odam taklif qilgani
apiRouter.get("/user/:userId/referrals", async (req, res) => {
  const count = await getReferralCount(Number(req.params.userId));
  res.json({ count });
});

// Foydalanuvchi o'zi yaratgan tokenlar (profil sahifasi)
apiRouter.get("/user/:userId/created-tokens", async (req, res) => {
  const tokens = await getTokensByOwner(Number(req.params.userId));
  res.json(tokens);
});

// Foydalanuvchi tokenlari (portfel)
apiRouter.get("/user/:userId/holdings", async (req, res) => {
  const holdings = await getUserHoldings(Number(req.params.userId));
  res.json(holdings);
});

// Yangi token yaratish
apiRouter.post("/tokens", async (req, res) => {
  const schema = z.object({
    owner_id: z.number(),
    name: z.string().min(1).max(64),
    symbol: z.string().min(1).max(16),
    max_supply: z.number().positive().max(10000),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  try {
    const token = await createToken(
      parsed.data.owner_id,
      parsed.data.name,
      parsed.data.symbol,
      parsed.data.max_supply
    );
    res.json(token);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Top tokenlar ro'yxati (bozor)
apiRouter.get("/tokens", async (req, res) => {
  const q = req.query.q as string | undefined;
  const tokens = q && q.trim() ? await searchTokens(q.trim()) : await listTopTokens();
  res.json(tokens);
});

apiRouter.get("/tokens/:id", async (req, res) => {
  const token = await getToken(Number(req.params.id));
  if (!token) return res.status(404).json({ error: "Token topilmadi" });
  res.json(token);
});

// Bozor qiymati bo'yicha eng yuqori tokenlar (reyting)
apiRouter.get("/leaderboard", async (_req, res) => {
  const tokens = await listLeaderboard();
  res.json(tokens);
});

// Bitta tokenning savdo tarixi (faqat "Savdo tarixi" ro'yxati uchun)
apiRouter.get("/tokens/:id/history", async (req, res) => {
  const history = await getTokenHistory(Number(req.params.id));
  res.json(history);
});

// Narx grafigi uchun - savdolar + avtomatik tebranishlar birga
apiRouter.get("/tokens/:id/chart", async (req, res) => {
  const chart = await getTokenChartData(Number(req.params.id));
  res.json(chart);
});

// Sotib olish
apiRouter.post("/trade/buy", async (req, res) => {
  const schema = z.object({
    user_id: z.number(),
    token_id: z.number(),
    amount: z.number().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  try {
    const result = await buyToken(parsed.data.user_id, parsed.data.token_id, parsed.data.amount);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Sotish
apiRouter.post("/trade/sell", async (req, res) => {
  const schema = z.object({
    user_id: z.number(),
    token_id: z.number(),
    amount: z.number().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  try {
    const result = await sellToken(parsed.data.user_id, parsed.data.token_id, parsed.data.amount);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
