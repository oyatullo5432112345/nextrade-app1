import { PoolClient } from "pg";
import { pool } from "../db/pool";
import {
  floor4, ceil4, round4, round8, buyerPays, sellerGets, genesisLadder,
  TOTAL_FEE, CREATOR_FEE_SHARE, MIN_TRADE_AMOUNT,
} from "./pricingService";
import { recordBalanceSnapshot } from "./balanceHistoryService";
import { addFrozenAmount } from "./frozenService";
import { addCreatorBonus } from "./bonusService";
import { rewardReferralOnFirstTrade } from "./engagementService";
import { sendTelegramMessage, notifyCreatorCommission } from "../bot/bot";

/**
 * ORDER BOOK - HAQIQIY BIRJA MEXANIZMI (v8)
 *
 * Narxni endi formula emas, foydalanuvchilarning o'zlari belgilaydi:
 *  - LIMIT buyurtma: "X ta tokenni Y narxda olaman/sotaman". Darhol mos
 *    keladigan qarama-qarshi buyurtmalar bilan kelishadi, qolgani kitobda
 *    (order book) navbatda turadi.
 *  - MARKET buyurtma: kitobdagi eng yaxshi narxlardan darhol bajariladi,
 *    bajarilmagan qismi bekor bo'ladi.
 *  - Navbat: avval eng yaxshi narx, narx teng bo'lsa - kim oldin qo'ygan (price-time).
 *  - Kelishuv narxi = kitobda oldindan turgan (maker) buyurtma narxi.
 *  - Joriy narx = oxirgi kelishuv narxi.
 *
 * Mablag' xavfsizligi (escrow):
 *  - buy buyurtma qo'yilganda kerakli Nex (komissiya bilan) balansdan yechilib,
 *    buyurtmaga "muzlatiladi" (locked_nex). Bekor qilinsa - qaytadi.
 *  - sell buyurtma qo'yilganda tokenlar portfeldan yechilib, buyurtmada turadi.
 *  Shu sabab bitta pulni ikki marta ishlatib bo'lmaydi.
 *
 * Token chiqarilishi (genesis): token yaratilganda butun ta'minot platformaning
 * (user_id = NULL) sotuv buyurtmalari sifatida, asta qimmatlashib boruvchi 20
 * pog'onada kitobga qo'yiladi. Ulardan tushgan pul token yaratuvchisining
 * bonus hisobiga tushadi (yaratuvchining o'zi sotib olsa - muzlatilgan fondga).
 *
 * Komissiya: har bir tomondan 0.25% (0.1% yaratuvchiga, 0.15% muzlatilgan fondga).
 * Platforma buyurtmalaridan komissiya olinmaydi.
 */

export const CREATOR_MAX_HOLDING_PCT = Number(process.env.CREATOR_MAX_HOLDING_PCT ?? 0.30);
export const USER_MAX_HOLDING_PCT = Number(process.env.USER_MAX_HOLDING_PCT ?? 0.20);
export const pctLabel = (p: number) => `${Math.round(p * 100)}%`;
export const MAX_OPEN_ORDERS = Number(process.env.ORDER_MAX_OPEN ?? 30);
/** Limit buyurtmaning eng kam qiymati (Nex) - "chang" buyurtmalar bilan kitobni to'ldirib bo'lmasin */
export const MIN_ORDER_VALUE = 0.001;
const BATCH = 100;

export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";

export interface PlaceOrderInput {
  userId: number;
  tokenId: number;
  side: Side;
  type: OrderType;
  /** Token miqdori (limit va market sell uchun majburiy; market buy uchun yoki shu, yoki budget) */
  amount?: number;
  /** Limit narx */
  price?: number;
  /** Market buy: eng ko'pi bilan shuncha Nex sarflash (komissiya bilan) */
  budget?: number;
  /** Market: narx himoyasi - buy uchun eng yuqori, sell uchun eng past qabul qilinadigan narx */
  protectPrice?: number;
  /** Ichki: sotib olingan tokenlar yoqib yuboriladi (buyback & burn) */
  burn?: boolean;
}

export interface PlaceOrderResult {
  orderId: number;
  side: Side;
  type: OrderType;
  status: "open" | "filled" | "cancelled";
  symbol: string;
  filled: number;
  remaining: number;
  avgPrice: number;
  lastPrice: number | null;
  /** buy: kelishuvlar uchun to'langan jami Nex (komissiya bilan) */
  nexSpent: number;
  /** sell: qo'lga tushgan sof Nex */
  nexReceived: number;
  fee: number;
  /** kitobda qolgan qism uchun muzlatilgan Nex (limit buy) */
  lockedNex: number;
  realizedPnl: number;
  newBalance: string;
  referralBonus: number;
}

interface Tx<R> { result: R; after: () => void }

/** Pool yoki PoolClient - ikkalasida ham query bor (pg turlarida overload birlashmasi xato bermasin) */
export type Queryable = { query: (text: string, values?: any[]) => Promise<{ rows: any[] }> };

// ------------------------------------------------------------------
// Tranzaksiya yordamchisi: deadlock/serialization xatosida qayta urinadi
// ------------------------------------------------------------------
export async function inTransaction<R>(fn: (client: PoolClient) => Promise<Tx<R>>): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { result, after } = await fn(client);
      await client.query("COMMIT");
      try { after(); } catch (e) { console.error("after() xatosi:", e); }
      return result;
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      if ((err?.code === "40P01" || err?.code === "40001") && attempt < 6) {
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * attempt));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

