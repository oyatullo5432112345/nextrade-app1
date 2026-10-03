import { pool } from "../db/pool";
import { floor4, MIN_TRADE_AMOUNT } from "./pricingService";
import { placeOrderCore, inTransaction, walkBook, holdRoom, getLockedSummary, pctLabel, CREATOR_MAX_HOLDING_PCT, USER_MAX_HOLDING_PCT } from "./orderBookService";

/**
 * SAVDO OYNASI HISOB-KITOBI VA ALMASHTIRISH (v8 - order book)
 *
 * 1) Savdo oynasi uchun: balansga va kitobdagi buyurtmalarga qarab eng ko'p
 *    qancha olish/sotish mumkin, miqdorni token yoki Nex'da kiritish.
 * 2) To'lov valyutasi: standart - Nex Trade. Qo'shimcha ravishda TOP (bozor
 *    qiymati bo'yicha top-5) va PRO tokenlar bilan to'lash yoki sotganda ularni
 *    olish mumkin. Almashtirish bitta tranzaksiyada: to'lov tokeni bozor
 *    narxida sotiladi -> tushgan Nex bilan kerakli token olinadi.
 */

const TOP_N = Number(process.env.SWAP_TOP_N ?? 5);

async function getTokenRow(id: number) {
  const { rows } = await pool.query("SELECT * FROM tokens WHERE id = $1", [id]);
  if (!rows[0] || rows[0].is_hidden) throw new Error("Token topilmadi");
  return rows[0];
}

/** To'lov valyutasi sifatida ishlatish mumkin bo'lgan tokenlar: PRO + top-N (bozor qiymati bo'yicha). */
export async function getSwapEligibleIds(): Promise<Set<number>> {
  const { rows } = await pool.query(
    `SELECT id FROM tokens
     WHERE is_hidden = false AND (listed_at IS NULL OR listed_at <= NOW())
       AND (is_pro = true OR id IN (
         SELECT id FROM tokens WHERE is_hidden = false AND (listed_at IS NULL OR listed_at <= NOW())
         ORDER BY current_price * circulating_supply DESC LIMIT $1
       ))`,
    [TOP_N]
  );
  return new Set(rows.map((r) => Number(r.id)));
}

async function assertEligible(viaId: number, targetId: number) {
  if (viaId === targetId) throw new Error("To'lov va xarid tokeni bir xil bo'lmasin");
  const ok = await getSwapEligibleIds();
  if (!ok.has(viaId)) throw new Error("Bu token bilan to'lab bo'lmaydi - faqat TOP va PRO tokenlar");
}

/**
 * Savdo oynasi ochilganda: balans, egalik, eng ko'p olish/sotish, kitobdagi
 * eng yaxshi narxlar va to'lov variantlari (foydalanuvchida bor TOP/PRO tokenlar).
 */
export async function getTradeInfo(userId: number, tokenId: number) {
  const t = await getTokenRow(tokenId);
  const u = await pool.query("SELECT nex_trade_balance FROM users WHERE id = $1", [userId]);
  const balance = Number(u.rows[0]?.nex_trade_balance ?? 0);
  const r = await holdRoom(pool, userId, t);
  const [buyW, sellW, locked] = await Promise.all([
    walkBook(tokenId, "buy", { budget: balance, maxQty: r.room }, userId),
    walkBook(tokenId, "sell", { amount: Math.max(r.held, MIN_TRADE_AMOUNT) }, userId),
    getLockedSummary(userId),
  ]);

  const eligible = await getSwapEligibleIds();
  eligible.delete(tokenId);
  const payOptions = [];
  if (eligible.size) {
    const { rows } = await pool.query(
      `SELECT t.id, t.symbol, t.name, t.is_pro, h.amount AS holding FROM holdings h JOIN tokens t ON t.id = h.token_id
       WHERE h.user_id = $1 AND h.amount > 0 AND t.id = ANY($2::int[])
       ORDER BY h.amount * t.current_price DESC`,
      [userId, [...eligible]]
    );
    for (const row of rows) {
      const holding = Number(row.holding);
      const v = await walkBook(Number(row.id), "sell", { amount: holding }, userId);
      const w = await walkBook(tokenId, "buy", { budget: v.net, maxQty: r.room }, userId);
      payOptions.push({
        id: Number(row.id), symbol: row.symbol, name: row.name, isPro: row.is_pro,
        holding,
        valueNex: v.net,              // hozir hammasini sotsa qo'lga tegadigan Nex
        maxBuyWith: w.qty,            // shu token evaziga eng ko'p olinadigan miqdor
      });
    }
  }

  const recv = eligible.size
    ? (await pool.query(
        `SELECT id, symbol, name, is_pro, current_price FROM tokens WHERE id = ANY($1::int[])
         ORDER BY is_pro DESC, current_price * circulating_supply DESC`,
        [[...eligible]]
      )).rows.map((x) => ({ id: Number(x.id), symbol: x.symbol, name: x.name, isPro: x.is_pro, price: Number(x.current_price) }))
    : [];

  return {
    token: { id: Number(t.id), symbol: t.symbol, price: Number(t.current_price) },
    receiveOptions: recv,
    balance,
    holding: r.held,
    inOrders: r.inSell,
    lockedNex: locked.lockedNex,
    maxBuy: buyW.qty,
    maxSell: r.held,
    holdRoom: r.room,
    bestAsk: buyW.bestPrice,
    bestBid: sellW.bestPrice,
    askLiquidity: buyW.liquidity,
    bidLiquidity: sellW.liquidity,
    payOptions,
  };
}

