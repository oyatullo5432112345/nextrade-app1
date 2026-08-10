import { pool } from "../db/pool";
import { generateInitialPrice, calculatePrice, calculateBuyCost, calculateSellReturn } from "./pricingService";
import { recordBalanceSnapshot } from "./balanceHistoryService";

const DEFAULT_CURVE_K = 1.5;
const MAX_SUPPLY_LIMIT = 10000;
const MIN_SUPPLY_LIMIT = 10;

export async function createToken(
  ownerId: number,
  name: string,
  symbol: string,
  maxSupply: number,
  imageUrl?: string | null
) {
  if (maxSupply < MIN_SUPPLY_LIMIT || maxSupply > MAX_SUPPLY_LIMIT) {
    throw new Error(`max_supply ${MIN_SUPPLY_LIMIT} dan ${MAX_SUPPLY_LIMIT} gacha bo'lishi kerak`);
  }

  const basePrice = generateInitialPrice(symbol.toUpperCase());

  const result = await pool.query(
    `INSERT INTO tokens (owner_id, name, symbol, max_supply, circulating_supply, base_price, current_price, curve_k, image_url)
     VALUES ($1, $2, $3, $4, 0, $5, $5, $6, $7)
     RETURNING *`,
    [ownerId, name, symbol.toUpperCase(), maxSupply, basePrice, DEFAULT_CURVE_K, imageUrl ?? null]
  );

  return result.rows[0];
}

export async function getToken(tokenId: number) {
  const result = await pool.query("SELECT * FROM tokens WHERE id = $1", [tokenId]);
  return result.rows[0] ?? null;
}

/**
 * Foydalanuvchi savdo miqdorini kiritayotganda, hali tasdiqlamasdan turib
 * "shuncha token = shuncha Nex Trade" narxini oldindan ko'rsatish uchun.
 * Haqiqiy savdo bilan bir xil bonding-curve formulasidan foydalanadi,
 * shuning uchun ko'rsatilgan narx bilan haqiqiy narx deyarli bir xil bo'ladi
 * (faqat shu oraliqda boshqa savdo bo'lib, supply o'zgargan bo'lsa farq qilishi mumkin).
 */
export async function getTradeQuote(tokenId: number, side: "buy" | "sell", amount: number) {
  if (amount <= 0) throw new Error("Miqdor musbat bo'lishi kerak");

  const token = await getToken(tokenId);
  if (!token) throw new Error("Token topilmadi");

  const basePrice = Number(token.base_price);
  const supply = Number(token.circulating_supply);
  const maxSupply = Number(token.max_supply);
  const k = Number(token.curve_k);

  if (side === "buy") {
    if (supply + amount > maxSupply) {
      throw new Error("Bu miqdor maksimal muomaladagi hajmdan oshib ketadi");
    }
    const { totalCost, newPrice } = calculateBuyCost(basePrice, supply, maxSupply, k, amount);
    return { nexAmount: totalCost, newPrice, avgPrice: totalCost / amount };
  } else {
    const { totalReturn, newPrice } = calculateSellReturn(basePrice, supply, maxSupply, k, amount);
    return { nexAmount: totalReturn, newPrice, avgPrice: totalReturn / amount };
  }
}

