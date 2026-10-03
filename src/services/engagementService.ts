import { PoolClient } from "pg";
import { pool } from "../db/pool";
import { recordBalanceSnapshot } from "./balanceHistoryService";

/**
 * JALB QILISH FUNKSIYALARI (v3)
 *  1) Kunlik bonus seriyasi (streak)
 *  2) Vazifalar (kunlik + bir martalik)
 *  3) Haftalik liga (sotishdagi aniq foyda bo'yicha) + avtomatik mukofot
 *  4) Referal bonusi - do'st birinchi savdosini qilganda
 *
 * Barcha "kun" va "hafta" chegaralari Toshkent vaqti bo'yicha hisoblanadi.
 */

const TZ = "Asia/Tashkent";

// ---------------- 1) KUNLIK BONUS SERIYASI ----------------

// 1-kun ... 7-kun mukofotlari. 7 kundan keyin tsikl boshidan davom etadi,
// lekin seriya hisoblagichi o'saveradi (profilda "🔥 12 kun" ko'rinadi).
export const STREAK_REWARDS = (process.env.STREAK_REWARDS ?? "5,10,15,20,30,50,100")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => x > 0);

function rewardForStreak(streak: number): number {
  const idx = (Math.max(streak, 1) - 1) % STREAK_REWARDS.length;
  return STREAK_REWARDS[idx];
}

/** Foydalanuvchining bugungi (Toshkent) holati: bugun olganmi, seriya, keyingi mukofot. */
export async function getStreakStatus(userId: number) {
  const { rows } = await pool.query(
    `SELECT daily_streak,
            (last_daily_bonus_at::timestamptz AT TIME ZONE '${TZ}')::date AS last_day,
            (NOW() AT TIME ZONE '${TZ}')::date AS today
     FROM users WHERE id = $1`,
    [userId]
  );
  if (rows.length === 0) throw new Error("Foydalanuvchi topilmadi");
  const r = rows[0];
  const lastDay = r.last_day ? new Date(r.last_day).getTime() : null;
  const today = new Date(r.today).getTime();
  const dayMs = 86_400_000;

  const claimedToday = lastDay !== null && lastDay === today;
  const continues = lastDay !== null && today - lastDay === dayMs;
  // Bugun olinmagan bo'lsa: kecha olingan -> seriya davom etadi, aks holda 1 dan
  const currentStreak = claimedToday || continues ? Number(r.daily_streak) : 0;
  const nextStreak = claimedToday ? currentStreak + 1 : currentStreak + 1;

  return {
    streak: currentStreak,
    claimedToday,
    nextReward: rewardForStreak(nextStreak),
    // 7 kunlik tsikldagi joriy o'rin (0..6) - frontend'dagi nuqtalar uchun
    cycleDay: currentStreak === 0 ? 0 : ((currentStreak - 1) % STREAK_REWARDS.length) + 1,
    rewards: STREAK_REWARDS,
  };
}

