import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { getOrCreateUser, User } from "../services/userService";

/**
 * TELEGRAM MINI APP AUTENTIFIKATSIYASI
 *
 * Avval API har bir so'rovda `user_id` ni frontenddan (body/URL) qabul qilardi
 * va uni HECH QANDAY tekshiruvsiz ishlatardi. Ya'ni istalgan odam Postman
 * orqali `from_user_id: 5` yuborib, boshqa odamning pulini o'ziga o'tkazib
 * olishi mumkin edi.
 *
 * Endi frontend har bir so'rovga Telegram bergan `initData` satrini
 * `X-Telegram-Init-Data` sarlavhasida yuboradi. Bu satr Telegram tomonidan
 * BOT_TOKEN bilan imzolangan - uni soxtalashtirib bo'lmaydi. Server imzoni
 * tekshiradi va foydalanuvchini FAQAT shu yerdan aniqlaydi (req.user).
 *
 * Hujjat: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? "0");

// initData qancha vaqt amal qiladi (soniyada). Mini App uzoq ochiq tursa ham
// ishlashi uchun standart 24 soat.
const INIT_DATA_MAX_AGE_SEC = Number(process.env.INIT_DATA_MAX_AGE_SEC ?? 24 * 60 * 60);

// Faqat lokal sinov uchun: brauzerda (Telegram'siz) ochganda body'dagi
// telegram_id ni qabul qiladi. PRODUCTION'DA HECH QACHON YOQMANG.
const ALLOW_DEV_AUTH = process.env.ALLOW_DEV_AUTH === "true";

export interface TelegramInitUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface VerifiedInitData {
  user: TelegramInitUser;
  startParam?: string;
  authDate: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      tgStartParam?: string;
    }
  }
}

/**
 * initData satrini tekshiradi. To'g'ri bo'lsa foydalanuvchi ma'lumotini,
 * aks holda null qaytaradi.
 */
export function verifyInitData(initData: string, botToken = BOT_TOKEN): VerifiedInitData | null {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(expectedHash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!authDate) return null;
  const ageSec = Date.now() / 1000 - authDate;
  if (ageSec > INIT_DATA_MAX_AGE_SEC) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;
  let user: TelegramInitUser;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return null;
  }
  if (!user || typeof user.id !== "number") return null;

  return { user, startParam: params.get("start_param") ?? undefined, authDate };
}

const lastTouched = new Map<number, number>();
function touchLastSeen(userId: number) {
  const now = Date.now();
  if ((lastTouched.get(userId) ?? 0) > now - 5 * 60_000) return;
  lastTouched.set(userId, now);
  import("../db/pool")
    .then(({ pool }) => pool.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1", [userId]))
    .catch(() => {});
}

function parseReferrer(startParam?: string): number | undefined {
  if (!startParam || !startParam.startsWith("ref_")) return undefined;
  const n = Number(startParam.slice(4));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Himoyalangan route'lar uchun middleware. Muvaffaqiyatli bo'lsa `req.user`
 * bazadagi haqiqiy foydalanuvchi bo'ladi (kerak bo'lsa yaratiladi).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const initData = req.header("x-telegram-init-data") ?? "";
    const verified = verifyInitData(initData);

    if (verified) {
      req.tgStartParam = verified.startParam;
      req.user = await getOrCreateUser(
        verified.user.id,
        verified.user.username,
        parseReferrer(verified.startParam)
      );
      if ((req.user as any).is_banned) {
        return res.status(403).json({ error: "Hisobingiz qoidabuzarlik uchun bloklangan" });
      }
      // Oxirgi faollik (eslatmalar va statistika uchun) - 5 daqiqada bir marta yoziladi
      touchLastSeen(req.user.id);
      return next();
    }

    if (ALLOW_DEV_AUTH && !initData) {
      const devId = Number(req.body?.telegram_id ?? req.query?.dev_telegram_id ?? 0);
      if (devId) {
        req.user = await getOrCreateUser(devId, "dev_" + devId);
        return next();
      }
    }

    return res.status(401).json({
      error: "Avtorizatsiya xatosi. Ilovani Telegram ichida qayta oching",
    });
  } catch (err) {
    next(err);
  }
}

/**
 * URL'dagi :userId so'rov yuborgan foydalanuvchiga tegishli ekanini tekshiradi -
 * boshqa birovning portfeli, hamyoni, tarixini ko'rib bo'lmasligi uchun.
 */
export function requireSelf(req: Request, res: Response, next: NextFunction) {
  const paramId = Number(req.params.userId);
  if (!req.user || paramId !== req.user.id) {
    return res.status(403).json({ error: "Bu ma'lumotga ruxsat yo'q" });
  }
  next();
}

export function isAdmin(user?: User): boolean {
  return Boolean(user && ADMIN_TELEGRAM_ID && Number(user.telegram_id) === ADMIN_TELEGRAM_ID);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Bu amal faqat admin uchun ruxsat etilgan" });
  }
  next();
}