function assertListed(token: any) {
  if (token.listed_at && new Date(token.listed_at).getTime() > Date.now()) {
    const min = Math.ceil((new Date(token.listed_at).getTime() - Date.now()) / 60000);
    throw new Error(`🚀 Bu token IPO'da - savdo ${min} daqiqadan keyin ochiladi`);
  }
}

const fmtN = (n: number) => String(Number(n.toFixed(4)));

/** Foydalanuvchi shu tokendan qancha ega (portfel + sotuv buyurtmalari + ochiq xarid buyurtmalari). */
async function exposure(client: Queryable, userId: number, tokenId: number) {
  const { rows } = await client.query(
    `SELECT
       COALESCE((SELECT amount FROM holdings WHERE user_id = $1 AND token_id = $2), 0) AS held,
       COALESCE((SELECT SUM(amount - filled) FROM orders WHERE user_id = $1 AND token_id = $2 AND status = 'open' AND side = 'sell'), 0) AS in_sell,
       COALESCE((SELECT SUM(amount - filled) FROM orders WHERE user_id = $1 AND token_id = $2 AND status = 'open' AND side = 'buy'), 0) AS in_buy`,
    [userId, tokenId]
  );
  const r = rows[0];
  return { held: Number(r.held), inSell: Number(r.in_sell), inBuy: Number(r.in_buy) };
}

/** Egalik chegarasi bo'yicha yana qancha token olish mumkin. */
export async function holdRoom(client: Queryable, userId: number, token: any) {
  const e = await exposure(client, userId, Number(token.id));
  const pct = Number(token.owner_id) === userId ? CREATOR_MAX_HOLDING_PCT : USER_MAX_HOLDING_PCT;
  const cap = Number(token.max_supply) * pct;
  return { ...e, cap, room: Math.max(0, floor4(cap - e.held - e.inSell - e.inBuy)) };
}

async function addHolding(client: PoolClient, userId: number, tokenId: number, qty: number, unitCost: number) {
  if (qty <= 0) return;
  await client.query(
    `INSERT INTO holdings (user_id, token_id, amount, avg_cost) VALUES ($1, $2, $3::numeric, $4::numeric)
     ON CONFLICT (user_id, token_id) DO UPDATE SET
       avg_cost = CASE WHEN holdings.amount + $3::numeric > 0
                       THEN (holdings.amount * holdings.avg_cost + $3::numeric * $4::numeric) / (holdings.amount + $3::numeric)
                       ELSE $4::numeric END,
       amount = holdings.amount + $3::numeric`,
    [userId, tokenId, qty, unitCost]
  );
}

