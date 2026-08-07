import { Router } from "express";
import { z } from "zod";
import { getOrCreateUser, getUserHoldings } from "../services/userService";
import {
  createToken,
  getToken,
  listTopTokens,
  listLeaderboard,
  getTokenHistory,
} from "../services/tokenService";
import { buyToken, sellToken } from "../services/tradeService";

export const apiRouter = Router();

// Foydalanuvchini ro'yxatdan o'tkazish / olish
apiRouter.post("/user/init", async (req, res) => {
  const schema = z.object({
    telegram_id: z.number(),
    username: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const user = await getOrCreateUser(parsed.data.telegram_id, parsed.data.username);
  res.json(user);
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
apiRouter.get("/tokens", async (_req, res) => {
  const tokens = await listTopTokens();
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

// Bitta tokenning savdo tarixi (grafik va ro'yxat uchun)
apiRouter.get("/tokens/:id/history", async (req, res) => {
  const history = await getTokenHistory(Number(req.params.id));
  res.json(history);
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
