import { pool } from "../db/pool";
import { generateInitialPrice } from "./pricingService";
import { seedGenesisCore, placeOrderCore, inTransaction, Queryable } from "./orderBookService";
import { recordBalanceSnapshot } from "./balanceHistoryService";

const DEFAULT_CURVE_K = 1.5;
export const MAX_SUPPLY_LIMIT = 1_000_000;
export const MIN_SUPPLY_LIMIT = 10;
// Kuniga butun platformada nechta yangi token yaratilishi mumkin (0 - cheklovsiz).
// Guruh reklamasidagi "bugungi joylar" shu haqiqiy son bilan ko'rsatiladi.
export const dailySlotsTotal = () => Math.max(0, Math.floor(Number(process.env.TOKEN_DAILY_SLOTS ?? 25) || 0));

// Token yaratish narxi (Nex Trade). Bu pul "muzlatilgan fond"ga tushadi - admin
// uni haftalik yechib oladi. Tekin bo'lsa, bozor keraksiz tokenlarga to'lib ketadi.
export const TOKEN_CREATE_FEE = Number(process.env.TOKEN_CREATE_FEE ?? 50);
// IPO: token savdosi shuncha daqiqadan keyin ochiladi (odamlar oldindan kutib turadi)
export const IPO_DELAY_MINUTES = Number(process.env.IPO_DELAY_MINUTES ?? 60);

// Bir foydalanuvchi eng ko'pi bilan nechta token yarata oladi
export const MAX_TOKENS_PER_USER = Number(process.env.MAX_TOKENS_PER_USER ?? 3);
// Kafolat (boshlang'ich qiymat uchun muzlatiladigan Nex) chegarasi
export const MAX_BACKING_NEX = Number(process.env.MAX_BACKING_NEX ?? 100000);
// Real kriptovalyutalar va platforma tokenlari bilan adashtirmaslik uchun band belgilar
const RESERVED_SYMBOLS = new Set([
  "TON", "NOT", "BTC", "ETH", "USDT", "USDC", "BNB", "SOL", "TRX", "DOGE", "XRP", "NEX", "NEXTRADE",
  "NXG", "NXD", "TITAN", "PLAT", "ROYAL", "TONCOIN", "NOTCOIN",
]);

/**
 * Kafolat (backing) hisobi. Yaratuvchi C Nex muzlatsa:
 *  - pol narx F = C / (ta'minot * 1.0025): butun ta'minot uchun F narxda platforma
 *    xarid devori turadi - istalgan egasi istalgan payt kamida F narxda sota oladi;
 *  - boshlang'ich narx = max(tasodifiy narx, 2F).
 * Nima uchun aldab bo'lmaydi: yaratuvchi (yoki uning boshqa akkaunti) tokenni kamida
 * 2F ga sotib olib, devorga F ga sotsa - doim zarar qiladi; muzlatilgan Nex'ni esa
 * qaytarib olib bo'lmaydi (faqat sotuvchilarga tarqaladi).
 */
export function backingPreview(symbol: string, maxSupply: number, backing: number) {
  const base = generateInitialPrice(String(symbol || "X").toUpperCase());
  const floor = backing > 0 && maxSupply > 0 ? Math.floor((backing / (maxSupply * 1.0025)) * 1e8) / 1e8 : 0;
  const start = Math.max(base, floor * 2);
  return { basePrice: base, floorPrice: floor, startPrice: start, multiplier: start / base };
}

const TODAY_SQL = "created_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Tashkent')) AT TIME ZONE 'Asia/Tashkent')::timestamp";

