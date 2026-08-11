import { PoolClient } from "pg";
import { pool } from "../db/pool";

// bot.ts dagi bilan bir xil manba - faqat shu Telegram ID admin sifatida tanilgan
const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? "0");

/**
 * Har bir savdodan olingan komissiyaning 0.15% qismini tegishli tokenning
 * "muzlatilgan" balansiga qo'shadi.
 *
 * MUHIM: bu funksiya faqat tradeService ichidagi OCHIQ tranzaksiya (client)
 * orqali chaqiriladi - shu bilan qo'shish savdoning o'zi bilan bitta
 * COMMIT/ROLLBACK doirasida bo'ladi (agar savdo bekor qilinsa, komissiya ham
 * qo'shilmaydi).
 */
export async function addFrozenAmount(
  client: PoolClient,
  tokenId: number,
  amount: number
): Promise<void> {
  if (amount <= 0) return;
  await client.query(
    `INSERT INTO frozen_balances (token_id, amount, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (token_id) DO UPDATE
       SET amount = frozen_balances.amount + $2, updated_at = NOW()`,
    [tokenId, amount]
  );
}

/**
 * Har bir token bo'yicha muzlatilgan mablag' ro'yxati (admin uchun).
 */
export async function listFrozenBalances() {
  const result = await pool.query(
    `SELECT fb.token_id, t.name, t.symbol, fb.amount, fb.updated_at
     FROM frozen_balances fb
     JOIN tokens t ON t.id = fb.token_id
     WHERE fb.amount > 0
     ORDER BY fb.amount DESC`
  );
  return result.rows;
}

/**
 * Bitta tokenning muzlatilgan balansi.
 */
export async function getFrozenBalance(tokenId: number): Promise<number> {
  const result = await pool.query(
    "SELECT amount FROM frozen_balances WHERE token_id = $1",
    [tokenId]
  );
  return result.rows.length > 0 ? Number(result.rows[0].amount) : 0;
}

/**
 * Platformadagi barcha tokenlar bo'yicha jami muzlatilgan mablag'.
 */
export async function getTotalFrozen(): Promise<number> {
  const result = await pool.query(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM frozen_balances"
  );
  return Number(result.rows[0].total);
}

function assertAdmin(adminTelegramId: number) {
  if (!ADMIN_TELEGRAM_ID || adminTelegramId !== ADMIN_TELEGRAM_ID) {
    throw new Error("Bu amal faqat admin uchun ruxsat etilgan");
  }
}

// Admin butun muzlatilgan fondni faqat haftada 1 marta (kamida 7 kunda bir)
// yechib olishi mumkin - alohida token-token emas, bir tugma bilan hammasi.
const ADMIN_WITHDRAW_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Adminning oxirgi marta muzlatilgan fonddan yechib olgan vaqtini va
 * keyingi safar qachon yechib olishi mumkinligini qaytaradi.
 */
export async function getAdminWithdrawStatus(adminTelegramId: number) {
  assertAdmin(adminTelegramId);

  const adminRes = await pool.query("SELECT id FROM users WHERE telegram_id = $1", [adminTelegramId]);
  if (adminRes.rows.length === 0) {
    return { lastWithdrawnAt: null, nextWithdrawAt: null, canWithdraw: true };
  }
  const adminId = adminRes.rows[0].id;

  const lastRes = await pool.query(
    "SELECT created_at FROM frozen_withdrawals WHERE admin_user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [adminId]
  );

  if (lastRes.rows.length === 0) {
    return { lastWithdrawnAt: null, nextWithdrawAt: null, canWithdraw: true };
  }

  const lastWithdrawnAt = lastRes.rows[0].created_at;
  const nextWithdrawAt = new Date(new Date(lastWithdrawnAt).getTime() + ADMIN_WITHDRAW_COOLDOWN_MS);
  return {
    lastWithdrawnAt,
    nextWithdrawAt,
    canWithdraw: nextWithdrawAt.getTime() <= Date.now(),
  };
}

/**
 * Barcha tokenlar bo'yicha muzlatilgan mablag'ni BIR TUGMA bilan, hech narsa
 * kiritmasdan (token ID/miqdorni qo'lda tanlamasdan) to'liq yechib oladi -
 * hammasi Nex Trade'ga almashtirilib adminning balansiga tushadi.
 * Faqat haftada 1 marta (oxirgi yechib olishdan kamida 7 kun o'tgan bo'lsa)
 * ishlaydi.
 */
