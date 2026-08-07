import { pool } from "../db/pool";
import { calculateBuyCost, calculateSellReturn } from "./pricingService";

/**
 * Token sotib olish. Butun operatsiya bitta SQL tranzaksiyada bajariladi
 * va qatorlar FOR UPDATE bilan qulflanadi - shu bilan bir vaqtda kelgan
 * ikkita so'rov bir-birining ustidan yozib yubormaydi (race condition oldini olish).
 */
export async function buyToken(userId: number, tokenId: number, amount: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tokenRes = await client.query(
      "SELECT * FROM tokens WHERE id = $1 FOR UPDATE",
      [tokenId]
    );
    if (tokenRes.rows.length === 0) throw new Error("Token topilmadi");
    const token = tokenRes.rows[0];

    const newSupplyCheck = Number(token.circulating_supply) + amount;
    if (newSupplyCheck > Number(token.max_supply)) {
      throw new Error("So'ralgan miqdor tokenning maksimal ta'minotidan oshib ketadi");
    }

    const { totalCost, newSupply, newPrice } = calculateBuyCost(
      Number(token.base_price),
      Number(token.circulating_supply),
      Number(token.max_supply),
      Number(token.curve_k),
      amount
    );

    const userRes = await client.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (userRes.rows.length === 0) throw new Error("Foydalanuvchi topilmadi");
    const user = userRes.rows[0];

    if (Number(user.nex_trade_balance) < totalCost) {
      throw new Error("Balansda yetarli Nex Trade yo'q");
    }

    await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance - $1 WHERE id = $2",
      [totalCost, userId]
    );

    await client.query(
      "UPDATE tokens SET circulating_supply = $1, current_price = $2 WHERE id = $3",
      [newSupply, newPrice, tokenId]
    );

    await client.query(
      `INSERT INTO holdings (user_id, token_id, amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, token_id) DO UPDATE SET amount = holdings.amount + $3`,
      [userId, tokenId, amount]
    );

    await client.query(
      `INSERT INTO transactions (user_id, token_id, type, amount, price, total_cost)
       VALUES ($1, $2, 'buy', $3, $4, $5)`,
      [userId, tokenId, amount, newPrice, totalCost]
    );

    await client.query("COMMIT");
    return { totalCost, newPrice, newSupply };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function sellToken(userId: number, tokenId: number, amount: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tokenRes = await client.query(
      "SELECT * FROM tokens WHERE id = $1 FOR UPDATE",
      [tokenId]
    );
    if (tokenRes.rows.length === 0) throw new Error("Token topilmadi");
    const token = tokenRes.rows[0];

    const holdingRes = await client.query(
      "SELECT * FROM holdings WHERE user_id = $1 AND token_id = $2 FOR UPDATE",
      [userId, tokenId]
    );
    const holding = holdingRes.rows[0];
    if (!holding || Number(holding.amount) < amount) {
      throw new Error("Sotish uchun yetarli token yo'q");
    }

    const { totalReturn, newSupply, newPrice } = calculateSellReturn(
      Number(token.base_price),
      Number(token.circulating_supply),
      Number(token.max_supply),
      Number(token.curve_k),
      amount
    );

    await client.query(
      "UPDATE holdings SET amount = amount - $1 WHERE user_id = $2 AND token_id = $3",
      [amount, userId, tokenId]
    );

    await client.query(
      "UPDATE tokens SET circulating_supply = $1, current_price = $2 WHERE id = $3",
      [newSupply, newPrice, tokenId]
    );

    await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2",
      [totalReturn, userId]
    );

    await client.query(
      `INSERT INTO transactions (user_id, token_id, type, amount, price, total_cost)
       VALUES ($1, $2, 'sell', $3, $4, $5)`,
      [userId, tokenId, amount, newPrice, totalReturn]
    );

    await client.query("COMMIT");
    return { totalReturn, newPrice, newSupply };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
