import { pool } from "../db/pool";
import { recordBalanceSnapshot } from "./balanceHistoryService";
import { containsBadWords } from "./moderationService";

/**
 * GURUH VA JAMOA FUNKSIYALARI (v6)
 *  1) Guruhlar ligasi - bot qo'shilgan guruhlar a'zolari haftalik foydasi bo'yicha
 *  2) Giveaway - "birinchi N kishiga +X Nex" tugmali post
 *  3) Klanlar - 20 kishigacha jamoalar va jamoalar reytingi
 */

const TZ = "Asia/Tashkent";
function weekStartSql(offset: number) {
  return `((date_trunc('week', NOW() AT TIME ZONE '${TZ}') + INTERVAL '${offset} week') AT TIME ZONE '${TZ}')::timestamp`;
}

// ---------------- 1) Guruhlar ligasi ----------------

/** Foydalanuvchini guruh jamoasiga qo'shadi (faqat bot turgan guruhlar). */
export async function setUserGroup(telegramId: number, chatId: number): Promise<string | null> {
  const chat = await pool.query("SELECT title FROM promo_chats WHERE chat_id = $1", [chatId]);
  if (!chat.rows[0]) return null;
  const upd = await pool.query("UPDATE users SET group_chat_id = $1 WHERE telegram_id = $2 RETURNING id", [chatId, telegramId]);
  if (!upd.rows[0]) return null;
  return chat.rows[0].title ?? "guruh";
}

export async function getGroupLeague(limit = 10) {
  const { rows } = await pool.query(
    `SELECT pc.chat_id, pc.title,
            COUNT(DISTINCT u.id)::int AS members,
            COALESCE(SUM(t.realized_pnl) FILTER (
              WHERE t.type = 'sell' AND t.created_at >= ${weekStartSql(0)}
            ), 0) AS pnl
     FROM promo_chats pc
     JOIN users u ON u.group_chat_id = pc.chat_id AND u.telegram_id > 0
     LEFT JOIN transactions t ON t.user_id = u.id AND t.created_at >= ${weekStartSql(0)}
     GROUP BY pc.chat_id, pc.title
     ORDER BY pnl DESC, members DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r, i) => ({ rank: i + 1, chatId: Number(r.chat_id), title: r.title, members: r.members, pnl: Number(r.pnl) }));
}

// ---------------- 2) Giveaway ----------------

export const GIVEAWAY_MAX_AMOUNT = 10_000;
export const GIVEAWAY_MAX_CLAIMS = 10_000;

export async function createGiveaway(chatId: number, amount: number, maxClaims: number) {
  if (!(amount > 0 && amount <= GIVEAWAY_MAX_AMOUNT)) throw new Error(`Miqdor 1 dan ${GIVEAWAY_MAX_AMOUNT} gacha bo'lsin`);
  if (!(Number.isInteger(maxClaims) && maxClaims >= 1 && maxClaims <= GIVEAWAY_MAX_CLAIMS)) throw new Error("Odamlar soni 1 dan 10000 gacha bo'lsin");
  const { rows } = await pool.query(
    "INSERT INTO giveaways (chat_id, amount, max_claims) VALUES ($1, $2, $3) RETURNING *",
    [chatId, amount, maxClaims]
  );
  return rows[0];
}

export async function setGiveawayMessage(id: number, messageId: number) {
  await pool.query("UPDATE giveaways SET message_id = $2 WHERE id = $1", [id, messageId]);
}

export async function claimGiveaway(giveawayId: number, telegramId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const g = await client.query("SELECT * FROM giveaways WHERE id = $1 FOR UPDATE", [giveawayId]);
    const gw = g.rows[0];
    if (!gw || !gw.is_active || gw.claims_count >= gw.max_claims) throw new Error("😔 Kechikdingiz - sovg'alar tugadi");
    const u = await client.query("SELECT id, is_banned FROM users WHERE telegram_id = $1 FOR UPDATE", [telegramId]);
    if (!u.rows[0]) throw new Error("NEED_START");
    if (u.rows[0].is_banned) throw new Error("Hisobingiz bloklangan");

    const ins = await client.query(
      "INSERT INTO giveaway_claims (giveaway_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
      [giveawayId, u.rows[0].id]
    );
    if (!ins.rows.length) throw new Error("Siz bu sovg'ani allaqachon olgansiz 🙂");

    const newCount = gw.claims_count + 1;
    const finished = newCount >= gw.max_claims;
    await client.query("UPDATE giveaways SET claims_count = $2, is_active = $3 WHERE id = $1", [giveawayId, newCount, !finished]);
    const upd = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
      [gw.amount, u.rows[0].id]
    );
    await recordBalanceSnapshot(u.rows[0].id, upd.rows[0].nex_trade_balance, client);
    await client.query("COMMIT");
    return { reward: Number(gw.amount), claims: newCount, max: gw.max_claims, finished, chatId: Number(gw.chat_id), messageId: Number(gw.message_id ?? 0) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------- 3) Klanlar ----------------

export const CLAN_CREATE_FEE = Number(process.env.CLAN_CREATE_FEE ?? 200);
export const CLAN_MAX_MEMBERS = Number(process.env.CLAN_MAX_MEMBERS ?? 20);

export async function createClan(userId: number, rawName: string, rawTag: string) {
  const name = rawName.replace(/\s+/g, " ").trim();
  const tag = rawTag.trim().toUpperCase();
  if (name.length < 3 || name.length > 32) throw new Error("Klan nomi 3-32 belgi bo'lsin");
  if (!/^[A-Z0-9]{2,6}$/.test(tag)) throw new Error("Klan belgisi 2-6 ta lotin harf/raqam bo'lsin (masalan: TOSH)");
  if (/[<>]/.test(name) || containsBadWords(name) || containsBadWords(tag)) throw new Error("Nomda nomaqbul so'z yoki belgi bor");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("SELECT nex_trade_balance, clan_id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (u.rows[0].clan_id) throw new Error("Siz allaqachon klandasiz. Avval undan chiqing");
    if (Number(u.rows[0].nex_trade_balance) < CLAN_CREATE_FEE) throw new Error(`Klan ochish uchun ${CLAN_CREATE_FEE} Nex kerak`);
    const c = await client.query("INSERT INTO clans (name, tag, owner_id) VALUES ($1, $2, $3) RETURNING *", [name, tag, userId]);
    const upd = await client.query(
      "UPDATE users SET clan_id = $1, nex_trade_balance = nex_trade_balance - $2 WHERE id = $3 RETURNING nex_trade_balance",
      [c.rows[0].id, CLAN_CREATE_FEE, userId]
    );
    await recordBalanceSnapshot(userId, upd.rows[0].nex_trade_balance, client);
    await client.query("COMMIT");
    return c.rows[0];
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err?.code === "23505") throw new Error("Bu belgi band. Boshqasini tanlang");
    throw err;
  } finally {
    client.release();
  }
}

