import { pool } from "../db/pool";
import { generateInitialPrice } from "./pricingService";

const DEFAULT_CURVE_K = 1.5;
const MAX_SUPPLY_LIMIT = 10000;

export async function createToken(
  ownerId: number,
  name: string,
  symbol: string,
  maxSupply: number
) {
  if (maxSupply <= 0 || maxSupply > MAX_SUPPLY_LIMIT) {
    throw new Error(`max_supply 1 dan ${MAX_SUPPLY_LIMIT} gacha bo'lishi kerak`);
  }

  const basePrice = generateInitialPrice(symbol.toUpperCase());

  const result = await pool.query(
    `INSERT INTO tokens (owner_id, name, symbol, max_supply, circulating_supply, base_price, current_price, curve_k)
     VALUES ($1, $2, $3, $4, 0, $5, $5, $6)
     RETURNING *`,
    [ownerId, name, symbol.toUpperCase(), maxSupply, basePrice, DEFAULT_CURVE_K]
  );

  return result.rows[0];
}

export async function getToken(tokenId: number) {
  const result = await pool.query("SELECT * FROM tokens WHERE id = $1", [tokenId]);
  return result.rows[0] ?? null;
}

export async function listTopTokens(limit = 20) {
  const result = await pool.query(
    `SELECT * FROM tokens ORDER BY current_price DESC, circulating_supply DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}