/** Bugungi (Toshkent vaqti) token yaratish joylari: jami, band, qolgan. total=0 - cheklovsiz. */
export async function getDailySlots(db: Queryable = pool) {
  const total = dailySlotsTotal();
  if (!(total > 0)) return { total: 0, used: 0, left: null as number | null };
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM tokens WHERE is_featured = false AND is_real = false AND ${TODAY_SQL}`
  );
  const used = rows[0].n as number;
  return { total, used, left: Math.max(0, total - used) as number | null };
}

export async function countUserTokens(userId: number): Promise<number> {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM tokens WHERE owner_id = $1 AND is_featured = false AND is_real = false",
    [userId]
  );
  return rows[0].n;
}

const MAX_IMAGE_BYTES = 80 * 1024;
/** "data:image/jpeg;base64,...." -> { mime, buf }. Faqat JPEG/PNG/WebP, 80 KB gacha. */
export function parseImageData(dataUrl: string) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || "").trim());
  if (!m) throw new Error("Rasm formati noto'g'ri (JPEG, PNG yoki WebP bo'lsin)");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("Rasm juda katta (80 KB gacha)");
  // Fayl sarlavhasini tekshiramiz - rasm o'rniga boshqa narsa yuklanmasin
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isWebp = buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
  if (!isJpeg && !isPng && !isWebp) throw new Error("Bu fayl rasm emas");
  return { mime: m[1], buf };
}

async function saveTokenImage(client: Queryable, tokenId: number, img: { mime: string; buf: Buffer }) {
  await client.query(
    `INSERT INTO token_images (token_id, mime, data, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (token_id) DO UPDATE SET mime = $2, data = $3, updated_at = NOW()`,
    [tokenId, img.mime, img.buf]
  );
  await client.query("UPDATE tokens SET image_url = $1 WHERE id = $2", [`/api/tokens/${tokenId}/image?v=${Date.now()}`, tokenId]);
}

export async function getTokenImage(tokenId: number) {
  const { rows } = await pool.query("SELECT mime, data FROM token_images WHERE token_id = $1", [tokenId]);
  return rows[0] ? { mime: rows[0].mime as string, data: rows[0].data as Buffer } : null;
}

/** Egasi tokenining rasmini almashtiradi (telefondan yuklangan). */
export async function setTokenImage(tokenId: number, userId: number, dataUrl: string) {
  const img = parseImageData(dataUrl);
  const t = await getToken(tokenId);
  if (!t || t.is_hidden) throw new Error("Token topilmadi");
  if (Number(t.owner_id) !== userId) throw new Error("Faqat token yaratuvchisi rasmni almashtira oladi");
  await saveTokenImage(pool, tokenId, img);
  return { image_url: (await getToken(tokenId)).image_url };
}

export async function createToken(
  ownerId: number,
  name: string,
  symbol: string,
  maxSupply: number,
  imageUrl?: string | null,
  ipo = false,
  opts: { backing?: number; imageData?: string | null } = {}
) {
  if (maxSupply < MIN_SUPPLY_LIMIT || maxSupply > MAX_SUPPLY_LIMIT) {
    throw new Error(`Miqdor ${MIN_SUPPLY_LIMIT} dan ${MAX_SUPPLY_LIMIT.toLocaleString("en-US").replace(/,/g, " ")} gacha bo'lishi kerak`);
  }
  const sym = symbol.toUpperCase();
  if (RESERVED_SYMBOLS.has(sym)) throw new Error("Bu belgi band (real kriptovalyuta yoki platforma tokeni). Boshqasini tanlang");
  const backing = Math.max(0, Math.floor(Number(opts.backing ?? 0) * 10000) / 10000);
  if (backing > MAX_BACKING_NEX) throw new Error(`Kafolat uchun eng ko'pi bilan ${MAX_BACKING_NEX} Nex muzlatish mumkin`);
  const img = opts.imageData ? parseImageData(opts.imageData) : null;
  const pv = backingPreview(sym, maxSupply, backing);
  if (backing > 0 && pv.floorPrice <= 0) throw new Error("Kafolat summasi juda kichik");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("SELECT nex_trade_balance FROM users WHERE id = $1 FOR UPDATE", [ownerId]);
    if (!u.rows[0]) throw new Error("Foydalanuvchi topilmadi");
    const cnt = await client.query(
      "SELECT COUNT(*)::int AS n FROM tokens WHERE owner_id = $1 AND is_featured = false AND is_real = false",
      [ownerId]
    );
    if (cnt.rows[0].n >= MAX_TOKENS_PER_USER) {
      throw new Error(`Har bir foydalanuvchi ko'pi bilan ${MAX_TOKENS_PER_USER} ta token yarata oladi`);
    }
    if (dailySlotsTotal() > 0) {
      // Bir vaqtda ikki kishi oxirgi joyni olmasin
      await client.query("SELECT pg_advisory_xact_lock(4242001)");
      const slots = await getDailySlots(client);
      if (!slots.left) throw new Error(`Bugungi ${slots.total} ta joy tugadi. Ertaga 00:00 da (Toshkent) yangi joylar ochiladi`);
    }
    const need = TOKEN_CREATE_FEE + backing;
    if (Number(u.rows[0].nex_trade_balance) < need) {
      throw new Error(backing > 0
        ? `Buning uchun ${need} Nex kerak (${TOKEN_CREATE_FEE} yaratish + ${backing} kafolat). Balansingizda yetarli emas`
        : `Token yaratish uchun ${TOKEN_CREATE_FEE} Nex Trade kerak. Balansingizda yetarli emas`);
    }

    const result = await client.query(
      `INSERT INTO tokens (owner_id, name, symbol, max_supply, circulating_supply, base_price, current_price, curve_k, image_url,
                           creation_fee, listed_at, launch_notified, backing_nex, floor_price)
       VALUES ($1, $2, $3, $4, 0, $5, $5, $6, $7, $8,
               CASE WHEN $9::boolean THEN NOW() + ($10::int * INTERVAL '1 minute') ELSE NULL END, NOT $9::boolean, $11, $12)
       RETURNING *`,
      [ownerId, name, sym, maxSupply, pv.startPrice, DEFAULT_CURVE_K, imageUrl ?? null, TOKEN_CREATE_FEE, ipo, IPO_DELAY_MINUTES, backing, pv.floorPrice]
    );
    const token = result.rows[0];
    // Butun ta'minot platformaning sotuv buyurtmalari sifatida kitobga qo'yiladi (genesis)
    await seedGenesisCore(client, Number(token.id));

    // Kafolat devori: muzlatilgan Nex pol narxdagi platforma xarid buyurtmasiga aylanadi
    if (backing > 0) {
      await client.query(
        `INSERT INTO orders (user_id, token_id, side, type, price, amount, locked_nex, kind)
         VALUES (NULL, $1, 'buy', 'limit', $2, $3, $4, 'backing')`,
        [token.id, pv.floorPrice, Math.max(0.0001, maxSupply - 0.0001), backing]
      );
    }

    const upd = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance - $1 WHERE id = $2 RETURNING nex_trade_balance",
      [need, ownerId]
    );
    await recordBalanceSnapshot(ownerId, upd.rows[0].nex_trade_balance, client);
    if (TOKEN_CREATE_FEE > 0) {
      await client.query(
        `INSERT INTO frozen_balances (token_id, amount, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (token_id) DO UPDATE SET amount = frozen_balances.amount + $2, updated_at = NOW()`,
        [token.id, TOKEN_CREATE_FEE]
      );
    }
    if (img) await saveTokenImage(client, Number(token.id), img);
    await client.query("COMMIT");
    return (await getToken(Number(token.id))) ?? token;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** IPO kutilayotgan ("Tez orada") tokenlar. */
