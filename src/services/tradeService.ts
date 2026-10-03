import { PoolClient } from "pg";
import {
  placeOrderCore, inTransaction, CREATOR_MAX_HOLDING_PCT, USER_MAX_HOLDING_PCT, PlaceOrderResult,
} from "./orderBookService";

/**
 * TEZKOR SAVDO (v8): bozor narxida sotib olish / sotish.
 * Endi har bir savdo order book orqali - kitobdagi eng yaxshi narxlardan
 * bajariladi (qarang: orderBookService.ts).
 */

export { CREATOR_MAX_HOLDING_PCT, USER_MAX_HOLDING_PCT, inTransaction };

export interface MarketOpts {
  /** buy: eng ko'pi bilan shuncha Nex sarflash (miqdor o'rniga yoki u bilan birga) */
  budget?: number;
  /** narx himoyasi: buy - eng yuqori, sell - eng past qabul qilinadigan narx */
  protectPrice?: number;
}

function legacy(r: PlaceOrderResult) {
  return {
    ...r,
    amount: r.filled,
    totalCharge: r.nexSpent,
    totalReturn: r.nexReceived,
    commission: r.fee,
    newPrice: r.lastPrice,
  };
}

/** Bozor narxida sotib olish yadrosi (ochiq tranzaksiya ichida). */
export async function buyCore(client: PoolClient, userId: number, tokenId: number, amount: number | undefined, opts: MarketOpts = {}) {
  const { result, after } = await placeOrderCore(client, {
    userId, tokenId, side: "buy", type: "market", amount, budget: opts.budget, protectPrice: opts.protectPrice,
  });
  return { result: legacy(result), after };
}

/** Bozor narxida sotish yadrosi (ochiq tranzaksiya ichida). */
export async function sellCore(client: PoolClient, userId: number, tokenId: number, amount: number, opts: MarketOpts = {}) {
  const { result, after } = await placeOrderCore(client, {
    userId, tokenId, side: "sell", type: "market", amount, protectPrice: opts.protectPrice,
  });
  return { result: legacy(result), after };
}

export async function buyToken(userId: number, tokenId: number, amount: number | undefined, opts: MarketOpts = {}) {
  return inTransaction((client) => buyCore(client, userId, tokenId, amount, opts));
}

export async function sellToken(userId: number, tokenId: number, amount: number, opts: MarketOpts = {}) {
  return inTransaction((client) => sellCore(client, userId, tokenId, amount, opts));
}
