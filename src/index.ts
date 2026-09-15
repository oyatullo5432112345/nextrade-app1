import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { apiRouter } from "./routes/api";
import { bot } from "./bot/bot";
import { startPriceFluctuations } from "./services/priceFluctuationService";
import { ensureSchema } from "./db/ensureSchema";
import { pool } from "./db/pool";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// UptimeRobot yoki shunga o'xshash xizmat uchun — serverni "uyg'oq" saqlash
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

app.use("/api", apiRouter);

const PORT = process.env.PORT ?? 3000;

async function bootstrap() {
  await ensureSchema();

  const server = app.listen(PORT, () => {
    console.log(`✅ Server ${PORT}-portda ishga tushdi`);
  });

  bot.start();
  console.log("✅ Telegram bot ishga tushdi");

  startPriceFluctuations();

  const shutdown = async (signal: string) => {
    console.log(`⚠️ ${signal} qabul qilindi, server to'xtatilmoqda...`);
    server.close();
    await bot.stop();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap();
