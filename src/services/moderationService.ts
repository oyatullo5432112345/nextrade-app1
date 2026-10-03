import { pool } from "../db/pool";
import { recordBalanceSnapshot } from "./balanceHistoryService";
import { floor4 } from "./pricingService";
import { cancelAllOrdersCore, inTransaction } from "./orderBookService";

/**
 * MODERATSIYA (v4)
 *  - So'kinish/haqorat filtri (token nomi, belgisi, izohlar)
 *  - Foydalanuvchini bloklash / blokdan chiqarish
 *  - Tokenni yashirish: egalariga joriy narxda pul qaytariladi
 *  - Izohni o'chirish
 */

// Asosiy ro'yxat - so'z ILDIZLARI (qo'shimchali shakllarni ham ushlaydi).
// Qo'shimcha so'zlar: .env -> BLOCKED_WORDS=soz1,soz2
const BASE_BAD_ROOTS = [
  // rus
  "хуй", "хуе", "хуё", "пизд", "ебат", "ёбан", "ебан", "ебал", "бляд", "блять", "сука", "мудак", "пидор", "пидар", "гандон", "залуп",
  // rus (lotin)
  "huy", "pizd", "blyat", "blyad", "pidor", "pidar", "mudak", "gandon", "ebat",
  // o'zbek
  "sikay", "sikam", "sikdi", "sikib", "sikish", "qo'taq", "qotaq", "jalab", "dalbayo", "onangni",
  "сикай", "сикам", "қўтоқ", "котак", "жалаб", "далбаёб", "онангни",
  // ingliz
  "fuck", "shit", "bitch", "cunt", "nigger", "nigga", "whore",
];

const EXTRA = (process.env.BLOCKED_WORDS ?? "")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