// ------------------------------------------------------------------
// BUYURTMA QO'YISH VA MOSLASHTIRISH (matching engine)
// ------------------------------------------------------------------
export async function placeOrderCore(client: PoolClient, input: PlaceOrderInput): Promise<Tx<PlaceOrderResult>> {
  const { userId, tokenId, side, type } = input;
  const burn = Boolean(input.burn);
  const opp: Side = side === "buy" ? "sell" : "buy";

  // --- Kiritilgan qiymatlarni tekshirish ---
  let amount = input.amount !== undefined && input.amount !== null ? floor4(Number(input.amount)) : Infinity;
  if (amount !== Infinity && !(amount >= MIN_TRADE_AMOUNT)) throw new Error("Eng kam miqdor 0.0001 ta");
  let price = 0;
  if (type === "limit") {
    if (amount === Infinity) throw new Error("Miqdorni kiriting");
    price = round8(Number(input.price));
    if (!(Number(input.price) > 0) || !Number.isFinite(price)) throw new Error("Narxni to'g'ri kiriting");
    if (amount * price < MIN_ORDER_VALUE - 1e-12) throw new Error(`Buyurtma qiymati juda kichik (kamida ${MIN_ORDER_VALUE} Nex)`);
  } else if (side === "sell" && amount === Infinity) {
    throw new Error("Miqdorni kiriting");
  }
  let budget = Infinity;
  if (input.budget !== undefined && input.budget !== null) {
    if (side !== "buy" || type !== "market") throw new Error("Byudjet faqat bozor narxida sotib olishda ishlatiladi");
    budget = floor4(Number(input.budget));
    if (!(budget > 0)) throw new Error("Summani kiriting");
  }
  if (side === "buy" && type === "market" && amount === Infinity && budget === Infinity) throw new Error("Miqdorni kiriting");
  const protect = input.protectPrice && Number(input.protectPrice) > 0 ? Number(input.protectPrice) : null;
  const limitPx: number | null = type === "limit" ? price : protect;

  // --- Qulflar: avval token (shu token bo'yicha barcha savdolar navbatga turadi), keyin foydalanuvchi ---
  const tok = (await client.query("SELECT * FROM tokens WHERE id = $1 FOR UPDATE", [tokenId])).rows[0];
  if (!tok) throw new Error("Token topilmadi");
  if (tok.is_hidden) throw new Error("Bu token admin tomonidan bloklangan");
  assertListed(tok);
  const usr = (await client.query("SELECT id, nex_trade_balance, is_banned FROM users WHERE id = $1 FOR UPDATE", [userId])).rows[0];
  if (!usr) throw new Error("Foydalanuvchi topilmadi");
  if (usr.is_banned) throw new Error("Hisobingiz bloklangan");
  const ownerId = Number(tok.owner_id);

  if (type === "limit") {
    const open = await client.query("SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1 AND status = 'open'", [userId]);
    if (open.rows[0].n >= MAX_OPEN_ORDERS) throw new Error(`Bir vaqtda eng ko'pi bilan ${MAX_OPEN_ORDERS} ta ochiq buyurtma bo'lishi mumkin`);
    // O'z-o'zi bilan savdo qilishning oldini olish
    const cross = await client.query(
      `SELECT 1 FROM orders WHERE token_id = $1 AND user_id = $2 AND status = 'open' AND side = $3
         AND ${side === "buy" ? "price <= $4" : "price >= $4"} LIMIT 1`,
      [tokenId, userId, opp, price]
    );
    if (cross.rows.length) {
      throw new Error("Bu narxda o'zingizning qarama-qarshi buyurtmangiz turibdi - avval uni bekor qiling");
    }
  }

  // --- Egalik chegarasi (oddiy egasi 20% / yaratuvchi 30%) ---
  let room = Infinity;
  if (side === "buy" && !burn) {
    const r = await holdRoom(client, userId, tok);
    room = r.room;
    const label = pctLabel(ownerId === userId ? CREATOR_MAX_HOLDING_PCT : USER_MAX_HOLDING_PCT);
    if (room < MIN_TRADE_AMOUNT) {
      throw new Error(`Bu tokendan ${label} dan ortiq (maks. ${fmtN(r.cap)} ta) egalik qilib bo'lmaydi - ochiq buyurtmalar ham hisobga olinadi`);
    }
    if (amount !== Infinity && amount > room + 1e-9) {
      throw new Error(`Egalik chegarasi (${label}): yana eng ko'pi bilan ${fmtN(room)} ta olishingiz mumkin`);
    }
  }

  // --- Escrow ---
  let balance = Number(usr.nex_trade_balance);
  let lockLeft = 0;
  let costBasis = 0;
  if (side === "sell") {
    const h = (await client.query(
      "SELECT amount, avg_cost FROM holdings WHERE user_id = $1 AND token_id = $2 FOR UPDATE",
      [userId, tokenId]
    )).rows[0];
    const have = Number(h?.amount ?? 0);
    if (have + 1e-9 < amount) throw new Error(`Sotish uchun yetarli token yo'q (sizda ${fmtN(have)} ta)`);
    costBasis = Number(h.avg_cost);
    await client.query("UPDATE holdings SET amount = amount - $1::numeric WHERE user_id = $2 AND token_id = $3", [amount, userId, tokenId]);
  } else if (type === "limit") {
    lockLeft = buyerPays(amount, price);
    if (balance + 1e-9 < lockLeft) {
      throw new Error(`Balansda yetarli Nex yo'q: kerak ${fmtN(lockLeft)}, sizda ${fmtN(balance)}`);
    }
    balance = round4(balance - lockLeft);
  }

  const ins = await client.query(
    `INSERT INTO orders (user_id, token_id, side, type, price, amount, locked_nex, cost_basis)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [userId, tokenId, side, type, type === "limit" ? price : round8(protect ?? Number(tok.current_price)),
     amount === Infinity ? 1e12 : amount, lockLeft, costBasis]
  );
  const orderId = Number(ins.rows[0].id);

  // --- Moslashtirish ---
  let remaining = amount;
  let budgetLeft = budget;
  let filled = 0, value = 0, spent = 0, received = 0, pnl = 0;
  let lastPrice: number | null = null;
  let creatorTotal = 0, frozenTotal = 0, circDelta = 0, maxDelta = 0;
  let takerTokens = 0, takerTokenCost = 0;
  const makerNotes = new Map<number, { userId: number; side: Side; qty: number; value: number; done: boolean }>();
  const makerBuyers = new Set<number>();
  let stop = false;
  let moneyShort = false;
  let dustStop = false;

  while (!stop && remaining >= MIN_TRADE_AMOUNT) {
    const params: any[] = [tokenId, opp, userId];
    let pxCond = "";
    if (limitPx !== null) { params.push(limitPx); pxCond = side === "buy" ? "AND price <= $4" : "AND price >= $4"; }
    const book = await client.query(
      `SELECT * FROM orders
       WHERE token_id = $1 AND side = $2 AND status = 'open' AND (user_id IS NULL OR user_id <> $3) ${pxCond}
       ORDER BY price ${side === "buy" ? "ASC" : "DESC"}, id ASC
       LIMIT ${BATCH} FOR UPDATE`,
      params
    );
    if (!book.rows.length) break;

    for (const m of book.rows) {
      if (remaining < MIN_TRADE_AMOUNT) { stop = true; break; }
      const p = Number(m.price);
      const mRem = round4(Number(m.amount) - Number(m.filled));
      if (mRem < MIN_TRADE_AMOUNT) continue;
      let q = Math.min(remaining, mRem);

      if (side === "buy") {
        q = Math.min(q, room);
        if (type === "market") {
          const money = Math.min(budgetLeft, balance);
          const want = q;
          q = Math.min(q, floor4(money / (p * (1 + TOTAL_FEE))));
          while (q >= MIN_TRADE_AMOUNT && buyerPays(q, p) > money + 1e-9) q = round4(q - 0.0001);
          if (q < want - 1e-9 && balance <= budgetLeft) moneyShort = true;
        }
      }
      q = floor4(q);
      if (q < MIN_TRADE_AMOUNT) { stop = true; break; }

      // "Chang" kelishuv: sotuvchiga 0 Nex tushadigan savdo bo'lmaydi
      const minGets = side === "buy" && m.user_id === null ? floor4(q * p) : sellerGets(q, p);
      if (minGets < 0.0001) {
        if (q >= mRem - 1e-9 && m.user_id !== null) {
          // Maker buyurtmaning qoldig'i juda kichik - yopamiz, qoldiq egasiga qaytadi
          await closeDustOrder(client, m);
          continue;
        }
        dustStop = true; stop = true; break;
      }

      const v = q * p;
      const systemSeller = side === "buy" && m.user_id === null;

      // Xaridor to'laydi
      let pay = buyerPays(q, p);
      let makerLockedAfter = Number(m.locked_nex);
      if (side === "buy") {
        if (type === "limit") { pay = Math.min(pay, lockLeft); lockLeft = round4(lockLeft - pay); }
        else { balance = round4(balance - pay); budgetLeft = round4(budgetLeft - pay); }
        spent = round4(spent + pay);
      } else {
        // Maker xaridor: muzlatmada doim qolgan qism uchun yetarli mablag' qolishi shart
        // (har kelishuvdagi yaxlitlash muzlatmani "yeb" qo'ymasin)
        const remAfter = round4(mRem - q);
        const mustKeep = remAfter >= MIN_TRADE_AMOUNT ? buyerPays(remAfter, p) : 0;
        pay = Math.max(0, Math.min(pay, round4(makerLockedAfter - mustKeep)));
        makerLockedAfter = round4(makerLockedAfter - pay);
      }

      // Sotuvchi oladi
      let gets = systemSeller ? floor4(v) : sellerGets(q, p);
      if (gets > pay) gets = pay; // pul "yo'qdan" paydo bo'lmasin
      const fee = Math.max(0, round4(pay - gets));
      creatorTotal += fee * CREATOR_FEE_SHARE;
      frozenTotal += fee - fee * CREATOR_FEE_SHARE;

      if (systemSeller) {
        // Token chiqarilishidan tushum: yaratuvchiga (o'zi sotib olsa - fondga).
        // Real tokenlarda (mm) platforma "bank" vazifasini bajaradi - tushum hech kimga yozilmaydi.
        if (m.kind !== "mm") {
          if (userId === ownerId) frozenTotal += gets; else creatorTotal += gets;
        }
        if (!burn) circDelta += q;
      }
      if (burn) {
        maxDelta -= q;
        if (!systemSeller) circDelta -= q;
      }

      // Tokenlar va pul harakati
      if (side === "buy") {
        if (!burn) { takerTokens += q; takerTokenCost += v; }
        if (!systemSeller) {
          // Maker sotuvchi
          const mu = Number(m.user_id);
          await client.query("UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2", [gets, mu]);
          const mPnl = gets - Number(m.cost_basis) * q;
          await client.query(
            `INSERT INTO transactions (user_id, token_id, type, amount, price, total_cost, commission, realized_pnl, tape, order_id)
             VALUES ($1, $2, 'sell', $3, $4, $5, $6, $7, false, $8)`,
            [mu, tokenId, q, p, floor4(v), floor4(v - gets), mPnl, m.id]
          );
        }
      } else if (m.user_id === null) {
        // Platforma xaridor: kafolat devori (backing) - tokenlar yoqiladi;
        // real token market-meykeri (mm) - tokenlar platforma zaxirasiga qaytadi
        circDelta -= q;
        if (m.kind === "backing") maxDelta -= q;
        received = round4(received + gets);
        pnl += gets - costBasis * q;
      } else {
        // Maker xaridor
        const mu = Number(m.user_id);
        await addHolding(client, mu, tokenId, q, p);
        makerBuyers.add(mu);
        await client.query(
          `INSERT INTO transactions (user_id, token_id, type, amount, price, total_cost, commission, tape, order_id)
           VALUES ($1, $2, 'buy', $3, $4, $5, $6, false, $7)`,
          [mu, tokenId, q, p, floor4(v), Math.max(0, pay - v), m.id]
        );
        received = round4(received + gets);
        pnl += gets - costBasis * q;
      }

      // Maker buyurtmani yangilash
      const newFilled = round4(Number(m.filled) + q);
      const done = newFilled >= Number(m.amount) - 1e-9;
      if (done && m.side === "buy" && makerLockedAfter > 0) {
        if (m.user_id !== null) {
          await client.query("UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2", [makerLockedAfter, m.user_id]);
        } else if (m.kind === "backing") {
          frozenTotal += makerLockedAfter; // kafolat qoldig'i fondga
        }
        makerLockedAfter = 0;
      }
      await client.query(
        "UPDATE orders SET filled = $1, locked_nex = $2, status = $3, updated_at = NOW() WHERE id = $4",
        [newFilled, makerLockedAfter, done ? "filled" : "open", m.id]
      );
      if (m.user_id !== null) {
        const n = makerNotes.get(Number(m.id)) ?? { userId: Number(m.user_id), side: m.side, qty: 0, value: 0, done: false };
        n.qty += q; n.value += v; n.done = done;
        makerNotes.set(Number(m.id), n);
      }

      filled = round4(filled + q);
      value += v;
      lastPrice = p;
      if (remaining !== Infinity) remaining = round4(remaining - q);
      if (room !== Infinity) room = round4(room - q);
    }
    if (book.rows.length < BATCH) break;
  }

  // --- Yakun ---
  // Aniq miqdor so'ralgan-u, balans yetmay qolgan bo'lsa - qisman emas, umuman bajarmaymiz
  if (moneyShort && budget === Infinity && amount !== Infinity) {
    throw new Error(`Balansda yetarli Nex yo'q (sizda ${fmtN(Number(usr.nex_trade_balance))} Nex)`);
  }
  if (filled < MIN_TRADE_AMOUNT && type === "market" && dustStop) {
    throw new Error("Savdo summasi juda kichik - miqdorni oshiring");
  }
  if (filled < MIN_TRADE_AMOUNT && type === "market") {
    throw new Error(side === "buy"
      ? (limitPx !== null ? "Narx o'zgardi - ko'rsatilgan narxda sotuvchi qolmadi. Qayta urinib ko'ring" : "Hozir bozorda sotuvchi yo'q. Limit buyurtma qo'ying - sotuvchi chiqsa avtomatik bajariladi")
      : (limitPx !== null ? "Narx o'zgardi - ko'rsatilgan narxda xaridor qolmadi. Qayta urinib ko'ring" : "Hozir bozorda xaridor yo'q. Limit buyurtma qo'ying - xaridor chiqsa avtomatik bajariladi"));
  }

  let status: "open" | "filled" | "cancelled";
  let finalAmount = amount === Infinity ? filled : amount;
  let keepLock = 0;
  if (type === "limit") {
    status = remaining < MIN_TRADE_AMOUNT ? "filled" : "open";
    if (side === "buy") {
      const need = status === "open" ? buyerPays(remaining, price) : 0;
      // Yaxlitlash sababli muzlatma 0.0001 kam qolgan bo'lsa - balansdan to'ldiramiz
      if (need > lockLeft && balance + 1e-9 >= round4(need - lockLeft)) {
        balance = round4(balance - round4(need - lockLeft));
        lockLeft = need;
      }
      keepLock = Math.min(need, lockLeft);
      const refund = round4(lockLeft - keepLock);
      balance = round4(balance + refund);
    }
  } else {
    status = remaining === Infinity || remaining < MIN_TRADE_AMOUNT ? "filled" : "cancelled";
    if (side === "sell" && remaining >= MIN_TRADE_AMOUNT) {
      // Bajarilmagan qism portfelga qaytadi
      await addHolding(client, userId, tokenId, remaining, costBasis);
    }
  }
  if (side === "sell") balance = round4(balance + received);

  await client.query(
    "UPDATE orders SET amount = $1, filled = $2, locked_nex = $3, status = $4, updated_at = NOW() WHERE id = $5",
    [finalAmount, filled, keepLock, status, orderId]
  );

  const balRes = await client.query(
    "UPDATE users SET nex_trade_balance = $1 WHERE id = $2 RETURNING nex_trade_balance",
    [balance, userId]
  );
  let newBalance: string = balRes.rows[0].nex_trade_balance;

  let referral: { referrerTelegramId: number; reward: number } | null = null;
  const referralNotes: { referrerTelegramId: number; reward: number }[] = [];
  if (filled >= MIN_TRADE_AMOUNT) {
    if (side === "buy" && takerTokens > 0) await addHolding(client, userId, tokenId, takerTokens, takerTokenCost / takerTokens);
    const takerFee = side === "buy" ? Math.max(0, spent - value) : Math.max(0, value - received);
    await client.query(
      `INSERT INTO transactions (user_id, token_id, type, amount, price, total_cost, commission, realized_pnl, tape, order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
      [userId, tokenId, side, filled, value / filled, floor4(value), takerFee, side === "sell" ? pnl : null, orderId]
    );
    await client.query(
      `UPDATE tokens SET current_price = $1,
              circulating_supply = GREATEST(circulating_supply + $2::numeric, 0),
              max_supply = max_supply + $3::numeric
       WHERE id = $4`,
      [lastPrice, circDelta, maxDelta, tokenId]
    );
    await client.query("INSERT INTO price_ticks (token_id, price) VALUES ($1, $2)", [tokenId, lastPrice]);
    if (creatorTotal > 0) await addCreatorBonus(client, ownerId, creatorTotal);
    if (frozenTotal > 0) await addFrozenAmount(client, tokenId, frozenTotal);

    if (side === "buy") {
      referral = await rewardReferralOnFirstTrade(client, userId);
      if (referral) {
        referralNotes.push(referral);
        newBalance = (await client.query("SELECT nex_trade_balance FROM users WHERE id = $1", [userId])).rows[0].nex_trade_balance;
      }
    }
    for (const mb of makerBuyers) {
      const r = await rewardReferralOnFirstTrade(client, mb);
      if (r) referralNotes.push(r);
    }
  }
  await recordBalanceSnapshot(userId, newBalance, client);

  // COMMIT dan keyin: maker'larga xabar, yaratuvchiga komissiya, referal
  const symbol = String(tok.symbol);
  const tokenName = String(tok.name);
  const creatorFeeOnly = creatorTotal;
  const after = () => {
    for (const r of referralNotes) {
      sendTelegramMessage(r.referrerTelegramId, `🎉 Siz taklif qilgan do'stingiz birinchi savdosini qildi!\n+${r.reward} Nex Trade balansingizga qo'shildi.`);
    }
    if (makerNotes.size) notifyMakers(symbol, makerNotes).catch(() => {});
    if (creatorFeeOnly > 0 && ownerId !== userId) {
      pool.query("SELECT telegram_id FROM users WHERE id = $1", [ownerId])
        .then((r) => {
          const tg = Number(r.rows[0]?.telegram_id ?? 0);
          if (tg > 0) notifyCreatorCommission(tg, tokenName, symbol, creatorFeeOnly, side);
        })
        .catch(() => {});
    }
  };

  return {
    result: {
      orderId, side, type, status, symbol,
      filled,
      remaining: status === "open" ? round4(finalAmount - filled) : 0,
      avgPrice: filled > 0 ? value / filled : 0,
      lastPrice,
      nexSpent: floor4(spent),
      nexReceived: floor4(received),
      fee: floor4(side === "buy" ? Math.max(0, spent - value) : Math.max(0, value - received)),
      lockedNex: keepLock,
      realizedPnl: side === "sell" ? pnl : 0,
      newBalance,
      referralBonus: referral?.reward ?? 0,
    },
    after,
  };
}

/** Juda kichik qoldiqli maker buyurtmani yopadi: muzlatilgan Nex / tokenlar egasiga qaytadi. */
async function closeDustOrder(client: PoolClient, m: any) {
  const rem = round4(Number(m.amount) - Number(m.filled));
  if (m.side === "buy" && Number(m.locked_nex) > 0) {
    await client.query("UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2", [m.locked_nex, m.user_id]);
  } else if (m.side === "sell" && rem > 0) {
    await addHolding(client, Number(m.user_id), Number(m.token_id), rem, Number(m.cost_basis));
  }
  await client.query(
    "UPDATE orders SET status = CASE WHEN filled > 0 THEN 'filled' ELSE 'cancelled' END, locked_nex = 0, updated_at = NOW() WHERE id = $1",
    [m.id]
  );
}

async function notifyMakers(symbol: string, notes: Map<number, { userId: number; side: Side; qty: number; value: number; done: boolean }>) {
  const ids = [...new Set([...notes.values()].map((n) => n.userId))];
  const { rows } = await pool.query("SELECT id, telegram_id FROM users WHERE id = ANY($1::int[])", [ids]);
  const tg = new Map(rows.map((r) => [Number(r.id), Number(r.telegram_id)]));
  for (const n of notes.values()) {
    const t = tg.get(n.userId);
    if (!t || t <= 0) continue;
    const avg = n.qty > 0 ? n.value / n.qty : 0;
    sendTelegramMessage(
      t,
      `${n.side === "buy" ? "🟢" : "🔴"} Buyurtmangiz ${n.done ? "to'liq bajarildi" : "qisman bajarildi"}!\n` +
        `${n.side === "buy" ? "Sotib olindi" : "Sotildi"}: ${fmtN(n.qty)} $${symbol}\n` +
        `Narx: ${avg.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} Nex`
    );
  }
}

export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  return inTransaction((client) => placeOrderCore(client, input));
}

// ------------------------------------------------------------------
// BEKOR QILISH
// ------------------------------------------------------------------
/** Ochiq buyurtmani bekor qiladi va muzlatilgan mablag'ni qaytaradi. userId = null - tizim (admin) tomonidan. */
export async function cancelOrderCore(client: PoolClient, orderId: number, userId: number | null) {
  const pre = (await client.query("SELECT token_id FROM orders WHERE id = $1", [orderId])).rows[0];
  if (!pre) throw new Error("Buyurtma topilmadi");
  await client.query("SELECT id FROM tokens WHERE id = $1 FOR UPDATE", [pre.token_id]);
  const o = (await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId])).rows[0];
  if (!o || (userId !== null && Number(o.user_id) !== userId)) throw new Error("Buyurtma topilmadi");
  if (o.status !== "open") throw new Error("Bu buyurtma allaqachon yopilgan");
  const remaining = round4(Number(o.amount) - Number(o.filled));
  if (o.user_id === null) {
    // Platforma buyurtmasi: kafolat (backing) mablag'i fondga o'tadi, qolganlari shunchaki yopiladi
    if (o.kind === "backing" && Number(o.locked_nex) > 0) await addFrozenAmount(client, Number(o.token_id), Number(o.locked_nex));
  } else {
    if (o.side === "buy" && Number(o.locked_nex) > 0) {
      const r = await client.query(
        "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
        [o.locked_nex, o.user_id]
      );
      await recordBalanceSnapshot(Number(o.user_id), r.rows[0].nex_trade_balance, client);
    } else if (o.side === "sell" && remaining > 0) {
      await addHolding(client, Number(o.user_id), Number(o.token_id), remaining, Number(o.cost_basis));
    }
  }
  await client.query("UPDATE orders SET status = 'cancelled', locked_nex = 0, updated_at = NOW() WHERE id = $1", [orderId]);
  return { id: orderId, refundedNex: o.side === "buy" ? Number(o.locked_nex) : 0, returnedTokens: o.side === "sell" ? remaining : 0 };
}

export async function cancelOrder(userId: number, orderId: number) {
  return inTransaction(async (client) => ({ result: await cancelOrderCore(client, orderId, userId), after: () => {} }));
}

/** Foydalanuvchining (ban) yoki tokenning (yashirish) barcha ochiq buyurtmalarini bekor qiladi. */
export async function cancelAllOrdersCore(client: PoolClient, filter: { userId?: number; tokenId?: number }) {
  const cond = filter.userId !== undefined ? "user_id = $1" : "token_id = $1";
  const { rows } = await client.query(
    `SELECT id FROM orders WHERE ${cond} AND status = 'open' ORDER BY token_id, id`,
    [filter.userId ?? filter.tokenId]
  );
  for (const r of rows) await cancelOrderCore(client, Number(r.id), null);
  return rows.length;
}

// ------------------------------------------------------------------
// TOKEN CHIQARILISHI (genesis) - platforma sotuv zinapoyasi
// ------------------------------------------------------------------
export async function seedGenesisCore(client: PoolClient, tokenId: number) {
  const t = (await client.query("SELECT * FROM tokens WHERE id = $1 FOR UPDATE", [tokenId])).rows[0];
  if (!t || t.genesis_seeded) return 0;
  if (t.is_real) {
    await client.query("UPDATE tokens SET genesis_seeded = true WHERE id = $1", [tokenId]);
    return 0;
  }
  const open = await client.query(
    "SELECT COALESCE(SUM(amount - filled), 0) AS n FROM orders WHERE token_id = $1 AND user_id IS NULL AND status = 'open'",
    [tokenId]
  );
  const circulating = Number(t.circulating_supply);
  const remaining = round4(Number(t.max_supply) - circulating - Number(open.rows[0].n));
  const ladder = t.is_hidden ? [] : genesisLadder(
    Number(t.current_price) || Number(t.base_price), circulating, Number(t.max_supply), remaining, Number(t.curve_k) || 1.5
  );
  for (const l of ladder) {
    await client.query(
      "INSERT INTO orders (user_id, token_id, side, type, price, amount, kind) VALUES (NULL, $1, 'sell', 'limit', $2, $3, 'genesis')",
      [tokenId, l.price, l.amount]
    );
  }
  await client.query("UPDATE tokens SET genesis_seeded = true WHERE id = $1", [tokenId]);
  return ladder.length;
}

/** Ishga tushganda: order book'ga hali o'tkazilmagan eski tokenlar uchun zinapoya yaratadi. */
export async function seedAllGenesis() {
  const { rows } = await pool.query("SELECT id FROM tokens WHERE genesis_seeded = false ORDER BY id");
  let n = 0;
  for (const r of rows) {
    try {
      await inTransaction(async (client) => ({ result: await seedGenesisCore(client, Number(r.id)), after: () => {} }));
      n++;
    } catch (err) {
      console.error(`❌ Token #${r.id} uchun order book yaratishda xato:`, err);
    }
  }
  if (n) console.log(`📗 ${n} ta token order book'ga o'tkazildi`);
  return n;
}

