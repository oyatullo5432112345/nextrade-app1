import zlib from "zlib";
import { pool } from "../db/pool";
import { TABLES } from "../db/migrateFrom";
import { getSetting, setSetting } from "./promoService";

/**
 * ZAXIRA NUSXA (v6, v13 da kuchaytirildi)
 * Har 6 soatda (BACKUP_EVERY_HOURS) butun baza siqilgan JSON fayl qilib Telegram
 * orqali adminga (yoki BACKUP_CHAT_ID kanaliga) yuboriladi va xabar QADAB qo'yiladi.
 * Baza o'chib ketsa: yangi bo'sh baza ulanib server ishga tushganda qadalgan oxirgi
 * zaxira AVTOMATIK tiklanadi (AUTO_RESTORE=false - o'chirish). Qo'lda tiklash ham bor:
 * faylga reply qilib /tiklash.
 */

const TZ = "Asia/Tashkent";

async function tableExists(table: string) {
  const { rows } = await pool.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${table}`]);
  return rows[0].ok as boolean;
}

/** Butun bazani JSON (gzip) ko'rinishida qaytaradi. JSON'ni PostgreSQL o'zi yasaydi - vaqtlar aniq saqlanadi. */
export async function createBackup(): Promise<{ buffer: Buffer; filename: string; counts: Record<string, number> }> {
  const parts: string[] = [];
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    if (!(await tableExists(t))) continue;
    // id bo'yicha tartiblaymiz: users.referred_by kabi o'ziga ishora qiluvchi
    // bog'lanishlar tiklashda to'g'ri tartibda yozilsin
    const hasId = (await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'",
      [t]
    )).rows.length > 0;
    const { rows } = await pool.query(
      `SELECT COALESCE(json_agg(x), '[]'::json)::text AS j, COUNT(*)::int AS n
       FROM (SELECT * FROM "${t}" ${hasId ? "ORDER BY id" : ""}) x`
    );
    counts[t] = rows[0].n;
    parts.push(`${JSON.stringify(t)}:${rows[0].j}`);
  }
  const meta = await pool.query(`SELECT to_char(NOW() AT TIME ZONE '${TZ}', 'YYYY-MM-DD_HH24-MI') AS d`);
  const json = `{"format":"nextrade-backup-v1","created_at":${JSON.stringify(new Date().toISOString())},"tables":{${parts.join(",")}}}`;
  return {
    buffer: zlib.gzipSync(Buffer.from(json, "utf-8")),
    filename: `nextrade-backup-${meta.rows[0].d}.json.gz`,
    counts,
  };
}

// v13: zaxira har BACKUP_EVERY_HOURS soatda (standart 6) olinadi - ko'pi bilan 6 soatlik ma'lumot yo'qolishi mumkin
export const BACKUP_EVERY_HOURS = Math.max(1, Number(process.env.BACKUP_EVERY_HOURS ?? 6));

/** Oxirgi zaxiradan beri BACKUP_EVERY_HOURS soat o'tgan bo'lsa - true. */
export async function isBackupDue(now = Date.now()): Promise<boolean> {
  const last = Number(await getSetting("last_backup_at"));
  if (!last) return true;
  return now - last >= BACKUP_EVERY_HOURS * 3600_000 - 60_000;
}

export async function markBackupDone(now = Date.now()) {
  const { rows } = await pool.query(`SELECT to_char(NOW() AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS d`);
  await setSetting("last_backup_date", rows[0].d);
  await setSetting("last_backup_at", String(now));
}

/** Bazada hali haqiqiy foydalanuvchi yo'qmi (yangi/bo'sh baza). */
export async function isDatabaseEmpty() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE telegram_id > 0");
  return rows[0].n === 0;
}

/** Zaxira faylidan tiklash. Faqat bazada hali haqiqiy foydalanuvchi bo'lmasa ishlaydi. */
export async function restoreBackup(gz: Buffer): Promise<Record<string, number>> {
  const real = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE telegram_id > 0");
  if (real.rows[0].n > 0) {
    throw new Error("Bazada allaqachon foydalanuvchilar bor. Tiklash faqat BO'SH bazaga qilinadi (ma'lumotlar ustidan yozilmasligi uchun)");
  }
  let data: any;
  try {
    data = JSON.parse(zlib.gunzipSync(gz).toString("utf-8"));
  } catch {
    throw new Error("Fayl o'qilmadi. Bu NexTrade zaxira fayli (.json.gz) ekaniga ishonch hosil qiling");
  }
  if (data?.format !== "nextrade-backup-v1" || !data.tables) throw new Error("Noto'g'ri zaxira fayli");

  const client = await pool.connect();
  const counts: Record<string, number> = {};
  try {
    await client.query("BEGIN");
    const existing: string[] = [];
    for (const t of TABLES) if (await tableExists(t)) existing.push(t);
    await client.query(`TRUNCATE ${existing.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    for (const t of existing) {
      let rows = data.tables[t];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      // Eski zaxiralar tartiblanmagan bo'lishi mumkin - id bo'yicha saralaymiz
      if (rows[0] && typeof rows[0] === "object" && "id" in rows[0]) {
        rows = [...rows].sort((a: any, b: any) => Number(a.id) - Number(b.id));
      }
      // Faqat zaxirada BOR ustunlarni yozamiz: eski zaxirada yangi ustun bo'lmasa,
      // u bazadagi standart (DEFAULT) qiymatini oladi - NOT NULL xatosi bo'lmaydi
      const tableCols = new Set((await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [t]
      )).rows.map((r: any) => r.column_name as string));
      const keys = new Set<string>();
      for (const r of rows) for (const k of Object.keys(r ?? {})) keys.add(k);
      const cols = [...keys].filter((k) => tableCols.has(k)).map((k) => `"${k.replace(/"/g, "")}"`).join(", ");
      if (!cols) continue;
      for (let i = 0; i < rows.length; i += 500) {
        await client.query(
          `INSERT INTO "${t}" (${cols}) SELECT ${cols} FROM json_populate_recordset(NULL::"${t}", $1::json)`,
          [JSON.stringify(rows.slice(i, i + 500))]
        );
      }
      const hasId = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'",
        [t]
      );
      if (hasId.rows.length) {
        await client.query(
          `SELECT setval(seq, COALESCE((SELECT MAX(id) FROM "${t}"), 0) + 1, false)
           FROM (SELECT pg_get_serial_sequence('"${t}"', 'id') AS seq) s WHERE seq IS NOT NULL`
        );
      }
      counts[t] = rows.length;
    }
    await client.query("COMMIT");
    return counts;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