export async function claimStreakBonus(userId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT daily_streak,
              (last_daily_bonus_at::timestamptz AT TIME ZONE '${TZ}')::date AS last_day,
              (NOW() AT TIME ZONE '${TZ}')::date AS today
       FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (rows.length === 0) throw new Error("Foydalanuvchi topilmadi");
    const r = rows[0];
    const lastDay = r.last_day ? new Date(r.last_day).getTime() : null;
    const today = new Date(r.today).getTime();

    if (lastDay !== null && lastDay === today) {
      throw new Error("Bugungi bonus olingan. Ertaga qayta keling - seriyani uzmang! 🔥");
    }
    const continues = lastDay !== null && today - lastDay === 86_400_000;
    const streak = continues ? Number(r.daily_streak) + 1 : 1;
    const bonus = rewardForStreak(streak);

    const upd = await client.query(
      `UPDATE users SET nex_trade_balance = nex_trade_balance + $1,
              last_daily_bonus_at = NOW(), daily_streak = $2, max_streak = GREATEST(max_streak, $2)
       WHERE id = $3 RETURNING nex_trade_balance`,
      [bonus, streak, userId]
    );
    await recordBalanceSnapshot(userId, upd.rows[0].nex_trade_balance, client);
    await client.query("COMMIT");
    return { bonus, streak, newBalance: upd.rows[0].nex_trade_balance, nextReward: rewardForStreak(streak + 1) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------- 2) VAZIFALAR ----------------

type MissionPeriod = "daily" | "once";
interface MissionDef {
  id: string;
  title: string;
  emoji: string;
  reward: number;
  target: number;
  period: MissionPeriod;
  // bugungi kun boshidan (daily) yoki hamma vaqt (once) bo'yicha progress
  progressSql: string;
}

const TODAY_START_SQL = `((date_trunc('day', NOW() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')::timestamp)`;

export const MISSIONS: MissionDef[] = [
  {
    id: "first_trade", emoji: "🎯", title: "Birinchi savdoingni qil", reward: 20, target: 1, period: "once",
    progressSql: `SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1`,
  },
  {
    id: "create_token", emoji: "🛠️", title: "O'z tokeningni yarat", reward: 50, target: 1, period: "once",
    progressSql: `SELECT COUNT(*)::int AS n FROM tokens WHERE owner_id = $1`,
  },
  {
    id: "invite_friend", emoji: "👥", title: "Do'stingni taklif qil (u savdo qilsin)", reward: 30, target: 1, period: "once",
    progressSql: `SELECT COUNT(*)::int AS n FROM users WHERE referred_by = $1 AND referral_rewarded = true`,
  },
  {
    id: "daily_trades", emoji: "📈", title: "Bugun 3 ta savdo qil", reward: 15, target: 3, period: "daily",
    progressSql: `SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1 AND created_at >= ${TODAY_START_SQL}`,
  },
  {
    id: "daily_sell_profit", emoji: "💰", title: "Bugun foyda bilan sot", reward: 10, target: 1, period: "daily",
    progressSql: `SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1 AND type = 'sell' AND realized_pnl > 0 AND created_at >= ${TODAY_START_SQL}`,
  },
  {
    id: "daily_favorite", emoji: "⭐", title: "Bitta tokenni sevimlilarga qo'sh", reward: 5, target: 1, period: "daily",
    progressSql: `SELECT COUNT(*)::int AS n FROM favorites WHERE user_id = $1 AND created_at >= ${TODAY_START_SQL}`,
  },
];

async function periodKey(period: MissionPeriod, runner: { query: PoolClient["query"] } = pool): Promise<string> {
  if (period === "once") return "once";
  const { rows } = await runner.query(`SELECT to_char(NOW() AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS d`);
  return rows[0].d;
}

export async function getMissions(userId: number) {
  const todayKey = await periodKey("daily");
  const claims = await pool.query(
    `SELECT mission_id, period_key FROM mission_claims WHERE user_id = $1 AND period_key IN ('once', $2)`,
    [userId, todayKey]
  );
  const claimed = new Set(claims.rows.map((c) => `${c.mission_id}:${c.period_key}`));

  const result = [];
  for (const m of MISSIONS) {
    const { rows } = await pool.query(m.progressSql, [userId]);
    const progress = Math.min(Number(rows[0].n), m.target);
    const key = m.period === "once" ? "once" : todayKey;
    result.push({
      id: m.id,
      emoji: m.emoji,
      title: m.title,
      reward: m.reward,
      target: m.target,
      period: m.period,
      progress,
      done: progress >= m.target,
      claimed: claimed.has(`${m.id}:${key}`),
    });
  }
  return result;
}

export async function claimMission(userId: number, missionId: string) {
  const m = MISSIONS.find((x) => x.id === missionId);
  if (!m) throw new Error("Bunday vazifa yo'q");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);

    const { rows } = await client.query(m.progressSql, [userId]);
    if (Number(rows[0].n) < m.target) throw new Error("Vazifa hali bajarilmagan");

    const key = await periodKey(m.period, client);
    const ins = await client.query(
      `INSERT INTO mission_claims (user_id, mission_id, period_key, reward)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
      [userId, m.id, key, m.reward]
    );
    if (ins.rows.length === 0) throw new Error("Bu vazifa mukofoti allaqachon olingan");

    const upd = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
      [m.reward, userId]
    );
    await recordBalanceSnapshot(userId, upd.rows[0].nex_trade_balance, client);
    await client.query("COMMIT");
    return { reward: m.reward, newBalance: upd.rows[0].nex_trade_balance };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------- 3) HAFTALIK LIGA ----------------

// 1-10 o'rinlar uchun mukofotlar (.env: LEAGUE_PRIZES="1000,500,300,100,...")
export const LEAGUE_PRIZES = (process.env.LEAGUE_PRIZES ?? "1000,500,300,100,100,100,100,100,100,100")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => x >= 0);

// Ligaga kirish sharti: haftada kamida shuncha foyda va shuncha sotuv.
// Aks holda bir nechta akkaunt ochib, +0.1 Nex foyda bilan 1000 Nex mukofot olish mumkin edi.
export const LEAGUE_MIN_PNL = Number(process.env.LEAGUE_MIN_PNL ?? 1);
export const LEAGUE_MIN_SELLS = Number(process.env.LEAGUE_MIN_SELLS ?? 3);

// Hafta boshi (dushanba 00:00, Toshkent) - bazadagi naive TIMESTAMP ko'rinishida.
// offsetWeeks = 0 -> joriy hafta, -1 -> o'tgan hafta
function weekStartSql(offsetWeeks: number) {
  return `((date_trunc('week', NOW() AT TIME ZONE '${TZ}') + INTERVAL '${offsetWeeks} week') AT TIME ZONE '${TZ}')::timestamp`;
}

async function leagueTop(fromSql: string, toSql: string, limit: number, runner: { query: PoolClient["query"] } = pool) {
  const { rows } = await runner.query(
    `SELECT u.id AS user_id, u.username, SUM(t.realized_pnl) AS pnl, COUNT(*)::int AS sells
     FROM transactions t JOIN users u ON u.id = t.user_id
     WHERE t.type = 'sell' AND t.realized_pnl IS NOT NULL
       AND t.created_at >= ${fromSql} AND t.created_at < ${toSql}
       AND u.telegram_id > 0
     GROUP BY u.id, u.username
     HAVING SUM(t.realized_pnl) >= $2 AND COUNT(*) >= $3
     ORDER BY pnl DESC
     LIMIT $1`,
    [limit, Math.max(LEAGUE_MIN_PNL, 0.0001), LEAGUE_MIN_SELLS]
  );
  return rows.map((r, i) => ({
    rank: i + 1,
    userId: Number(r.user_id),
    username: r.username,
    pnl: Number(r.pnl),
    sells: r.sells,
    prize: LEAGUE_PRIZES[i] ?? 0,
  }));
}

export async function getLeague(userId: number) {
  const top = await leagueTop(weekStartSql(0), weekStartSql(1), 10);
  const [endsRes, meRes, lastRes] = await Promise.all([
    pool.query(`SELECT (${weekStartSql(1)})::timestamptz AS ends_at`),
    pool.query(
      `WITH s AS (
         SELECT user_id, SUM(realized_pnl) AS pnl, COUNT(*)::int AS sells FROM transactions
         WHERE type = 'sell' AND realized_pnl IS NOT NULL
           AND created_at >= ${weekStartSql(0)} AND created_at < ${weekStartSql(1)}
         GROUP BY user_id
       )
       SELECT pnl, sells, (SELECT COUNT(*) + 1 FROM s s2 WHERE s2.pnl > s.pnl AND s2.sells >= $3 AND s2.pnl >= $2)::int AS rank
       FROM s WHERE user_id = $1`,
      [userId, LEAGUE_MIN_PNL, LEAGUE_MIN_SELLS]
    ),
    pool.query(
      `SELECT lp.rank, lp.reward, lp.pnl, u.username FROM league_payouts lp
       LEFT JOIN users u ON u.id = lp.user_id
       WHERE lp.week_key = (SELECT MAX(week_key) FROM league_payouts) AND lp.user_id IS NOT NULL
       ORDER BY lp.rank LIMIT 3`
    ),
  ]);

  const m = meRes.rows[0];
  const me = m
    ? {
        rank: m.rank,
        pnl: Number(m.pnl),
        sells: Number(m.sells),
        qualified: Number(m.pnl) >= LEAGUE_MIN_PNL && Number(m.sells) >= LEAGUE_MIN_SELLS,
      }
    : null;
  return {
    endsAt: endsRes.rows[0].ends_at,
    prizes: LEAGUE_PRIZES,
    minPnl: LEAGUE_MIN_PNL,
    minSells: LEAGUE_MIN_SELLS,
    top: top.map(({ userId: _u, ...rest }) => ({ ...rest, isMe: _u === userId })),
    me,
    lastWinners: lastRes.rows.map((r) => ({ rank: r.rank, username: r.username, reward: Number(r.reward) })),
  };
}

/**
 * O'tgan hafta g'oliblariga mukofot to'laydi. Soatda bir marta chaqiriladi
 * (priceFluctuationService). league_payouts(week_key, rank) UNIQUE bo'lgani
 * uchun ikki marta to'lanmaydi. Hech kim foyda qilmagan hafta ham "belgilanadi".
 */
export async function payoutPreviousWeek(
  notify?: (telegramId: number, text: string) => Promise<void>
): Promise<number> {
  const client = await pool.connect();
  const winners: { telegramId: number; text: string }[] = [];
  try {
    await client.query("BEGIN");
    // Bir nechta server nusxasi bir vaqtda to'lamasligi uchun qulf
    await client.query("SELECT pg_advisory_xact_lock(777001)");

    const wk = await client.query(
      `SELECT to_char(date_trunc('week', NOW() AT TIME ZONE '${TZ}') - INTERVAL '1 week', 'IYYY-"W"IW') AS k`
    );
    const weekKey: string = wk.rows[0].k;
    const done = await client.query("SELECT 1 FROM league_payouts WHERE week_key = $1 LIMIT 1", [weekKey]);
    if (done.rows.length > 0) {
      await client.query("COMMIT");
      return 0;
    }

    const top = await leagueTop(weekStartSql(-1), weekStartSql(0), LEAGUE_PRIZES.length, client);
    if (top.length === 0) {
      await client.query(
        "INSERT INTO league_payouts (week_key, rank, user_id, pnl, reward) VALUES ($1, 0, NULL, 0, 0)",
        [weekKey]
      );
    }
    for (const w of top) {
      await client.query(
        "INSERT INTO league_payouts (week_key, rank, user_id, pnl, reward) VALUES ($1, $2, $3, $4, $5)",
        [weekKey, w.rank, w.userId, w.pnl, w.prize]
      );
      if (w.prize > 0) {
        const upd = await client.query(
          "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance, telegram_id",
          [w.prize, w.userId]
        );
        await recordBalanceSnapshot(w.userId, upd.rows[0].nex_trade_balance, client);
        winners.push({
          telegramId: Number(upd.rows[0].telegram_id),
          text:
            `🏆 Tabriklaymiz! Haftalik ligada ${w.rank}-o'rinni egalladingiz!\n\n` +
            `💰 Haftalik foyda: +${w.pnl.toFixed(2)} Nex Trade\n` +
            `🎁 Mukofot: +${w.prize} Nex Trade balansingizga qo'shildi.\n\n` +
            `Yangi hafta boshlandi - yana g'olib bo'ling! 🔥`,
        });
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (notify) {
    for (const w of winners) await notify(w.telegramId, w.text);
  }
  return winners.length;
}

