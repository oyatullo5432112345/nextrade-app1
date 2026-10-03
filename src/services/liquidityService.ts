import { pool } from "../db/pool";
import { inTransaction } from "./orderBookService";
import { buyerPays, floor4, round8 } from "./pricingService";

/**
 * LIKVIDLIK MARKET-MEYKERI (v12) - foydalanuvchi tokenlari uchun platforma limit buyurtmalari.
 *
 * Foydalanuvchilar kam bo'lganda kitob bo'sh qoladi: tokenni sotmoqchi bo'lgan odam xaridor topolmaydi.
 * Platforma har daqiqada har bir faol token uchun narx ostida bir nechta XARID buyurtmasi
 * (va o'zi oldin sotib olgan tokenlar bo'lsa - narx ustida SOTUV buyurtmasi) qo'yadi.
 *
 * Halollik qoidalari:
 *  - Faqat buyurtmalar. Soxta savdo, soxta hajm yoki soxta narx harakati YO'Q - kelishuv faqat
 *    haqiqiy foydalanuvchi shu buyurtmaga sotsa/sotib olsa yuz beradi.
 *  - Kitobda "🤖 MM" belgisi bilan ko'rinadi.
 *
 * Suiiste'moldan himoya (yaratuvchi o'z tokenini soxta akkauntlar bilan "sog'ib" olmasin):
 *  - Mos narx = min(joriy narx, 24 soatlik VWAP) - narxni bir zumda ko'tarib, qimmatga sotib bo'lmaydi.
 *  - Har token uchun kunlik limit (MM_DAILY_NEX) va umumiy kunlik limit (MM_GLOBAL_DAILY_NEX).
 *  - Token kamida MM_MIN_AGE_HOURS soatlik va MM_MIN_HOLDERS ta egasi bo'lishi kerak.
 *  - Sotuv buyurtmalari faqat MM o'zi sotib olgan tokenlardan - yaratuvchining IPO'siga xalaqit bermaydi.
 */

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function mmConfig() {
  return {
    enabled: (process.env.MM_ENABLED ?? "true").toLowerCase() !== "false",
    levelNex: num(process.env.MM_LEVEL_NEX, 30),
    dailyNex: num(process.env.MM_DAILY_NEX, 200),
    globalDailyNex: num(process.env.MM_GLOBAL_DAILY_NEX, 3000),
    minHolders: num(process.env.MM_MIN_HOLDERS, 2),
    minAgeHours: num(process.env.MM_MIN_AGE_HOURS, 3),
  };
}

export const MM_BID_LEVELS = [0.03, 0.06, 0.10];
export const MM_ASK_LEVELS = [0.03, 0.06];