export async function listUpcomingTokens() {
  const { rows } = await pool.query(
    `SELECT t.*, u.username AS creator_username,
            (SELECT COUNT(*)::int FROM token_alerts a WHERE a.token_id = t.id) AS waiting
     FROM tokens t JOIN users u ON u.id = t.owner_id
     WHERE t.is_hidden = false AND t.listed_at > NOW()
     ORDER BY t.listed_at ASC LIMIT 20`
  );
  return rows;
}

export async function getToken(tokenId: number) {
  const result = await pool.query("SELECT * FROM tokens WHERE id = $1", [tokenId]);
  return result.rows[0] ?? null;
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
     WHERE is_hidden = false
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
     WHERE token_id = $1 AND tape = true
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
       SELECT price, created_at FROM transactions WHERE token_id = $1 AND tape = true
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
 * KUCHAYTIRISH = "BUYBACK & BURN" (v8).
 * Token egasi o'z Nex'i bilan bozordagi sotuv buyurtmalaridan tokenlarni
 * sotib oladi va ularni YOQIB YUBORADI: ta'minot (max_supply) kamayadi,
 * eng arzon sotuvchilar kitobdan ketadi - narx tabiiy ravishda ko'tariladi.
 * Pul qaytarilmaydi.
 */
export async function boostToken(tokenId: number, userId: number, amount: number) {
  if (!(amount > 0)) throw new Error("Miqdor musbat bo'lishi kerak");
  if (amount > MAX_BOOST_AMOUNT) throw new Error(`Bir martada eng ko'p ${MAX_BOOST_AMOUNT} Nex Trade kiritish mumkin`);
  return inTransaction(async (client) => {
    const t = (await client.query("SELECT * FROM tokens WHERE id = $1 FOR UPDATE", [tokenId])).rows[0];
    if (!t) throw new Error("Token topilmadi");
    if (Number(t.owner_id) !== userId) throw new Error("Faqat token yaratuvchisi o'z tokenini kuchaytira oladi");
    const oldPrice = Number(t.current_price);
    const { result, after } = await placeOrderCore(client, {
      userId, tokenId, side: "buy", type: "market", budget: amount, burn: true,
    });
    const nt = (await client.query("SELECT current_price, max_supply FROM tokens WHERE id = $1", [tokenId])).rows[0];
    const newPrice = Number(nt.current_price);
    await client.query(
      `INSERT INTO token_boosts (token_id, user_id, amount, old_base_price, new_base_price) VALUES ($1, $2, $3, $4, $5)`,
      [tokenId, userId, result.nexSpent, oldPrice, newPrice]
    );
    return {
      result: {
        burned: result.filled,
        spent: result.nexSpent,
        newCurrentPrice: newPrice,
        newMaxSupply: Number(nt.max_supply),
        boostPct: oldPrice > 0 ? ((newPrice - oldPrice) / oldPrice) * 100 : 0,
        newBalance: result.newBalance,
      },
      after,
    };
  });
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