const BAD_ROOTS = [...BASE_BAD_ROOTS, ...EXTRA];

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[ʻʼ‘’`´]/g, "'")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/@/g, "a")
    .replace(/\$/g, "s")
    .replace(/[\s._\-*]+/g, "");
}

export function containsBadWords(text: string): boolean {
  if (!text) return false;
  const n = normalize(text);
  return BAD_ROOTS.some((w) => n.includes(normalize(w)));
}

// ---------------- Foydalanuvchini bloklash ----------------

async function findUser(identifier: string) {
  const id = identifier.trim().replace(/^@/, "");
  const { rows } = /^-?\d+$/.test(id)
    ? await pool.query("SELECT id, telegram_id, username, is_banned FROM users WHERE telegram_id = $1::bigint LIMIT 1", [id])
    : await pool.query("SELECT id, telegram_id, username, is_banned FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1", [id]);
  return rows[0] ?? null;
}

export async function setBanned(identifier: string, banned: boolean) {
  const u = await findUser(identifier);
  if (!u) throw new Error("Foydalanuvchi topilmadi");
  if (Number(u.telegram_id) === Number(process.env.ADMIN_TELEGRAM_ID ?? 0)) throw new Error("Adminni bloklab bo'lmaydi");
  await pool.query("UPDATE users SET is_banned = $1 WHERE id = $2", [banned, u.id]);
  if (banned) {
    // Bloklangan foydalanuvchining ochiq buyurtmalari bekor qilinadi (mablag' qaytariladi)
    await inTransaction(async (client) => ({ result: await cancelAllOrdersCore(client, { userId: Number(u.id) }), after: () => {} }));
  }
  return { username: u.username, telegramId: Number(u.telegram_id) };
}

export async function isBannedTelegram(telegramId: number): Promise<boolean> {
  const { rows } = await pool.query("SELECT is_banned FROM users WHERE telegram_id = $1", [telegramId]);
  return Boolean(rows[0]?.is_banned);
}

// ---------------- Tokenni yashirish ----------------

/**
 * Tokenni bozordan olib tashlaydi. Egalariga tokenlari JORIY narxda Nex Trade
 * sifatida qaytariladi (adolatli - odamlar pulini yo'qotmaydi), ochiq limit
 * buyurtmalar bekor qilinadi. Qaytaradi: token ma'lumoti va egalar ro'yxati
 * (xabar yuborish uchun).
 */
export async function hideToken(identifier: string) {
  const idf = identifier.trim().replace(/^\$/, "");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tokRes = /^\d+$/.test(idf)
      ? await client.query("SELECT * FROM tokens WHERE id = $1 FOR UPDATE", [Number(idf)])
      : await client.query("SELECT * FROM tokens WHERE UPPER(symbol) = UPPER($1) FOR UPDATE", [idf]);
    const token = tokRes.rows[0];
    if (!token) throw new Error("Token topilmadi");
    if (token.is_hidden) throw new Error("Bu token allaqachon yashirilgan");
    if (token.is_featured) throw new Error("Platforma (gigant) tokenini yashirib bo'lmaydi");

    // Avval barcha buyurtmalar bekor qilinadi: muzlatilgan Nex va tokenlar egalariga qaytadi
    await cancelAllOrdersCore(client, { tokenId: Number(token.id) });

    // Qaytarish narxi: oxirgi narx va 7 kunlik o'rtacha (VWAP) dan KICHIGI - bitta
    // "chang" savdo bilan narxni sun'iy ko'tarib, qaytarishdan foyda ko'rib bo'lmasin
    const vw = await client.query(
      `SELECT SUM(amount * price) / NULLIF(SUM(amount), 0) AS v FROM transactions
       WHERE token_id = $1 AND tape = true AND created_at > NOW() - INTERVAL '7 days'`,
      [token.id]
    );
    const vwap = Number(vw.rows[0]?.v ?? 0);
    const price = vwap > 0 ? Math.min(Number(token.current_price), vwap) : Number(token.current_price);
    const holders = await client.query(
      `SELECT h.user_id, h.amount, u.telegram_id FROM holdings h JOIN users u ON u.id = h.user_id
       WHERE h.token_id = $1 AND h.amount > 0 FOR UPDATE OF h`,
      [token.id]
    );
    const refunds: { telegramId: number; refund: number }[] = [];
    for (const h of holders.rows) {
      const refund = floor4(Number(h.amount) * price);
      if (refund > 0) {
        const upd = await client.query(
          "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
          [refund, h.user_id]
        );
        await recordBalanceSnapshot(h.user_id, upd.rows[0].nex_trade_balance, client);
      }
      refunds.push({ telegramId: Number(h.telegram_id), refund });
    }
    await client.query("UPDATE holdings SET amount = 0 WHERE token_id = $1", [token.id]);
    await client.query("UPDATE limit_orders SET status = 'cancelled', note = 'token yashirildi' WHERE token_id = $1 AND status = 'open'", [token.id]);
    await client.query("DELETE FROM favorites WHERE token_id = $1", [token.id]);
    await client.query("DELETE FROM token_alerts WHERE token_id = $1", [token.id]);
    await client.query("UPDATE tokens SET is_hidden = true, circulating_supply = 0 WHERE id = $1", [token.id]);
    await client.query("COMMIT");
    return { name: token.name as string, symbol: token.symbol as string, refunds };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteComment(commentId: number) {
  const { rowCount } = await pool.query("UPDATE token_comments SET is_deleted = true WHERE id = $1 AND is_deleted = false", [commentId]);
  if (!rowCount) throw new Error("Izoh topilmadi");
}

export async function getBroadcastTargets(): Promise<{ id: number; telegramId: number }[]> {
  const { rows } = await pool.query(
    "SELECT id, telegram_id FROM users WHERE telegram_id > 0 AND bot_blocked = false AND is_banned = false ORDER BY id"
  );
  return rows.map((r) => ({ id: Number(r.id), telegramId: Number(r.telegram_id) }));
}

export async function markBotBlocked(userId: number) {
  await pool.query("UPDATE users SET bot_blocked = true WHERE id = $1", [userId]);
}
