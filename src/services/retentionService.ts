import { pool } from "../db/pool";
import { recordBalanceSnapshot } from "./balanceHistoryService";

/**
 * O'YINCHILARNI USHLAB QOLISH VA STATISTIKA (v6)
 *  1) IPO ochilishi haqida xabar
 *  2) 2 kun kirmaganlarga eslatma
 *  3) Oylik mavsum (reyting + mukofot + nishon)
 *  4) Admin statistikasi
 */

const TZ = "Asia/Tashkent";
type Notify = (telegramId: number, text: string) => Promise<void>;

// ---------------- 1) IPO ochilishi ----------------

export async function processLaunches(notify: Notify, announce?: (text: string) => Promise<void>) {
  const { rows } = await pool.query(
    `UPDATE tokens SET launch_notified = true
     WHERE launch_notified = false AND listed_at IS NOT NULL AND listed_at <= NOW() AND is_hidden = false
     RETURNING id, name, symbol, current_price`
  );
  for (const t of rows) {
    const subs = await pool.query(
      `SELECT u.telegram_id FROM token_alerts a JOIN users u ON u.id = a.user_id WHERE a.token_id = $1`,
      [t.id]
    );
    const text =
      `🚀 ${t.name} ($${t.symbol}) savdosi OCHILDI!\n\n` +
      `💵 Boshlang'ich narx: ${Number(t.current_price).toFixed(4)}\n` +
      `Birinchilardan bo'lib sotib oling - narx hali eng past! 👇`;
    for (const s of subs.rows) {
      await notify(Number(s.telegram_id), text);
      await new Promise((r) => setTimeout(r, 50));
    }
    if (announce) await announce(text);
  }
  return rows.length;
}

// ---------------- 2) Eslatmalar ----------------

const REMIND_AFTER_HOURS = Number(process.env.REMIND_AFTER_HOURS ?? 48);
const REMIND_EVERY_HOURS = Number(process.env.REMIND_EVERY_HOURS ?? 72);

/**
 * Kamida REMIND_AFTER_HOURS kirmagan, oxirgi REMIND_EVERY_HOURS ichida
 * eslatma olmagan foydalanuvchilarga shaxsiy eslatma yuboradi. Matn
 * foydalanuvchining holatiga qarab tanlanadi (portfel foydasi / seriya / g'ildirak).
 */
export async function sendReminders(notify: Notify, limit = 150) {
  const { rows } = await pool.query(
    `SELECT u.id, u.telegram_id, u.username, u.daily_streak, u.language,
            (SELECT COALESCE(SUM(h.amount * t.current_price), 0) FROM holdings h JOIN tokens t ON t.id = h.token_id
               WHERE h.user_id = u.id AND h.amount > 0) AS value,
            (SELECT COALESCE(SUM(h.amount * h.avg_cost), 0) FROM holdings h
               WHERE h.user_id = u.id AND h.amount > 0) AS cost
     FROM users u
     WHERE u.telegram_id > 0 AND u.is_banned = false AND u.bot_blocked = false
       AND COALESCE(u.last_seen_at, u.created_at) < NOW() - ($1::int * INTERVAL '1 hour')
       AND (u.last_reminded_at IS NULL OR u.last_reminded_at < NOW() - ($2::int * INTERVAL '1 hour'))
     ORDER BY COALESCE(u.last_seen_at, u.created_at) DESC
     LIMIT $3`,
    [REMIND_AFTER_HOURS, REMIND_EVERY_HOURS, limit]
  );

  let sent = 0;
  for (const u of rows) {
    const value = Number(u.value), cost = Number(u.cost);
    const pnlPct = cost > 0 ? ((value - cost) / cost) * 100 : 0;
    let text: string;
    if (cost > 0 && pnlPct >= 5) {
      text = `💰 Portfelingiz +${pnlPct.toFixed(1)}% foydada! Sotib, foydani qo'lga kiritish vaqti emasmi? 📈`;
    } else if (cost > 0 && pnlPct <= -10) {
      text = `📉 Portfelingiz ${pnlPct.toFixed(1)}% pastda. Narxlar arzon - ko'proq olib, o'rtacha narxni tushirish imkoniyati! 🎯`;
    } else if (Number(u.daily_streak) >= 2) {
      text = `🔥 ${u.daily_streak} kunlik seriyangiz uzildi! Bugun kirib, yangidan boshlang - 7-kunda 100 Nex bonus kutmoqda 🎁`;
    } else {
      text = `🎡 Omad g'ildiragi sizni kutmoqda! Bugun tekin aylantiring - 500 Nex gacha yutuq 🎁`;
    }
    await notify(Number(u.telegram_id), text);
    await pool.query("UPDATE users SET last_reminded_at = NOW() WHERE id = $1", [u.id]);
    sent++;
    await new Promise((r) => setTimeout(r, 60));
  }
  return sent;
}

