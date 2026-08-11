import { PoolClient } from "pg";
import { pool } from "../db/pool";
import { recordBalanceSnapshot } from "./balanceHistoryService";

// Bonusni yechib olish orasidagi eng kam vaqt - 7 kun (1 hafta).
const CLAIM_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Token yaratuvchisiga tegishli komissiya ulushini (savdo bo'lganda)
 * darhol balansga emas, shu "kutilayotgan bonus" jamg'armasiga qo'shadi.
 *
 * MUHIM: tradeService ichidagi OCHIQ tranzaksiya (client) orqali chaqiriladi -
 * shu bilan savdo bilan bitta COMMIT/ROLLBACK doirasida bo'ladi.
 */
export async function addCreatorBonus(
  client: PoolClient,
  userId: number,
  amount: number
): Promise<void> {
  if (amount <= 0) return;
  await client.query(
    `INSERT INTO creator_bonus_balance (user_id, amount, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET amount = creator_bonus_balance.amount + $2, updated_at = NOW()`,
    [userId, amount]
  );
}

/**
 * Foydalanuvchining "Bonuslar" bo'limi uchun holat: qancha kutilayotgan
 * bonus bor, oxirgi marta qachon yechib olgan va keyingi safar qachon
 * yechib olishi mumkin.
 */
export async function getBonusInfo(userId: number) {
  const [balanceRes, lastClaimRes] = await Promise.all([
    pool.query("SELECT amount FROM creator_bonus_balance WHERE user_id = $1", [userId]),
    pool.query(
      "SELECT created_at FROM creator_bonus_claims WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [userId]
    ),
  ]);

  const pending = balanceRes.rows.length > 0 ? Number(balanceRes.rows[0].amount) : 0;
  const lastClaimAt = lastClaimRes.rows.length > 0 ? lastClaimRes.rows[0].created_at : null;

  let nextClaimAt: Date | null = null;
  if (lastClaimAt) {
    nextClaimAt = new Date(new Date(lastClaimAt).getTime() + CLAIM_COOLDOWN_MS);
  }

  const canClaim = pending > 0 && (!nextClaimAt || nextClaimAt.getTime() <= Date.now());

  return { pending, lastClaimAt, nextClaimAt, canClaim };
}

/**
 * Kutilayotgan bonusni asosiy Nex Trade balansiga o'tkazadi. Faqat haftada
 * 1 marta (oxirgi yechib olishdan kamida 7 kun o'tgan bo'lsa) va bonus
 * miqdori 0 dan katta bo'lsagina ishlaydi.
 */
export async function claimBonus(userId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const balanceRes = await client.query(
      "SELECT amount FROM creator_bonus_balance WHERE user_id = $1 FOR UPDATE",
      [userId]
    );
    const pending = balanceRes.rows.length > 0 ? Number(balanceRes.rows[0].amount) : 0;
    if (pending <= 0) {
      throw new Error("Hozircha yechib olinadigan bonus yo'q");
    }

    const lastClaimRes = await client.query(
      "SELECT created_at FROM creator_bonus_claims WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [userId]
    );
    if (lastClaimRes.rows.length > 0) {
      const sinceMs = Date.now() - new Date(lastClaimRes.rows[0].created_at).getTime();
      if (sinceMs < CLAIM_COOLDOWN_MS) {
        const daysLeft = Math.ceil((CLAIM_COOLDOWN_MS - sinceMs) / (24 * 60 * 60 * 1000));
        throw new Error(`Bonusni haftada faqat 1 marta yechib olish mumkin. Yana ${daysLeft} kundan keyin urinib ko'ring`);
      }
    }

    await client.query(
      "UPDATE creator_bonus_balance SET amount = 0, updated_at = NOW() WHERE user_id = $1",
      [userId]
    );

    const updatedUser = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
      [pending, userId]
    );
    await recordBalanceSnapshot(userId, updatedUser.rows[0].nex_trade_balance, client);

    await client.query(
      "INSERT INTO creator_bonus_claims (user_id, amount) VALUES ($1, $2)",
      [userId, pending]
    );

    await client.query("COMMIT");
    return { claimedAmount: pending, newBalance: updatedUser.rows[0].nex_trade_balance };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