// ------------------------------------------------------------------
// O'QISH: kitob, lenta, buyurtmalar, oldindan hisob
// ------------------------------------------------------------------
export async function getOrderBook(tokenId: number, depth = 12) {
  depth = Math.min(Math.max(depth, 1), 50);
  const q = (side: Side) => pool.query(
    `SELECT price, SUM(amount - filled) AS qty, COUNT(*)::int AS orders,
            BOOL_OR(kind = 'genesis') AS platform, BOOL_OR(kind = 'backing') AS backing,
            BOOL_OR(kind = 'mm') AS mm
     FROM orders WHERE token_id = $1 AND side = $2 AND status = 'open'
     GROUP BY price ORDER BY price ${side === "sell" ? "ASC" : "DESC"} LIMIT $3`,
    [tokenId, side, depth]
  );
  const [asks, bids, tok] = await Promise.all([
    q("sell"), q("buy"),
    pool.query("SELECT current_price, symbol FROM tokens WHERE id = $1", [tokenId]),
  ]);
  if (!tok.rows[0]) throw new Error("Token topilmadi");
  const map = (r: any) => ({ price: Number(r.price), qty: Number(r.qty), orders: r.orders, platform: Boolean(r.platform), backing: Boolean(r.backing), mm: Boolean(r.mm) });
  const a = asks.rows.map(map), b = bids.rows.map(map);
  const bestAsk = a[0]?.price ?? null, bestBid = b[0]?.price ?? null;
  return {
    symbol: tok.rows[0].symbol,
    lastPrice: Number(tok.rows[0].current_price),
    bestAsk, bestBid,
    spread: bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null,
    asks: a, bids: b,
  };
}