/** Platformaning 24 soatda shu token(lar)ga sarflagan Nex'i. */
async function spent24h(client: any, tokenId: number | null) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(o.filled * o.price), 0) AS v FROM orders o JOIN tokens t ON t.id = o.token_id
     WHERE o.kind = 'mm' AND o.side = 'buy' AND t.is_real = false AND o.created_at > NOW() - INTERVAL '24 hours'
       AND ($1::int IS NULL OR o.token_id = $1)`,
    [tokenId]
  );
  return Number(rows[0].v);
}

/** Bitta token uchun MM buyurtmalarini yangilaydi. Qaytaradi: qo'yilgan buyurtmalar soni. */
export async function refreshTokenLiquidity(tokenId: number, globalLeft: number) {
  const cfg = mmConfig();
  return inTransaction(async (client) => {
    const t = (await client.query("SELECT * FROM tokens WHERE id = $1 FOR UPDATE", [tokenId])).rows[0];
    await client.query(
      "UPDATE orders SET status = 'cancelled', locked_nex = 0, updated_at = NOW() WHERE token_id = $1 AND kind = 'mm' AND status = 'open'",
      [tokenId]
    );
    if (!t || t.is_real || t.is_hidden) return { result: 0, after: () => {} };

    const cur = Number(t.current_price);
    const v = (await client.query(
      `SELECT SUM(amount * price) / NULLIF(SUM(amount), 0) AS vwap FROM transactions
       WHERE token_id = $1 AND tape = true AND created_at > NOW() - INTERVAL '24 hours'`,
      [tokenId]
    )).rows[0];
    const vwap = Number(v?.vwap ?? 0);
    const ref = vwap > 0 ? Math.min(cur, vwap) : cur;
    if (!(ref > 0)) return { result: 0, after: () => {} };

    // Mavjud (MM bo'lmagan) eng yaxshi narxlar - kitob kesishmasin
    const bb = (await client.query(
      `SELECT MAX(price) FILTER (WHERE side = 'buy') AS bid, MIN(price) FILTER (WHERE side = 'sell') AS ask
       FROM orders WHERE token_id = $1 AND status = 'open' AND kind <> 'mm'`,
      [tokenId]
    )).rows[0];
    const bestBid = Number(bb?.bid ?? 0), bestAsk = Number(bb?.ask ?? 0);

    let placed = 0;
    // XARID tomoni: kunlik limit doirasida
    let budget = Math.min(cfg.dailyNex - (await spent24h(client, tokenId)), globalLeft);
    for (const lv of MM_BID_LEVELS) {
      let px = round8(ref * (1 - lv));
      if (bestAsk > 0 && px >= bestAsk) px = round8(bestAsk * (1 - lv));
      if (bestBid > 0 && px <= bestBid) continue; // yuqorida allaqachon xaridor bor - MM keraksiz
      if (!(px > 0)) continue;
      const nex = Math.min(cfg.levelNex, budget);
      // Bitta pog'ona muomaladagi tokenlarning 25% idan oshmaydi (ma'nosiz katta buyurtma bo'lmasin)
      const qty = floor4(Math.min(nex / (px * 1.0025), Number(t.circulating_supply) * 0.25));
      if (qty < 0.0001 || qty * px < 0.001) break;
      const lock = buyerPays(qty, px);
      await client.query(
        "INSERT INTO orders (user_id, token_id, side, type, price, amount, locked_nex, kind) VALUES (NULL, $1, 'buy', 'limit', $2, $3, $4, 'mm')",
        [tokenId, px, qty, lock]
      );
      budget -= lock;
      placed++;
    }

    // SOTUV tomoni: faqat MM'ning o'z zaxirasidan (avval sotib olganlari)
    const inv = (await client.query(
      `SELECT COALESCE(SUM(filled) FILTER (WHERE side = 'buy'), 0) - COALESCE(SUM(filled) FILTER (WHERE side = 'sell'), 0) AS inv
       FROM orders WHERE token_id = $1 AND kind = 'mm'`,
      [tokenId]
    )).rows[0];
    const free = floor4(Number(t.max_supply) - Number(t.circulating_supply));
    let inventory = floor4(Math.min(Number(inv.inv), free));
    if (inventory > 0) {
      // Genesis (IPO) sotuvlari ochiq bo'lsa ham - ular uchun joy qoldiramiz
      const gen = (await client.query(
        "SELECT COALESCE(SUM(amount - filled), 0) AS g FROM orders WHERE token_id = $1 AND status = 'open' AND user_id IS NULL AND side = 'sell' AND kind <> 'mm'",
        [tokenId]
      )).rows[0];
      inventory = floor4(Math.min(inventory, free - Number(gen.g)));
    }
    for (const lv of MM_ASK_LEVELS) {
      if (inventory < 0.0001) break;
      let px = round8(Math.max(cur, ref) * (1 + lv));
      if (bestBid > 0 && px <= bestBid) px = round8(bestBid * (1 + lv));
      const qty = Math.min(floor4(cfg.levelNex / px), inventory);
      if (qty < 0.0001 || qty * px < 0.001) break;
      await client.query(
        "INSERT INTO orders (user_id, token_id, side, type, price, amount, kind) VALUES (NULL, $1, 'sell', 'limit', $2, $3, 'mm')",
        [tokenId, px, qty]
      );
      inventory = floor4(inventory - qty);
      placed++;
    }
    return { result: placed, after: () => {} };
  });
}

/** Barcha mos tokenlar uchun likvidlikni yangilaydi. */
export async function refreshLiquidity() {
  const cfg = mmConfig();
  if (!cfg.enabled) {
    await pool.query(
      `UPDATE orders o SET status = 'cancelled', locked_nex = 0, updated_at = NOW() FROM tokens t
       WHERE t.id = o.token_id AND t.is_real = false AND o.kind = 'mm' AND o.status = 'open'`
    );
    return { tokens: 0, orders: 0 };
  }
  const { rows } = await pool.query(
    `SELECT t.id FROM tokens t
     WHERE t.is_real = false AND t.is_hidden = false
       AND (t.listed_at IS NULL OR t.listed_at <= NOW())
       AND t.created_at <= NOW() - make_interval(secs => $1::float8 * 3600)
       AND (SELECT COUNT(*) FROM holdings h JOIN users hu ON hu.id = h.user_id
            WHERE h.token_id = t.id AND h.amount > 0 AND hu.is_bot = false) >= $2
     ORDER BY t.id`,
    [cfg.minAgeHours, cfg.minHolders]
  );
  const eligible = new Set(rows.map((r) => Number(r.id)));
  // Endi mos kelmaydigan tokenlardagi eski MM buyurtmalarini yopamiz
  const stale = await pool.query(
    `SELECT DISTINCT o.token_id FROM orders o JOIN tokens t ON t.id = o.token_id
     WHERE o.kind = 'mm' AND o.status = 'open' AND t.is_real = false`
  );
  for (const r of stale.rows) {
    if (!eligible.has(Number(r.token_id))) {
      await pool.query("UPDATE orders SET status = 'cancelled', locked_nex = 0, updated_at = NOW() WHERE token_id = $1 AND kind = 'mm' AND status = 'open'", [r.token_id]);
    }
  }
  let orders = 0;
  for (const id of eligible) {
    const globalLeft = Math.max(0, cfg.globalDailyNex - (await spent24h(pool, null)));
    orders += await refreshTokenLiquidity(id, globalLeft);
  }
  return { tokens: eligible.size, orders };
}
