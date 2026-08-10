import { pool } from "../db/pool";
import { recordBalanceSnapshot } from "./balanceHistoryService";

const MIN_TRANSFER = 0.0001;

/**
 * Foydalanuvchining hamyon kodi va joriy balansini qaytaradi.
 */
export async function getWalletInfo(userId: number) {
  const result = await pool.query(
    "SELECT wallet_code, nex_trade_balance FROM users WHERE id = $1",
    [userId]
  );
  if (result.rows.length === 0) throw new Error("Foydalanuvchi topilmadi");
  return result.rows[0];
}

/**
 * Foydalanuvchidan foydalanuvchiga to'g'ridan-to'g'ri Nex Trade jo'natish -
 * hamyon kodi (masalan NX-A1B2C3) orqali. Ikkala tomon balansi bitta
 * tranzaksiyada, qatorlar qulflab (FOR UPDATE) o'zgartiriladi - shu bilan
 * bir vaqtda kelgan bir nechta so'rov bir-birining ustidan yozib yubormaydi.
 */
export async function sendTransfer(
  fromUserId: number,
  toWalletCode: string,
  amount: number,
  note?: string
) {
  if (!amount || amount < MIN_TRANSFER) {
    throw new Error("Miqdor juda kichik");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Ikkala qatorni ham (jo'natuvchi va qabul qiluvchi) ID tartibida
    // qulflaymiz - deadlock bo'lmasligi uchun har doim bir xil tartibda.
    const senderRes = await client.query(
      "SELECT id, wallet_code, nex_trade_balance FROM users WHERE id = $1 FOR UPDATE",
      [fromUserId]
    );
    if (senderRes.rows.length === 0) throw new Error("Foydalanuvchi topilmadi");
    const sender = senderRes.rows[0];

    if (sender.wallet_code === toWalletCode.trim().toUpperCase()) {
      throw new Error("O'zingizga pul jo'nata olmaysiz");
    }

    const receiverRes = await client.query(
      "SELECT id, wallet_code, nex_trade_balance FROM users WHERE wallet_code = $1 FOR UPDATE",
      [toWalletCode.trim().toUpperCase()]
    );
    if (receiverRes.rows.length === 0) throw new Error("Bunday hamyon kodi topilmadi");
    const receiver = receiverRes.rows[0];

    if (Number(sender.nex_trade_balance) < amount) {
      throw new Error("Balansda yetarli Nex Trade yo'q");
    }

    const senderUpdate = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance - $1 WHERE id = $2 RETURNING nex_trade_balance",
      [amount, sender.id]
    );
    await recordBalanceSnapshot(sender.id, senderUpdate.rows[0].nex_trade_balance, client);

    const receiverUpdate = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
      [amount, receiver.id]
    );
    await recordBalanceSnapshot(receiver.id, receiverUpdate.rows[0].nex_trade_balance, client);

    await client.query(
      "INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note) VALUES ($1, $2, $3, $4)",
      [sender.id, receiver.id, amount, note?.slice(0, 140) ?? null]
    );

    await client.query("COMMIT");
    return {
      newBalance: senderUpdate.rows[0].nex_trade_balance,
      receiverWalletCode: receiver.wallet_code,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Foydalanuvchining yuborgan/qabul qilgan o'tkazmalari tarixi.
 */
export async function getTransferHistory(userId: number, limit = 50) {
  const result = await pool.query(
    `SELECT wt.id, wt.amount, wt.note, wt.created_at,
            CASE WHEN wt.from_user_id = $1 THEN 'out' ELSE 'in' END AS direction,
            CASE WHEN wt.from_user_id = $1 THEN ru.wallet_code ELSE su.wallet_code END AS counterparty_wallet
     FROM wallet_transfers wt
     JOIN users su ON su.id = wt.from_user_id
     JOIN users ru ON ru.id = wt.to_user_id
     WHERE wt.from_user_id = $1 OR wt.to_user_id = $1
     ORDER BY wt.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}
