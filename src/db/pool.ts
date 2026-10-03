import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const DATABASE_URL = (process.env.DATABASE_URL ?? "").trim();

function getHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^.*@/, "").replace(/[:/?].*$/, "");
  }
}

const host = getHost(DATABASE_URL);

// SSL qachon kerak:
//  - Render ICHKI manzili (dpg-xxxx-a, nuqtasiz) va localhost -> SSL'siz
//  - Qolgan HAMMA manzillar (Render External ...render.com, Neon, Supabase va h.k.) -> SSL bilan
// Majburan boshqarish uchun: DB_SSL=true yoki DB_SSL=false
function decideSsl(): boolean {
  if (process.env.DB_SSL === "true") return true;
  if (process.env.DB_SSL === "false") return false;
  if (/sslmode=disable/i.test(DATABASE_URL)) return false;
  if (!host || host === "localhost" || host === "127.0.0.1" || host.startsWith("/")) return false;
  return host.includes(".");
}

const useSsl = decideSsl();

// sslmode=... parametri pg kutubxonasida ssl sozlamasini buzib yuborishi mumkin -
// shuning uchun uni URL'dan olib tashlab, SSL'ni o'zimiz boshqaramiz.
const connectionString = DATABASE_URL.replace(/([?&])sslmode=[^&]*(&|$)/i, "$1").replace(/[?&]$/, "");

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL o'rnatilmagan! Render → Environment bo'limida qo'shing");
} else {
  console.log(`🗄  Baza: ${host} (SSL: ${useSsl ? "ha" : "yo'q"})`);
}

export const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
  // Baza manzili noto'g'ri bo'lsa so'rov cheksiz kutib qolmasligi uchun
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
});

pool.on("error", (err) => {
  console.error("Kutilmagan baza xatosi:", err);
});