/**
 * Bozor narxidagi savdoning oldindan hisobi. side: buy/sell, unit: "token"
 * (miqdor tokenda) yoki "nex" (miqdor Nex'da), via: to'lov/qabul qilish tokeni (0 - Nex).
 */
export async function quoteTrade(tokenId: number, side: "buy" | "sell", rawAmount: number, unit: "token" | "nex", viaId = 0, userId?: number) {
  const tokenRow = await getTokenRow(tokenId);
  const amt = Number(rawAmount);
  if (!(amt > 0)) throw new Error("Miqdorni kiriting");

  // Egalik chegarasi (oddiy egasi 20% / yaratuvchi 30%) - oldindan hisobda ham hisobga olinadi
  let room = Infinity;
  if (side === "buy" && userId) {
    room = (await holdRoom(pool, userId, tokenRow)).room;
    const label = pctLabel(Number(tokenRow.owner_id) === userId ? CREATOR_MAX_HOLDING_PCT : USER_MAX_HOLDING_PCT);
    if (room < MIN_TRADE_AMOUNT) throw new Error(`Egalik chegarasiga (${label}) yetgansiz - bu tokendan boshqa olib bo'lmaydi`);
    if (unit === "token" && amt > room + 1e-9) throw new Error(`Egalik chegarasi (${label}): yana eng ko'pi bilan ${room} ta olishingiz mumkin`);
  }

  const w = side === "buy"
    ? await walkBook(tokenId, "buy", unit === "nex" ? { budget: amt, maxQty: room === Infinity ? undefined : room } : { amount: amt }, userId)
    : await walkBook(tokenId, "sell", unit === "nex" ? { netTarget: amt } : { amount: amt }, userId);
  const capped = side === "buy" && unit === "nex" && room !== Infinity && w.qty >= room - 1e-9;

  if (w.qty < MIN_TRADE_AMOUNT) {
    throw new Error(side === "buy"
      ? (w.liquidity > 0 ? "Bu summaga hatto 0.0001 ta ham kelmaydi" : "Hozir bozorda sotuvchi yo'q - limit buyurtma qo'ying")
      : (w.liquidity > 0 ? "Miqdor juda kichik" : "Hozir bozorda xaridor yo'q - limit buyurtma qo'ying"));
  }

  const nexAmount = side === "buy" ? w.pay : w.net;
  const fee = side === "buy" ? Math.max(0, w.pay - w.value) : Math.max(0, w.value - w.net);

  let via: null | { id: number; symbol: string; amount: number; enough: boolean } = null;
  if (viaId) {
    await assertEligible(viaId, tokenId);
    const v = await getTokenRow(viaId);
    const vw = side === "buy"
      ? await walkBook(viaId, "sell", { netTarget: nexAmount }, userId)   // kerakli Nex uchun qancha to'lov tokeni sotiladi
      : await walkBook(viaId, "buy", { budget: nexAmount }, userId);      // tushgan Nex'ga qancha to'lov tokeni olinadi
    if (vw.qty < MIN_TRADE_AMOUNT || (side === "buy" && !vw.enough)) {
      throw new Error(`$${v.symbol} bozorida bunga yetarli buyurtma yo'q`);
    }
    via = { id: Number(v.id), symbol: v.symbol, amount: vw.qty, enough: vw.enough };
  }

  return {
    side,
    tokenAmount: w.qty,
    nexAmount,
    fee,
    avgPrice: w.avgPrice,
    bestPrice: w.bestPrice,
    worstPrice: w.worstPrice,
    newPrice: w.worstPrice,
    liquidity: w.liquidity,
    enough: w.enough,
    capped,
    holdRoom: room === Infinity ? null : room,
    via,
  };
}

