import { pool } from "../db/pool";

/**
 * BOZOR STATISTIKASI (v3)
 *  - 24 soatlik narx o'zgarishi (%) va savdo hajmi
 *  - Bozorni tartiblash: trend / yangi / hajm / narx
 *  - Token sahifasi statistikasi: egalar soni, top egalar
 *  - Grafik uchun vaqt oraliqlari: 1 soat / 24 soat / 7 kun
 */

export type MarketSort = "trend" | "new" | "volume" | "price";

// Har bir token uchun 24 soat oldingi narx (yo'q bo'lsa - eng birinchi nuqta,
// u ham yo'q bo'lsa - boshlang'ich narx) va 24 soatlik hajm.
const STATS_SELECT = `
  t.*,
  COALESCE(t.promoted_until > NOW(), false) AS is_promoted,
  COALESCE(v.volume_24h, 0) AS volume_24h,
  COALESCE(v.trades_24h, 0) AS trades_24h,
  CASE WHEN COALESCE(p24.price, pf.price, t.base_price) > 0
       THEN (t.current_price - COALESCE(p24.price, pf.price, t.base_price))
            / COALESCE(p24.price, pf.price, t.base_price) * 100
       ELSE 0 END AS change_24h
`;

const STATS_JOINS = `
  LEFT JOIN LATERAL (
    SELECT price FROM price_ticks
    WHERE token_id = t.id AND created_at <= NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC LIMIT 1
  ) p24 ON true
  LEFT JOIN LATERAL (
    SELECT price FROM price_ticks
    WHERE token_id = t.id AND created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at ASC LIMIT 1
  ) pf ON true
  LEFT JOIN LATERAL (
    SELECT SUM(total_cost) AS volume_24h, COUNT(*)::int AS trades_24h
    FROM transactions
    WHERE token_id = t.id AND tape = true AND created_at > NOW() - INTERVAL '24 hours'
  ) v ON true
`;

const ORDER_BY: Record<MarketSort, string> = {
  trend: "(t.backing_nex > 0) DESC, change_24h DESC, volume_24h DESC",
  new: "t.created_at DESC",
  volume: "volume_24h DESC, t.current_price DESC",
  price: "t.current_price DESC, t.circulating_supply DESC",
};

export async function listTokensWithStats(opts: {
  sort?: MarketSort;
  featured?: boolean;
  search?: string;
  limit?: number;
}) {
  const sort: MarketSort = opts.sort && ORDER_BY[opts.sort] ? opts.sort : "trend";
  const params: any[] = [];
  const where: string[] = ["t.is_hidden = false", "(t.listed_at IS NULL OR t.listed_at <= NOW())"];
  // Real tokenlar (TON, NOT) o'z bo'limida ko'rsatiladi
  if (!opts.search) where.push("t.is_real = false");

  if (opts.search) {
    params.push(`%${opts.search}%`);
    where.push(`(t.name ILIKE $${params.length} OR t.symbol ILIKE $${params.length})`);
  } else if (opts.featured !== undefined) {
    params.push(opts.featured);
    where.push(`t.is_featured = $${params.length}`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 30, 1), 100));

  const { rows } = await pool.query(
    `SELECT ${STATS_SELECT}
     FROM tokens t
     ${STATS_JOINS}
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY (COALESCE(t.promoted_until > NOW(), false)) DESC, ${ORDER_BY[sort]}
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** Token sahifasi uchun to'liq statistika. */
export async function getTokenStats(tokenId: number) {
  const tokenRes = await pool.query(
    `SELECT ${STATS_SELECT}, u.username AS creator_username
     FROM tokens t
     JOIN users u ON u.id = t.owner_id
     ${STATS_JOINS}
     WHERE t.id = $1`,
    [tokenId]
  );
  if (tokenRes.rows.length === 0) throw new Error("Token topilmadi");
  const t = tokenRes.rows[0];

  const [holdersRes, topRes] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM holdings WHERE token_id = $1 AND amount > 0", [tokenId]),
    pool.query(
      `SELECT u.username, u.id AS user_id, h.amount
       FROM holdings h JOIN users u ON u.id = h.user_id
       WHERE h.token_id = $1 AND h.amount > 0
       ORDER BY h.amount DESC LIMIT 5`,
      [tokenId]
    ),
  ]);

  const circulating = Number(t.circulating_supply) || 0;
  return {
    change24h: Number(t.change_24h),
    volume24h: Number(t.volume_24h),
    trades24h: Number(t.trades_24h),
    marketCap: Number(t.current_price) * circulating,
    holders: holdersRes.rows[0].n,
    creator: t.is_featured ? "NexTrade" : t.creator_username,
    topHolders: topRes.rows.map((r) => ({
      name: r.username ? "@" + r.username : `Foydalanuvchi #${r.user_id}`,
      amount: Number(r.amount),
      pct: circulating > 0 ? (Number(r.amount) / circulating) * 100 : 0,
    })),
  };
}

// Grafik oraliqlari: [qancha vaqt, bitta nuqta necha soniyani o'z ichiga oladi]
const RANGES: Record<string, { interval: string; bucketSec: number }> = {
  "1h": { interval: "1 hour", bucketSec: 60 },
  "24h": { interval: "24 hours", bucketSec: 15 * 60 },
  "7d": { interval: "7 days", bucketSec: 2 * 60 * 60 },
};

export async function getTokenChartRange(tokenId: number, range: string) {
  const r = RANGES[range] ?? RANGES["1h"];
  const { rows } = await pool.query(
    `SELECT to_timestamp(floor(extract(epoch FROM created_at) / $2) * $2) AS created_at,
            AVG(price) AS price
     FROM (
       SELECT price, created_at FROM transactions WHERE token_id = $1 AND tape = true AND created_at > NOW() - $3::interval
       UNION ALL
       SELECT price, created_at FROM price_ticks WHERE token_id = $1 AND created_at > NOW() - $3::interval
     ) c
     GROUP BY 1
     ORDER BY 1`,
    [tokenId, r.bucketSec, r.interval]
  );
  // Oxirgi nuqta sifatida joriy narxni qo'shamiz - grafik doim "hozir" bilan tugaydi
  const cur = await pool.query("SELECT current_price FROM tokens WHERE id = $1", [tokenId]);
  if (cur.rows[0]) rows.push({ created_at: new Date(), price: cur.rows[0].current_price });
  return rows;
}

export async function getNexTradeChartRange(range: string) {
  const r = RANGES[range] ?? RANGES["1h"];
  const { rows } = await pool.query(
    `SELECT to_timestamp(floor(extract(epoch FROM created_at) / $1) * $1) AS created_at, AVG(price) AS price
     FROM nex_trade_price_ticks WHERE created_at > NOW() - $2::interval
     GROUP BY 1 ORDER BY 1`,
    [r.bucketSec, r.interval]
  );
  return rows;
}