// ---------------- 4) REFERAL: DO'ST BIRINCHI SAVDOSIDA ----------------

export const REFERRAL_REWARD = Number(process.env.REFERRAL_BONUS ?? 20);

/**
 * tradeService.buyToken ichidagi OCHIQ tranzaksiyada chaqiriladi.
 * Agar xaridor taklif orqali kelgan va bonus hali berilmagan bo'lsa -
 * ikkala tomonga REFERRAL_REWARD beriladi. Taklif qilganning telegram_id sini
 * qaytaradi (COMMIT'dan keyin xabar yuborish uchun).
 */
export async function rewardReferralOnFirstTrade(
  client: PoolClient,
  userId: number
): Promise<{ referrerTelegramId: number; reward: number } | null> {
  if (REFERRAL_REWARD <= 0) return null;
  const { rows } = await client.query(
    `UPDATE users SET referral_rewarded = true
     WHERE id = $1 AND referred_by IS NOT NULL AND referral_rewarded = false
     RETURNING referred_by`,
    [userId]
  );
  if (rows.length === 0) return null;
  const referrerId = Number(rows[0].referred_by);

  const me = await client.query(
    "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
    [REFERRAL_REWARD, userId]
  );
  await recordBalanceSnapshot(userId, me.rows[0].nex_trade_balance, client);

  const ref = await client.query(
    "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance, telegram_id",
    [REFERRAL_REWARD, referrerId]
  );
  if (ref.rows.length === 0) return null;
  await recordBalanceSnapshot(referrerId, ref.rows[0].nex_trade_balance, client);
  return { referrerTelegramId: Number(ref.rows[0].telegram_id), reward: REFERRAL_REWARD };
}