export async function listTopTokens(limit = 20) {
  const result = await pool.query(
    `SELECT * FROM tokens WHERE is_featured = false ORDER BY current_price DESC, circulating_supply DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Platforma tomonidan yaratilgan "gigant" tokenlar (yuqori boshlang'ich narxli,
 * is_featured=true) - bozorda alohida, maxsus bo'limda ko'rsatiladi.
 */
export async function getFeaturedTokens() {
  const result = await pool.query(
    `SELECT * FROM tokens WHERE is_featured = true ORDER BY current_price DESC`
  );
  return result.rows;
}

/**
 * Bosh sahifadagi reyting uchun - narx * muomaladagi miqdor (bozor qiymati)
 * bo'yicha eng yuqori tokenlar.
 */
export async function listLeaderboard(limit = 5) {
  const result = await pool.query(
    `SELECT *, (current_price * circulating_supply) AS market_value
     FROM tokens
     ORDER BY market_value DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Foydalanuvchi o'zi yaratgan barcha tokenlar (profil sahifasi uchun).
 */
export async function getTokensByOwner(ownerId: number) {
  const result = await pool.query(
    `SELECT * FROM tokens WHERE owner_id = $1 ORDER BY created_at DESC`,
    [ownerId]
  );
  return result.rows;
}

/**
 * Nom yoki belgi bo'yicha token qidirish.
 */
export async function searchTokens(query: string, limit = 20) {
  const result = await pool.query(
    `SELECT * FROM tokens
     WHERE name ILIKE $1 OR symbol ILIKE $1
     ORDER BY current_price DESC LIMIT $2`,
    [`%${query}%`, limit]
  );
  return result.rows;
}

/**
 * Bitta tokenning so'nggi SAVDO tarixi (faqat buy/sell) - "Savdo tarixi"
 * ro'yxati uchun ishlatiladi. Avtomatik narx tebranishlari bu yerga kirmaydi.
 */
export async function getTokenHistory(tokenId: number, limit = 50) {
  const result = await pool.query(
    `SELECT type, amount, price, total_cost, created_at
     FROM transactions
     WHERE token_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [tokenId, limit]
  );
  return result.rows.reverse(); // eskidan yangiga tartib - grafik uchun qulay
}

/**
 * Narx GRAFIGI uchun ma'lumot - savdolar (buy/sell) va avtomatik narx
 * tebranishlari birlashtirilib, vaqt bo'yicha tartiblanadi. Shu tufayli
 * grafik hech kim savdo qilmasa ham har 10 soniyada yangilanib turadi.
 */
export async function getTokenChartData(tokenId: number, limit = 100) {
  const result = await pool.query(
    `SELECT price, created_at FROM (
       SELECT price, created_at FROM transactions WHERE token_id = $1
       UNION ALL
       SELECT price, created_at FROM price_ticks WHERE token_id = $1
     ) combined
     ORDER BY created_at DESC
     LIMIT $2`,
    [tokenId, limit]
  );
  return result.rows.reverse(); // eskidan yangiga tartib - grafik uchun qulay
}

// Bir martalik boost uchun eng ko'p 1 mln Nex Trade kiritish mumkin (himoya chegarasi)
const MAX_BOOST_AMOUNT = 1_000_000;

/**
 * Token EGASI o'z shaxsiy Nex Trade balansidan tokeniga mablag' "kiritadi" -
 * bu summani hech qachon qaytarib ololmaydi (holdings/balansiga qaytmaydi),
 * lekin evaziga tokenning bazaviy narxi (base_price) QAYTARILMAS tarzda
 * ko'tariladi - bu esa navbatdagi barcha savdolarda yuqoriroq narxdan
 * boshlanishini anglatadi.
 *
 * Formula: kiritilgan summa tokenning "to'liq bozor qiymati" (max_supply *
 * joriy narx)ga nisbatan necha foizni tashkil qilsa, base_price ham shuncha
 * foizga oshadi.
 */
export async function boostToken(tokenId: number, userId: number, amount: number) {
  if (amount <= 0) throw new Error("Miqdor musbat bo'lishi kerak");
  if (amount > MAX_BOOST_AMOUNT) throw new Error(`Bir martada eng ko'p ${MAX_BOOST_AMOUNT} Nex Trade kiritish mumkin`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tokenRes = await client.query("SELECT * FROM tokens WHERE id = $1 FOR UPDATE", [tokenId]);
    if (tokenRes.rows.length === 0) throw new Error("Token topilmadi");
    const token = tokenRes.rows[0];

    if (Number(token.owner_id) !== userId) {
      throw new Error("Faqat token yaratuvchisi o'z tokeniga mablag' kirita oladi");
    }

    const userRes = await client.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (userRes.rows.length === 0) throw new Error("Foydalanuvchi topilmadi");
    const user = userRes.rows[0];

    if (Number(user.nex_trade_balance) < amount) {
      throw new Error("Balansda yetarli Nex Trade yo'q");
    }

    const oldBasePrice = Number(token.base_price);
    const currentPrice = Number(token.current_price);
    const maxSupply = Number(token.max_supply);
    // To'liq bozor qiymati (agar max_supply to'liq muomalada bo'lganda) - shu
    // asosda foiz hisoblanadi, shunda kichik tokenlarda boost kattaroq,
    // katta tokenlarda esa nisbatan kichikroq ta'sir qiladi.
    const fullMarketValue = currentPrice * maxSupply;
    const boostPct = fullMarketValue > 0 ? amount / fullMarketValue : 0;
    const newBasePrice = oldBasePrice * (1 + boostPct);

    const newCurrentPrice = calculatePrice(
      newBasePrice,
      Number(token.circulating_supply),
      maxSupply,
      Number(token.curve_k)
    );

    const userUpdate = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance - $1 WHERE id = $2 RETURNING nex_trade_balance",
      [amount, userId]
    );
    await recordBalanceSnapshot(userId, userUpdate.rows[0].nex_trade_balance, client);

    await client.query(
      "UPDATE tokens SET base_price = $1, current_price = $2 WHERE id = $3",
      [newBasePrice, newCurrentPrice, tokenId]
    );

    await client.query(
      "INSERT INTO price_ticks (token_id, price) VALUES ($1, $2)",
      [tokenId, newCurrentPrice]
    );

    await client.query(
      `INSERT INTO token_boosts (token_id, user_id, amount, old_base_price, new_base_price)
       VALUES ($1, $2, $3, $4, $5)`,
      [tokenId, userId, amount, oldBasePrice, newBasePrice]
    );

    await client.query("COMMIT");
    return { newBasePrice, newCurrentPrice, boostPct: boostPct * 100 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// PRO nishoni narxi (Nex Trade da) - bu real pulga aloqasi yo'q, ichki
// valyutadan sarflanadi va faqat token profilida "✅ PRO" belgisi chiqishiga sabab bo'ladi.
const PRO_BADGE_COST = 500;

export async function upgradeTokenToPro(tokenId: number, userId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tokenRes = await client.query("SELECT * FROM tokens WHERE id = $1 FOR UPDATE", [tokenId]);
    if (tokenRes.rows.length === 0) throw new Error("Token topilmadi");
    const token = tokenRes.rows[0];

    if (Number(token.owner_id) !== userId) {
      throw new Error("Faqat token yaratuvchisi PRO holatiga o'tkaza oladi");
    }
    if (token.is_pro) {
      throw new Error("Bu token allaqachon PRO");
    }

    const userRes = await client.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (userRes.rows.length === 0) throw new Error("Foydalanuvchi topilmadi");
    const user = userRes.rows[0];

    if (Number(user.nex_trade_balance) < PRO_BADGE_COST) {
      throw new Error(`PRO nishon uchun ${PRO_BADGE_COST} Nex Trade kerak, balansingizda yetarli mablag' yo'q`);
    }

    const userUpdate = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance - $1 WHERE id = $2 RETURNING nex_trade_balance",
      [PRO_BADGE_COST, userId]
    );
    await recordBalanceSnapshot(userId, userUpdate.rows[0].nex_trade_balance, client);

    const updated = await client.query(
      "UPDATE tokens SET is_pro = true, pro_since = NOW() WHERE id = $1 RETURNING *",
      [tokenId]
    );

    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function getProBadgeCost() {
  return PRO_BADGE_COST;
}

