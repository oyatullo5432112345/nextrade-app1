import { Pool } from "pg";
import { pool } from "./pool";

/**
 * BAZANI BOSHQA SERVERGA KO'CHIRISH (masalan Render → Neon)
 *
 * Qanday ishlatiladi:
 *   1. Render'da DATABASE_URL = YANGI baza (Neon) manzili
 *   2. MIGRATE_FROM_URL = ESKI baza (Render Internal) manzili
 *   3. Deploy. Server ishga tushganda, yangi baza BO'SH bo'lsa (hali
 *      haqiqiy foydalanuvchi yo'q), eski bazadagi hamma ma'lumot ko'chiriladi.
 *   4. Logda "✅ Ko'chirish tugadi" chiqqach, MIGRATE_FROM_URL ni o'chiring.
 *
 * Xavfsizlik: yangi bazada allaqachon haqiqiy foydalanuvchilar bo'lsa,
 * hech narsa qilinmaydi (ma'lumotlar ustidan yozib yuborilmaydi).
 */

// Tartib muhim: avval boshqalar bog'liq bo'lgan jadvallar
export const TABLES = [
  "users",
  "tokens",
  "holdings",
  "transactions",
  "price_ticks",
  "favorites",
  "token_alerts",
  "frozen_balances",
  "frozen_withdrawals",
  "nex_trade_price",
  "nex_trade_price_ticks",
  "balance_history",
  "token_boosts",
  "wallet_transfers",
  "nex_topups",
  "nex_withdrawals",
  "creator_bonus_balance",
  "creator_bonus_claims",
  "mission_claims",
  "league_payouts",
  "stars_payments",
  "wheel_spins",
  "token_comments",
  "limit_orders",
  "promo_chats",
  "bot_settings",
  "season_results",
  "giveaways",
  "giveaway_claims",
  "clans",
  "orders",
  "token_images",
  "predictions",
  "tournament_entries",
  "tournament_payouts",
  "real_signal_state",
  "ai_picks",
  "group_members",
];

const BATCH = 500;

function sslFor(url: string) {
  try {
    const host = new URL(url).hostname;
    if (!host || host === "localhost" || host === "127.0.0.1") return undefined;
    return host.includes(".") ? { rejectUnauthorized: false } : undefined;
  } catch {
    return undefined;
  }
}

async function tableExists(p: Pool, table: string) {
  const { rows } = await p.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${table}`]);
  return rows[0].ok as boolean;
}

export async function migrateFromOldDatabase(fromUrl = process.env.MIGRATE_FROM_URL ?? ""): Promise<boolean> {
  fromUrl = fromUrl.trim();
  if (!fromUrl) return false;
  if (fromUrl === (process.env.DATABASE_URL ?? "").trim()) {
    console.warn("⚠️ MIGRATE_FROM_URL va DATABASE_URL bir xil - ko'chirish o'tkazib yuborildi");
    return false;
  }

  const real = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE telegram_id > 0");
  if (real.rows[0].n > 0) {
    console.log("ℹ️ Yangi bazada foydalanuvchilar bor - ko'chirish kerak emas. MIGRATE_FROM_URL ni o'chirib qo'ying.");
    return false;
  }

  const old = new Pool({ connectionString: fromUrl, ssl: sslFor(fromUrl), connectionTimeoutMillis: 15_000, max: 2 });
  console.log("🚚 Eski bazadan ko'chirish boshlandi...");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Seed qatorlarni (platforma foydalanuvchisi, gigant tokenlar) tozalaymiz -
    // ular eski bazadan asl ID'lari bilan keladi
    const existing = [];
    for (const t of TABLES) if (await tableExists(pool, t)) existing.push(t);
    await client.query(`TRUNCATE ${existing.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);

    for (const table of existing) {
      if (!(await tableExists(old, table))) continue;
      const idCol = await old.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'",
        [table]
      );
      const orderCol = idCol.rows.length ? "id" : "1";
      let offset = 0;
      let total = 0;
      for (;;) {
        // JSON'ni PostgreSQL'ning o'zi yasaydi - vaqt, raqam aniqligi Node orqali
        // o'tmagani uchun o'zgarmaydi (vaqt zonasi siljishi bo'lmaydi)
        const { rows } = await old.query(
          `SELECT COALESCE(json_agg(t), '[]'::json)::text AS j, COUNT(*)::int AS n
           FROM (SELECT * FROM "${table}" ORDER BY ${orderCol} LIMIT ${BATCH} OFFSET ${offset}) t`
        );
        const n = rows[0].n as number;
        if (n === 0) break;
        await client.query(
          `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(NULL::"${table}", $1::json)`,
          [rows[0].j]
        );
        total += n;
        offset += n;
        if (n < BATCH) break;
      }
      // SERIAL hisoblagichini oxirgi ID ga to'g'rilaymiz (faqat "id" ustuni bor jadvallarda)
      const hasId = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'",
        [table]
      );
      if (hasId.rows.length) {
        await client.query(
          `SELECT setval(seq, COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)
           FROM (SELECT pg_get_serial_sequence('"${table}"', 'id') AS seq) s WHERE seq IS NOT NULL`
        );
      }
      console.log(`   • ${table}: ${total} qator`);
    }
    await client.query("COMMIT");
    console.log("✅ Ko'chirish tugadi! Endi Render'da MIGRATE_FROM_URL ni o'chirib qo'ying.");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Ko'chirishda xato (yangi baza o'zgarmadi):", err);
    return false;
  } finally {
    client.release();
    await old.end().catch(() => {});
  }
}