export interface SwapResult {
  side: "buy" | "sell";
  paid: { symbol: string; amount: number };
  got: { symbol: string; amount: number };
  nexUsed: number;
  nexLeftover: number;
  newBalance: string;
}

/**
 * Almashtirish (bitta tranzaksiyada):
 *  buy  - `viaId` tokenidan yetarlicha sotiladi, tushgan Nex bilan `amount` ta `tokenId` olinadi
 *  sell - `amount` ta `tokenId` sotiladi, tushgan Nex'ga iloji boricha ko'p `viaId` olinadi
 * Kichik qoldiq (yaxlitlash farqi) Nex balansida qoladi.
 */
export async function swapTrade(userId: number, tokenId: number, side: "buy" | "sell", rawAmount: number, viaId: number) {
  await assertEligible(viaId, tokenId);
  const amount = floor4(rawAmount);
  if (amount < MIN_TRADE_AMOUNT) throw new Error("Eng kam savdo miqdori 0.0001");

  return inTransaction<SwapResult>(async (client) => {
    // Ikkala tokenni ID tartibida qulflaymiz - teskari almashtirishlarda deadlock bo'lmasin
    const locked = await client.query("SELECT * FROM tokens WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [[tokenId, viaId]]);
    const target = locked.rows.find((r) => Number(r.id) === tokenId);
    const via = locked.rows.find((r) => Number(r.id) === viaId);
    if (!target || !via) throw new Error("Token topilmadi");

    if (side === "buy") {
      const need = await walkBook(tokenId, "buy", { amount }, userId, client);
      if (!need.enough) throw new Error(`Bozorda $${target.symbol} sotuvchilari yetarli emas (hozir ${need.qty} ta bor)`);
      const sellW = await walkBook(viaId, "sell", { netTarget: need.pay }, userId, client);
      if (!sellW.enough) throw new Error(`$${via.symbol} bozorida xaridorlar yetarli emas`);
      const h = await client.query("SELECT amount FROM holdings WHERE user_id = $1 AND token_id = $2", [userId, viaId]);
      if (Number(h.rows[0]?.amount ?? 0) + 1e-9 < sellW.qty) {
        throw new Error(`Buning uchun ${sellW.qty} ta $${via.symbol} kerak - sizda yetarli emas`);
      }
      const sold = await placeOrderCore(client, { userId, tokenId: viaId, side: "sell", type: "market", amount: sellW.qty });
      // Faqat to'lov tokenidan tushgan Nex sarflanadi (foydalanuvchining boshqa Nex'iga tegilmaydi)
      const bought = await placeOrderCore(client, {
        userId, tokenId, side: "buy", type: "market", amount, budget: sold.result.nexReceived,
      });
      if (bought.result.filled < amount - 1e-9) throw new Error("Narx o'zgardi - qayta urinib ko'ring");
      return {
        result: {
          side,
          paid: { symbol: via.symbol, amount: sold.result.filled },
          got: { symbol: target.symbol, amount: bought.result.filled },
          nexUsed: bought.result.nexSpent,
          nexLeftover: floor4(sold.result.nexReceived - bought.result.nexSpent),
          newBalance: bought.result.newBalance,
        },
        after: () => { sold.after(); bought.after(); },
      };
    } else {
      const sold = await placeOrderCore(client, { userId, tokenId, side: "sell", type: "market", amount });
      if (sold.result.nexReceived < 0.0001) throw new Error("Tushgan summa juda kichik");
      const bought = await placeOrderCore(client, {
        userId, tokenId: viaId, side: "buy", type: "market", budget: sold.result.nexReceived,
      });
      return {
        result: {
          side,
          paid: { symbol: target.symbol, amount: sold.result.filled },
          got: { symbol: via.symbol, amount: bought.result.filled },
          nexUsed: bought.result.nexSpent,
          nexLeftover: floor4(sold.result.nexReceived - bought.result.nexSpent),
          newBalance: bought.result.newBalance,
        },
        after: () => { sold.after(); bought.after(); },
      };
    }
  });
}