export async function withdrawAllFrozen(
  adminTelegramId: number
): Promise<{ withdrawnTotal: number; adminNewBalance: string }> {
  assertAdmin(adminTelegramId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const adminRes = await client.query(
      "SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE",
      [adminTelegramId]
    );
    if (adminRes.rows.length === 0) {
      throw new Error("Admin foydalanuvchi topilmadi (avval botda /start bosing)");
    }
    const admin = adminRes.rows[0];

    const lastRes = await client.query(
      "SELECT created_at FROM frozen_withdrawals WHERE admin_user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [admin.id]
    );
    if (lastRes.rows.length > 0) {
      const sinceMs = Date.now() - new Date(lastRes.rows[0].created_at).getTime();
      if (sinceMs < ADMIN_WITHDRAW_COOLDOWN_MS) {
        const daysLeft = Math.ceil((ADMIN_WITHDRAW_COOLDOWN_MS - sinceMs) / (24 * 60 * 60 * 1000));
        throw new Error(`Muzlatilgan fondni haftada faqat 1 marta yechib olish mumkin. Yana ${daysLeft} kundan keyin urinib ko'ring`);
      }
    }

    const balancesRes = await client.query(
      "SELECT token_id, amount FROM frozen_balances WHERE amount > 0 FOR UPDATE"
    );
    if (balancesRes.rows.length === 0) {
      throw new Error("Hozircha yechib olinadigan muzlatilgan mablag' yo'q");
    }

    let withdrawnTotal = 0;
    for (const row of balancesRes.rows) {
      const amount = Number(row.amount);
      if (amount <= 0) continue;
      withdrawnTotal += amount;

      await client.query(
        "UPDATE frozen_balances SET amount = 0, updated_at = NOW() WHERE token_id = $1",
        [row.token_id]
      );
      await client.query(
        `INSERT INTO frozen_withdrawals (token_id, amount, admin_user_id) VALUES ($1, $2, $3)`,
        [row.token_id, amount, admin.id]
      );
    }

    const updatedAdmin = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
      [withdrawnTotal, admin.id]
    );

    await client.query("COMMIT");
    return {
      withdrawnTotal,
      adminNewBalance: updatedAdmin.rows[0].nex_trade_balance,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Muzlatilgan fonddan mablag' yechib olish. Faqat ADMIN_TELEGRAM_ID ga mos
 * keluvchi foydalanuvchi bajara oladi (botdagi /stats komandasi bilan bir xil
 * tekshiruv). Yechilgan miqdor adminning o'z Nex Trade balansiga o'tkaziladi
 * (bot/mini-appni rivojlantirish xarajatlarini qoplash uchun) va tarixga
 * yoziladi.
 *
 * ESKI USUL (qo'lda, token-token) - endi frontendda ishlatilmaydi, o'rniga
 * withdrawAllFrozen (bir tugma bilan, haftalik) ishlatiladi. Funksiya
 * moslik/backward-compatibility uchun saqlab qolindi.
 */
export async function withdrawFrozen(
  adminTelegramId: number,
  tokenId: number,
  amount: number
): Promise<{ newFrozenBalance: number; adminNewBalance: string }> {
  assertAdmin(adminTelegramId);
  if (!amount || amount <= 0) throw new Error("Miqdor musbat bo'lishi kerak");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const adminRes = await client.query(
      "SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE",
      [adminTelegramId]
    );
    if (adminRes.rows.length === 0) {
      throw new Error("Admin foydalanuvchi topilmadi (avval botda /start bosing)");
    }
    const admin = adminRes.rows[0];

    const frozenRes = await client.query(
      "SELECT * FROM frozen_balances WHERE token_id = $1 FOR UPDATE",
      [tokenId]
    );
    const frozenAmount = frozenRes.rows.length > 0 ? Number(frozenRes.rows[0].amount) : 0;
    if (frozenAmount < amount) {
      throw new Error("Muzlatilgan mablag' yetarli emas");
    }

    const updatedFrozen = await client.query(
      "UPDATE frozen_balances SET amount = amount - $1, updated_at = NOW() WHERE token_id = $2 RETURNING amount",
      [amount, tokenId]
    );

    const updatedAdmin = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
      [amount, admin.id]
    );

    await client.query(
      `INSERT INTO frozen_withdrawals (token_id, amount, admin_user_id) VALUES ($1, $2, $3)`,
      [tokenId, amount, admin.id]
    );

    await client.query("COMMIT");
    return {
      newFrozenBalance: Number(updatedFrozen.rows[0].amount),
      adminNewBalance: updatedAdmin.rows[0].nex_trade_balance,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
