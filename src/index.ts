import dotenv from "dotenv";
dotenv.config();

import path from "path";
import crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { webhookCallback } from "grammy";
import { apiRouter } from "./routes/api";
import { ipLimiter } from "./middleware/rateLimit";
import { bot, setupBotMenu, promoSender, autoRestoreFromTelegram } from "./bot/bot";
import { startPromoScheduler } from "./services/promoService";
import { startJobs } from "./jobs";
import { seedAllGenesis } from "./services/orderBookService";
import { ensureSchema } from "./db/ensureSchema";
import { migrateFromOldDatabase } from "./db/migrateFrom";
import { pool } from "./db/pool";

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "100kb" }));

app.use("/api", ipLimiter, apiRouter);

// /api ostidagi mavjud bo'lmagan yo'llar uchun HTML emas, JSON qaytaramiz -
// aks holda frontend "Server javobi noto'g'ri formatda" deb chiqarardi.
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: "Bunday API manzili topilmadi" });
});

// Mini App'ning o'zini ham shu serverdan beramiz (public/index.html).
// Shunda MINI_APP_URL = https://<render-nomi>.onrender.com bo'lishi mumkin.
app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "5m" }));

// Umumiy xato ishlovchi - kutilmagan xatolar ham JSON ko'rinishida qaytadi
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("❌ Server xatosi:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Serverda xatolik yuz berdi. Birozdan so'ng qayta urinib ko'ring" });
});

const PORT = Number(process.env.PORT ?? 3000);
const BOT_TOKEN = process.env.BOT_TOKEN ?? "";

// Render o'zi RENDER_EXTERNAL_URL ni beradi. Agar u (yoki WEBHOOK_URL) bo'lsa -
// bot WEBHOOK rejimida ishlaydi. Bu Render bepul tarifida juda muhim:
// server "uxlab" qolganda polling to'xtaydi va bot javob bermay qo'yardi.
// Webhook'da esa Telegram so'rovining o'zi serverni uyg'otadi.
const PUBLIC_URL = (process.env.WEBHOOK_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/+$/, "");
const USE_WEBHOOK = Boolean(PUBLIC_URL) && process.env.BOT_MODE !== "polling";

let hookRegistered = false;

async function startBot() {
  if (!BOT_TOKEN) {
    console.warn("⚠️ BOT_TOKEN yo'q - bot ishga tushirilmadi");
    return;
  }

  await bot.init();

  if (USE_WEBHOOK) {
    const secret = crypto.createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 32);
    const hookPath = `/tg-webhook/${secret}`;
    if (!hookRegistered) {
      app.post(hookPath, webhookCallback(bot, "express", { secretToken: secret }));
      hookRegistered = true;
    }
    await bot.api.setWebhook(`${PUBLIC_URL}${hookPath}`, {
      secret_token: secret,
      drop_pending_updates: false,
    });
    console.log("✅ Telegram bot WEBHOOK rejimida ishga tushdi");
  } else {
    await bot.api.deleteWebhook().catch(() => {});
    // Deploy paytida eski nusxa hali ishlayotgan bo'lsa 409 xato bo'ladi -
    // jarayonni yiqitmasdan qayta urinamiz.
    const run = () =>
      bot.start({ drop_pending_updates: false }).catch((err) => {
        console.error("⚠️ Bot polling xatosi, 10 soniyadan keyin qayta urinamiz:", err?.description ?? err);
        setTimeout(run, 10_000);
      });
    run();
    console.log("✅ Telegram bot POLLING rejimida ishga tushdi");
  }

  await setupBotMenu().catch((err) => console.error("⚠️ Bot menyusini sozlab bo'lmadi:", err?.description ?? err));
}

async function bootstrap() {
  await ensureSchema();
  // MIGRATE_FROM_URL berilgan bo'lsa - eski bazadan ma'lumotlarni ko'chiradi (bir marta)
  await migrateFromOldDatabase();
  // Baza bo'sh bo'lsa - Telegram'da qadalgan oxirgi zaxiradan avtomatik tiklaymiz
  if (BOT_TOKEN) {
    await autoRestoreFromTelegram().catch((err) => console.error("❌ Avto-tiklashda xato:", err?.description ?? err?.message ?? err));
  }

  const server = app.listen(PORT, () => {
    console.log(`✅ Server ${PORT}-portda ishga tushdi`);
  });

  // Eski tokenlar uchun order book (platforma sotuv zinapoyasi) - bir marta
  await seedAllGenesis().catch((err) => console.error("❌ Order book'ga o'tkazishda xato:", err));

  // Fon vazifalari bot ishga tushishidan MUSTAQIL ishlaydi (Telegram vaqtincha
  // javob bermasa ham liga, zaxira, IPO va h.k. to'xtab qolmasin)
  startJobs();
  if (BOT_TOKEN) startPromoScheduler(promoSender);

  // Bot: xato bo'lsa (masalan, Telegram 429 yoki tarmoq) 30 soniyadan keyin qayta urinadi
  const tryStartBot = async (attempt = 1): Promise<void> => {
    try {
      await startBot();
    } catch (err: any) {
      console.error(`❌ Botni ishga tushirishda xato (urinish ${attempt}):`, err?.description ?? err);
      if (attempt < 20) setTimeout(() => tryStartBot(attempt + 1), 30_000);
    }
  };
  await tryStartBot();

  const shutdown = async (signal: string) => {
    console.log(`⏹  ${signal} - to'xtatilmoqda...`);
    if (!USE_WEBHOOK) await bot.stop().catch(() => {});
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (err) => {
  console.error("⚠️ Ushlanmagan xato (unhandledRejection):", err);
});

bootstrap();
