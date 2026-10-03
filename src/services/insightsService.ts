import { pool } from "../db/pool";
import { TOTAL_FEE, CREATOR_FEE_SHARE } from "./pricingService";

/**
 * v10: TOKEN YARATUVCHISI STATISTIKASI va ADMIN TAHLILI
 */

/** Token egasi uchun: shu hafta qancha komissiya tushdi, egalar, hajm, IPO tushumi. */
export async function getCreatorStats(tokenId: number, userId: number) {
  const t = (await pool.query("SELECT id, owner_id, backing_nex, floor_price FROM tokens WHERE id = $1", [tokenId])).rows[0];
  if (!t) throw new Error("Token topilmadi");
  if (Number(t.owner_id) !== userId) throw new Error("Faqat token yaratuvchisi ko'ra oladi");
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM holdings WHERE token_id = $1 AND amount > 0) AS holders,
       (SELECT COALESCE(SUM(total_cost), 0) FROM transactions WHERE token_id = $1 AND tape = true AND created_at > NOW() - INTERVAL '7 days') AS volume_7d,
       (SELECT COUNT(*)::int FROM transactions WHERE token_id = $1 AND tape = true AND created_at > NOW() - INTERVAL '7 days') AS trades_7d,
       (SELECT COALESCE(SUM(commission), 0) FROM transactions WHERE token_id = $1 AND created_at > NOW() - INTERVAL '7 days') AS fees_7d,
       (SELECT COALESCE(SUM(commission), 0) FROM transactions WHERE token_id = $1) AS fees_all,
       (SELECT COALESCE(SUM(filled * price), 0) FROM orders WHERE token_id = $1 AND kind = 'genesis') AS ipo_revenue,
       (SELECT COALESCE(SUM(amount - filled), 0) FROM orders WHERE token_id = $1 AND kind = 'genesis' AND status = 'open') AS ipo_left`,
    [tokenId]
  );
  const r = rows[0];
  return {
    holders: r.holders,
    volume7d: Number(r.volume_7d),
    trades7d: r.trades_7d,
    // Komissiyaning 0.1/0.25 qismi yaratuvchiniki
    earned7d: Number(r.fees_7d) * CREATOR_FEE_SHARE,
    earnedAll: Number(r.fees_all) * CREATOR_FEE_SHARE,
    ipoRevenue: Number(r.ipo_revenue),
    ipoLeft: Number(r.ipo_left),
    backing: Number(t.backing_nex),
    floorPrice: Number(t.floor_price),
    feePct: TOTAL_FEE * 100,
  };
}

/** Admin: Stars daromadi, o'yinlar, real tokenlar holati, shubhali akkauntlar. */
export async function getAdminInsights() {
  const [stars, starsDaily, games, real, suspTransfers, suspRefs] = await Promise.all([
    pool.query(
      `SELECT kind, COUNT(*)::int AS n, COALESCE(SUM(stars), 0)::int AS stars,
              COALESCE(SUM(stars) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::int AS stars_30d
       FROM stars_payments GROUP BY kind ORDER BY stars DESC`
    ),
    pool.query(
      `SELECT to_char(d::date, 'DD.MM') AS day,
              COALESCE((SELECT SUM(stars) FROM stars_payments s WHERE s.created_at >= d AND s.created_at < d + INTERVAL '1 day'), 0)::int AS stars
       FROM generate_series(date_trunc('day', NOW()) - INTERVAL '13 days', date_trunc('day', NOW()), INTERVAL '1 day') d ORDER BY d`
    ),
    pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM predictions WHERE created_at > NOW() - INTERVAL '7 days') AS predictions_7d,
         (SELECT COALESCE(SUM(stake), 0) FROM predictions WHERE status <> 'open' AND created_at > NOW() - INTERVAL '7 days') AS staked_7d,
         (SELECT COALESCE(SUM(payout), 0) FROM predictions WHERE status <> 'open' AND created_at > NOW() - INTERVAL '7 days') AS paid_7d,
         (SELECT COUNT(*)::int FROM tournament_entries WHERE week_key = (SELECT MAX(week_key) FROM tournament_entries)) AS tournament_players`
    ),
    pool.query(`SELECT symbol, current_price, oracle_usd, oracle_status, oracle_updated_at FROM tokens WHERE is_real = true ORDER BY id`),
    // Ko'p akkauntdan Nex yig'ayotganlar: 7 kunda 3+ turli odamdan o'tkazma olgan
    pool.query(
      `SELECT u.id, u.username, u.telegram_id, COUNT(DISTINCT w.from_user_id)::int AS senders, COALESCE(SUM(w.amount), 0) AS total
       FROM wallet_transfers w JOIN users u ON u.id = w.to_user_id
       WHERE w.created_at > NOW() - INTERVAL '7 days'
       GROUP BY u.id HAVING COUNT(DISTINCT w.from_user_id) >= 3
       ORDER BY senders DESC, total DESC LIMIT 10`
    ),
    // Taklif qilganlari umuman savdo qilmagan (soxta referal shubhasi)
    pool.query(
      `SELECT u.id, u.username, u.telegram_id, COUNT(r.id)::int AS invited,
              COUNT(r.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = r.id))::int AS idle
       FROM users u JOIN users r ON r.referred_by = u.id
       GROUP BY u.id HAVING COUNT(r.id) >= 5
          AND COUNT(r.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = r.id)) >= COUNT(r.id) * 0.8
       ORDER BY invited DESC LIMIT 10`
    ),
  ]);
  const g = games.rows[0];
  return {
    stars: stars.rows,
    starsDaily: starsDaily.rows,
    games: {
      predictions7d: g.predictions_7d,
      staked7d: Number(g.staked_7d),
      paid7d: Number(g.paid_7d),
      houseResult7d: Number(g.staked_7d) - Number(g.paid_7d),
      tournamentPlayers: g.tournament_players,
    },
    real: real.rows,
    suspicious: {
      transfers: suspTransfers.rows.map((r) => ({ ...r, total: Number(r.total) })),
      referrals: suspRefs.rows,
    },
  };
}
