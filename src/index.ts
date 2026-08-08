import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { apiRouter } from "./routes/api";
import { bot } from "./bot/bot";
import { startPriceFluctuations } from "./services/priceFluctuationService";
import { ensureSchema } from "./db/ensureSchema";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", apiRouter);

const PORT = process.env.PORT ?? 3000;

async function bootstrap() {
  await ensureSchema();

  app.listen(PORT, () => {
    console.log(`✅ Server ${PORT}-portda ishga tushdi`);
  });

  bot.start();
  console.log("✅ Telegram bot ishga tushdi");

  startPriceFluctuations();
}

bootstrap();