export async function joinClan(userId: number, rawTag: string) {
  const tag = rawTag.trim().toUpperCase().replace(/^\[|\]$/g, "");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await client.query("SELECT * FROM clans WHERE tag = $1 FOR UPDATE", [tag]);
    if (!c.rows[0]) throw new Error("Bunday klan topilmadi");
    const u = await client.query("SELECT clan_id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (u.rows[0].clan_id) throw new Error("Siz allaqachon klandasiz. Avval undan chiqing");
    const n = await client.query("SELECT COUNT(*)::int AS n FROM users WHERE clan_id = $1", [c.rows[0].id]);
    if (n.rows[0].n >= CLAN_MAX_MEMBERS) throw new Error(`Klan to'la (${CLAN_MAX_MEMBERS} kishi)`);
    await client.query("UPDATE users SET clan_id = $1 WHERE id = $2", [c.rows[0].id, userId]);
    await client.query("COMMIT");
    return c.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function leaveClan(userId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("SELECT clan_id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const clanId = u.rows[0]?.clan_id;
    if (!clanId) throw new Error("Siz hech qaysi klanda emassiz");
    await client.query("UPDATE users SET clan_id = NULL WHERE id = $1", [userId]);
    const clan = await client.query("SELECT owner_id FROM clans WHERE id = $1 FOR UPDATE", [clanId]);
    if (Number(clan.rows[0]?.owner_id) === userId) {
      // Egasi chiqsa - klan eng eski a'zoga o'tadi, a'zo qolmasa klan o'chadi
      const next = await client.query("SELECT id FROM users WHERE clan_id = $1 ORDER BY created_at LIMIT 1", [clanId]);
      if (next.rows[0]) await client.query("UPDATE clans SET owner_id = $1 WHERE id = $2", [next.rows[0].id, clanId]);
      else await client.query("DELETE FROM clans WHERE id = $1", [clanId]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getMyClan(userId: number) {
  const u = await pool.query("SELECT clan_id FROM users WHERE id = $1", [userId]);
  const clanId = u.rows[0]?.clan_id;
  if (!clanId) return null;
  const c = await pool.query("SELECT * FROM clans WHERE id = $1", [clanId]);
  if (!c.rows[0]) return null;
  const members = await pool.query(
    `SELECT u.id, u.username,
            COALESCE(SUM(t.realized_pnl) FILTER (WHERE t.type = 'sell' AND t.created_at >= ${weekStartSql(0)}), 0) AS pnl
     FROM users u LEFT JOIN transactions t ON t.user_id = u.id AND t.created_at >= ${weekStartSql(0)}
     WHERE u.clan_id = $1
     GROUP BY u.id, u.username ORDER BY pnl DESC`,
    [clanId]
  );
  return {
    id: c.rows[0].id,
    name: c.rows[0].name,
    tag: c.rows[0].tag,
    isOwner: Number(c.rows[0].owner_id) === userId,
    maxMembers: CLAN_MAX_MEMBERS,
    weekPnl: members.rows.reduce((s, m) => s + Number(m.pnl), 0),
    members: members.rows.map((m) => ({ username: m.username, pnl: Number(m.pnl), isOwner: Number(m.id) === Number(c.rows[0].owner_id) })),
  };
}

export async function getClanLeague(limit = 10) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.tag, COUNT(DISTINCT u.id)::int AS members,
            COALESCE(SUM(t.realized_pnl) FILTER (WHERE t.type = 'sell' AND t.created_at >= ${weekStartSql(0)}), 0) AS pnl
     FROM clans c
     JOIN users u ON u.clan_id = c.id
     LEFT JOIN transactions t ON t.user_id = u.id AND t.created_at >= ${weekStartSql(0)}
     GROUP BY c.id, c.name, c.tag
     ORDER BY pnl DESC, members DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r, i) => ({ rank: i + 1, name: r.name, tag: r.tag, members: r.members, pnl: Number(r.pnl) }));
}