/** Savdo lentasi: oxirgi kelishuvlar (har biri bir marta). */
export async function getTradeTape(tokenId: number, limit = 30) {
  const { rows } = await pool.query(
    `SELECT t.type AS side, t.amount, t.price, t.total_cost, t.created_at, COALESCE(u.is_bot, false) AS bot
     FROM transactions t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.token_id = $1 AND t.tape = true ORDER BY t.id DESC LIMIT $2`,
    [tokenId, Math.min(Math.max(limit, 1), 100)]
  );
  return rows;
}

export async function listUserOrders(userId: number, opts: { tokenId?: number; status?: "open" | "all" } = {}) {
  const params: any[] = [userId];
  let where = "o.user_id = $1";
  if (opts.tokenId) { params.push(opts.tokenId); where += ` AND o.token_id = $${params.length}`; }
  if (opts.status !== "all") where += " AND o.status = 'open'";
  const { rows } = await pool.query(
    `SELECT o.id, o.token_id, o.side, o.type, o.price, o.amount, o.filled, o.locked_nex, o.status, o.created_at, o.updated_at,
            t.name, t.symbol, t.current_price,
            (SELECT SUM(x.amount * x.price) / NULLIF(SUM(x.amount), 0) FROM transactions x
              WHERE x.order_id = o.id AND x.user_id = o.user_id) AS avg_price
     FROM orders o JOIN tokens t ON t.id = o.token_id
     WHERE ${where}
     ORDER BY (o.status = 'open') DESC, o.id DESC LIMIT 50`,
    params
  );
  return rows;
}