// ---------------- 3) Oylik mavsum ----------------

export const SEASON_PRIZES = (process.env.SEASON_PRIZES ?? "5000,2500,1000")
  .split(",").map((x) => Number(x.trim())).filter((x) => x >= 0);

function monthStartSql(offset: number) {
  return `((date_trunc('month', NOW() AT TIME ZONE '${TZ}') + INTERVAL '${offset} month') AT TIME ZONE '${TZ}')::timestamp`;
}

async function seasonTop(fromSql: string, toSql: string, limit: number, runner: any = pool) {
  const { rows } = await runner.query(
    `SELECT u.id AS user_id, u.username, SUM(t.realized_pnl) AS pnl
     FROM transactions t JOIN users u ON u.id = t.user_id
     WHERE t.type = 'sell' AND t.realized_pnl IS NOT NULL
       AND t.created_at >= ${fromSql} AND t.created_at < ${toSql} AND u.telegram_id > 0
     GROUP BY u.id, u.username
     HAVING SUM(t.realized_pnl) >= 1 AND COUNT(*) >= 5
     ORDER BY pnl DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r: any, i: number) => ({ rank: i + 1, userId: Number(r.user_id), username: r.username, pnl: Number(r.pnl) }));
}

export async function getSeason() {
  const top = await seasonTop(monthStartSql(0), monthStartSql(1), 10);
  const meta = await pool.query(
    `SELECT (${monthStartSql(1)})::timestamptz AS ends_at, to_char(NOW() AT TIME ZONE '${TZ}', 'YYYY-MM') AS key`
  );
  const last = await pool.query(
    `SELECT s.rank, s.reward, u.username FROM season_results s LEFT JOIN users u ON u.id = s.user_id
     WHERE s.season_key = (SELECT MAX(season_key) FROM season_results) AND s.user_id IS NOT NULL ORDER BY s.rank`
  );
  return {
    key: meta.rows[0].key,
    endsAt: meta.rows[0].ends_at,
    prizes: SEASON_PRIZES,
    top: top.map((t: any) => ({ rank: t.rank, username: t.username, pnl: t.pnl, prize: SEASON_PRIZES[t.rank - 1] ?? 0 })),
    lastChampions: last.rows.map((r) => ({ rank: r.rank, username: r.username, reward: Number(r.reward) })),
  };
}

export async function payoutPreviousSeason(notify?: Notify) {
  const client = await pool.connect();
  const msgs: { tg: number; text: string }[] = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(777002)");
    const k = await client.query(
      `SELECT to_char(date_trunc('month', NOW() AT TIME ZONE '${TZ}') - INTERVAL '1 month', 'YYYY-MM') AS k`
    );
    const key: string = k.rows[0].k;
    const done = await client.query("SELECT 1 FROM season_results WHERE season_key = $1 LIMIT 1", [key]);
    if (done.rows.length) { await client.query("COMMIT"); return 0; }

    const top = await seasonTop(monthStartSql(-1), monthStartSql(0), SEASON_PRIZES.length, client);
    if (!top.length) {
      await client.query("INSERT INTO season_results (season_key, rank, user_id) VALUES ($1, 0, NULL)", [key]);
    }
    for (const w of top) {
      const prize = SEASON_PRIZES[w.rank - 1] ?? 0;
      await client.query(
        "INSERT INTO season_results (season_key, rank, user_id, pnl, reward) VALUES ($1, $2, $3, $4, $5)",
        [key, w.rank, w.userId, w.pnl, prize]
      );
      const upd = await client.query(
        "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance, telegram_id",
        [prize, w.userId]
      );
      await recordBalanceSnapshot(w.userId, upd.rows[0].nex_trade_balance, client);
      msgs.push({
        tg: Number(upd.rows[0].telegram_id),
        text: `👑 ${key} mavsumi yakunlandi!\n\nSiz ${w.rank}-o'rinni egalladingiz (+${w.pnl.toFixed(2)} Nex foyda).\n🎁 Mukofot: +${prize} Nex va "Mavsum chempioni" nishoni! 🏅`,
      });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (notify) for (const m of msgs) await notify(m.tg, m.text);
  return msgs.length;
}

