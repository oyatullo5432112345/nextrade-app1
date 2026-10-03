import { Request, Response, NextFunction } from "express";

/**
 * SO'ROVLAR CHASTOTASINI CHEKLASH (v6)
 * Skript bilan soniyasiga yuzlab so'rov yuborib serverni qotirish yoki
 * bonus/savdo tugmalarini "bombardimon" qilishning oldini oladi.
 * Oddiy xotirada ishlaydi (bitta server uchun yetarli).
 */

interface Bucket { count: number; resetAt: number; }

export function rateLimit(opts: { windowMs: number; max: number; key: (req: Request) => string; message?: string }) {
  const buckets = new Map<string, Bucket>();
  // Eskirgan yozuvlarni vaqti-vaqti bilan tozalaymiz
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, Math.max(opts.windowMs, 30_000)).unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = opts.key(req);
    if (!key) return next();
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: opts.message ?? "Juda ko'p so'rov. Bir oz kutib, qayta urinib ko'ring" });
    }
    next();
  };
}

// IP bo'yicha umumiy cheklov. O'zbekistonda mobil operatorlar ko'p odamni
// bitta IP ortida chiqaradi, shuning uchun chegara katta.
export const ipLimiter = rateLimit({
  windowMs: 10_000,
  max: Number(process.env.RATE_LIMIT_IP ?? 400),
  key: (req) => req.ip ?? "",
});

// Foydalanuvchi bo'yicha: pul o'zgartiradigan (POST/DELETE) so'rovlar
export const writeLimiter = rateLimit({
  windowMs: 10_000,
  max: Number(process.env.RATE_LIMIT_WRITES ?? 25),
  key: (req) => (req.method === "GET" ? "" : req.user ? `u${req.user.id}` : ""),
  message: "Juda tez bosyapsiz 🙂 Bir necha soniya kuting",
});