/** Buyurtmalarda muzlatilgan mablag' (profil/portfel uchun). */
export async function getLockedSummary(userId: number) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(locked_nex) FILTER (WHERE side = 'buy'), 0) AS locked_nex,
            COUNT(*)::int AS open_orders
     FROM orders WHERE user_id = $1 AND status = 'open'`,
    [userId]
  );
  return { lockedNex: Number(rows[0].locked_nex), openOrders: rows[0].open_orders };
}

export interface WalkResult {
  qty: number;        // olinadigan/sotiladigan token
  value: number;      // komissiyasiz qiymat
  pay: number;        // buy: to'lanadigan jami (komissiya bilan)
  net: number;        // sell: qo'lga tegadigan sof summa
  avgPrice: number;
  bestPrice: number | null;
  worstPrice: number | null;
  liquidity: number;  // shu tomonda jami mavjud token
  enough: boolean;    // so'ralgan miqdor/summa to'liq bajariladimi
}

/**
 * Kitob bo'ylab "yurib" market buyurtma natijasini oldindan hisoblaydi.
 * takerSide = "buy" - sotuv buyurtmalari (asks) bo'ylab, "sell" - xarid buyurtmalari (bids) bo'ylab.
 * Cheklovlar: amount (token), budget (buy: sarflanadigan Nex), netTarget (sell: olinishi kerak bo'lgan sof Nex), maxQty.
 */
export async function walkBook(
  tokenId: number,
  takerSide: Side,
  lim: { amount?: number; budget?: number; netTarget?: number; maxQty?: number },
  excludeUserId?: number,
  client: Queryable = pool
): Promise<WalkResult> {
  const opp = takerSide === "buy" ? "sell" : "buy";
  const { rows } = await client.query(
    `SELECT price, (amount - filled) AS rem, user_id FROM orders
     WHERE token_id = $1 AND side = $2 AND status = 'open' AND (user_id IS NULL OR user_id <> $3)
     ORDER BY price ${takerSide === "buy" ? "ASC" : "DESC"}, id ASC LIMIT 1000`,
    [tokenId, opp, excludeUserId ?? 0]
  );
  let remaining = lim.amount !== undefined ? floor4(lim.amount) : Infinity;
  if (lim.maxQty !== undefined) remaining = Math.min(remaining, floor4(lim.maxQty));
  let budgetLeft = lim.budget !== undefined ? floor4(lim.budget) : Infinity;
  const target = lim.netTarget !== undefined ? ceil4(lim.netTarget) : Infinity;
  let qty = 0, value = 0, pay = 0, net = 0, worst: number | null = null;
  let liquidity = 0;
  for (const r of rows) liquidity += Number(r.rem);
  for (const r of rows) {
    if (remaining < MIN_TRADE_AMOUNT || budgetLeft < 0.0001 || net >= target - 1e-9) break;
    const p = Number(r.price);
    const system = r.user_id === null;
    let q = Math.min(remaining, floor4(Number(r.rem)));
    if (takerSide === "buy" && budgetLeft !== Infinity) {
      q = Math.min(q, floor4(budgetLeft / (p * (1 + TOTAL_FEE))));
      while (q >= MIN_TRADE_AMOUNT && buyerPays(q, p) > budgetLeft + 1e-9) q = round4(q - 0.0001);
    }
    if (takerSide === "sell" && target !== Infinity) {
      const need = target - net;
      let qn = ceil4(need / (p * (1 - TOTAL_FEE)));
      while (qn > MIN_TRADE_AMOUNT && sellerGets(round4(qn - 0.0001), p) >= need - 1e-9) qn = round4(qn - 0.0001);
      while (sellerGets(qn, p) < need - 1e-9) qn = round4(qn + 0.0001);
      q = Math.min(q, qn);
    }
    q = floor4(q);
    if (q < MIN_TRADE_AMOUNT) break;
    qty = round4(qty + q);
    value += q * p;
    if (takerSide === "buy") { const c = buyerPays(q, p); pay += c; if (budgetLeft !== Infinity) budgetLeft = round4(budgetLeft - c); }
    else net += system ? floor4(q * p) : sellerGets(q, p);
    worst = p;
    if (remaining !== Infinity) remaining = round4(remaining - q);
  }
  const bestPrice = rows.length ? Number(rows[0].price) : null;
  let enough: boolean;
  if (lim.amount !== undefined) enough = remaining < MIN_TRADE_AMOUNT;
  else if (lim.netTarget !== undefined) enough = net >= target - 1e-9;
  else enough = qty > 0;
  return {
    qty, value, pay: floor4(pay), net: floor4(net),
    avgPrice: qty > 0 ? value / qty : 0,
    bestPrice, worstPrice: worst, liquidity: floor4(liquidity), enough,
  };
}