// ---------------- 4) Admin statistikasi ----------------

export async function getAdminStats() {
  const today = `(date_trunc('day', NOW() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')::timestamp`;
  const [totals, daily, top] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE telegram_id > 0) AS users,
        (SELECT COUNT(*)::int FROM users WHERE telegram_id > 0 AND created_at >= ${today}) AS new_today,
        (SELECT COUNT(*)::int FROM users WHERE telegram_id > 0 AND last_seen_at >= ${today}) AS active_today,
        (SELECT COUNT(*)::int FROM users WHERE telegram_id > 0 AND last_seen_at >= NOW() - INTERVAL '7 days') AS active_7d,
        (SELECT COUNT(*)::int FROM tokens WHERE is_hidden = false AND owner_id <> (SELECT id FROM users WHERE telegram_id = -1)) AS tokens,
        (SELECT COUNT(*)::int FROM transactions WHERE tape = true AND created_at >= ${today}) AS trades_today,
        (SELECT COALESCE(SUM(total_cost), 0) FROM transactions WHERE tape = true AND created_at >= ${today}) AS volume_today,
        (SELECT COUNT(*)::int FROM promo_chats WHERE is_active) AS promo_chats,
        (SELECT COALESCE(SUM(stars), 0)::int FROM stars_payments) AS stars_total,
        (SELECT COUNT(*)::int FROM users WHERE bot_blocked) AS blocked_bot
    `),
    pool.query(`
      WITH days AS (
        SELECT generate_series(0, 13) AS n
      ), d AS (
        SELECT ((date_trunc('day', NOW() AT TIME ZONE '${TZ}') - n * INTERVAL '1 day') AT TIME ZONE '${TZ}')::timestamp AS start
        FROM days
      )
      SELECT to_char(d.start::timestamptz AT TIME ZONE '${TZ}', 'DD.MM') AS day,
        (SELECT COUNT(*)::int FROM users u WHERE u.telegram_id > 0 AND u.created_at >= d.start AND u.created_at < d.start + INTERVAL '1 day') AS new_users,
        (SELECT COUNT(*)::int FROM transactions t WHERE t.tape = true AND t.created_at >= d.start AND t.created_at < d.start + INTERVAL '1 day') AS trades
      FROM d ORDER BY d.start
    `),
    pool.query(`
      SELECT u.username, COUNT(r.id)::int AS invited
      FROM users u JOIN users r ON r.referred_by = u.id
      WHERE u.telegram_id > 0
      GROUP BY u.id, u.username ORDER BY invited DESC LIMIT 5
    `),
  ]);
  // Qaytish ko'rsatkichi: kecha ro'yxatdan o'tganlarning qanchasi bugun kirdi
  const ret = await pool.query(`
    SELECT COUNT(*)::int AS cohort,
           COUNT(*) FILTER (WHERE last_seen_at >= ${today})::int AS returned
    FROM users
    WHERE telegram_id > 0 AND created_at >= ${today} - INTERVAL '1 day' AND created_at < ${today}
  `);
  return {
    ...totals.rows[0],
    volume_today: Number(totals.rows[0].volume_today),
    retention_d1: ret.rows[0].cohort > 0 ? ret.rows[0].returned / ret.rows[0].cohort : null,
    retention_cohort: ret.rows[0].cohort,
    daily: daily.rows,
    topReferrers: top.rows,
  };
}
