import { pool } from "../db/pool";
import { recordBalanceSnapshot } from "./balanceHistoryService";

/**
 * NEX DO'KONI (v9): Telegram Stars orqali Nex sotib olish.
 *
 * Paketlar (to'liq narx) + har kuni yangilanadigan chegirmali takliflar:
 *  - 🎁 Birinchi xarid  -50% (umrida bir marta)
 *  - 🔥 Kun taklifi     -50% (har kuni boshqa paket, kuniga 1 marta)
 *  - ⚡ Tezkor taklif    -20% (har kuni boshqa paket, kuniga 1 marta)
 * Kun Toshkent vaqti bilan 00:00 da almashadi.
 *
 * Narx va chegirma faqat serverda hisoblanadi; to'lovdan oldin (pre_checkout)
 * taklif hali amal qilishi qayta tekshiriladi.
 */

export const NEX_PACKAGES = [
  { id: "s", stars: 25, nex: 2_500, title: "Boshlang'ich" },
  { id: "m", stars: 100, nex: 11_000, title: "Treyder" },
  { id: "l", stars: 250, nex: 30_000, title: "Investor" },
  { id: "xl", stars: 500, nex: 65_000, title: "Kit 🐳" },
];

export interface NexOffer {
  id: string;            // taklif kodi: std_s, first, daily50, daily20
  packageId: string;
  title: string;
  label: string | null;  // "-50%" va h.k.
  discount: number;      // foiz
  stars: number;         // to'lanadigan Stars (chegirma bilan)
  fullStars: number;     // chegirmasiz
  nex: number;
  limited: boolean;      // chegirmali (cheklangan) taklif
  available: boolean;
  endsAt: string | null; // kun oxiri (chegirmali takliflar uchun)
}

function tashkentDay(d = new Date()) {
  const t = new Date(d.getTime() + 5 * 3600_000);
  return {
    key: t.toISOString().slice(0, 10).replace(/-/g, ""),
    index: Math.floor(t.getTime() / 86_400_000),
    endsAt: new Date((Math.floor(t.getTime() / 86_400_000) + 1) * 86_400_000 - 5 * 3600_000).toISOString(),
  };
}

const discounted = (stars: number, pct: number) => Math.max(1, Math.round((stars * (100 - pct)) / 100));

async function usage(userId: number, dayKey: string) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE kind = 'nex')::int AS any_nex,
       COUNT(*) FILTER (WHERE kind = 'nex' AND offer = 'first')::int AS first_used,
       COUNT(*) FILTER (WHERE kind = 'nex' AND offer = 'daily50' AND day_key = $2)::int AS d50,
       COUNT(*) FILTER (WHERE kind = 'nex' AND offer = 'daily20' AND day_key = $2)::int AS d20
     FROM stars_payments WHERE user_id = $1`,
    [userId, dayKey]
  );
  return rows[0];
}

/** Foydalanuvchi uchun bugungi takliflar (avval chegirmalilar). */
export async function getNexOffers(userId: number, now = new Date()) {
  const day = tashkentDay(now);
  const u = await usage(userId, day.key);
  const P = NEX_PACKAGES;
  const pkg50 = P[day.index % P.length];
  const pkg20 = P[(day.index + 2) % P.length];
  const mk = (id: string, p: typeof P[number], discount: number, label: string | null, limited: boolean, available: boolean): NexOffer => ({
    id, packageId: p.id, title: p.title, label, discount,
    stars: discounted(p.stars, discount), fullStars: p.stars, nex: p.nex,
    limited, available, endsAt: limited && id !== "first" ? day.endsAt : null,
  });
  const offers: NexOffer[] = [];
  if (Number(u.any_nex) === 0 && Number(u.first_used) === 0) {
    offers.push(mk("first", P[1], 50, "🎁 Birinchi xarid -50%", true, true));
  }
  offers.push(mk("daily50", pkg50, 50, "🔥 Kun taklifi -50%", true, Number(u.d50) === 0));
  offers.push(mk("daily20", pkg20, 20, "⚡ Tezkor taklif -20%", true, Number(u.d20) === 0));
  for (const p of P) offers.push(mk(`std_${p.id}`, p, 0, null, false, true));
  return { dayKey: day.key, endsAt: day.endsAt, offers };
}

/** Taklifni tekshiradi (hisob-faktura yaratishda va to'lovdan oldin). */
export async function resolveOffer(userId: number, offerId: string, dayKey?: string) {
  const { dayKey: today, offers } = await getNexOffers(userId);
  if (dayKey && dayKey !== today && offerId.startsWith("daily")) {
    throw new Error("Bu taklif muddati tugadi - sahifani yangilang");
  }
  const o = offers.find((x) => x.id === offerId);
  if (!o) throw new Error("Taklif topilmadi yoki muddati tugagan");
  if (!o.available) throw new Error("Bu chegirmadan bugun foydalangansiz - ertaga yangi taklif chiqadi");
  return { offer: o, dayKey: today };
}

export function buildNexPayload(offerId: string, userId: number, dayKey: string) {
  return `nex:${offerId}:${userId}:${dayKey}`;
}

export function parseNexPayload(payload: string) {
  const [kind, offerId, userId, dayKey] = String(payload).split(":");
  if (kind !== "nex" || !offerId || !Number(userId) || !/^\d{8}$/.test(dayKey ?? "")) return null;
  return { offerId, userId: Number(userId), dayKey };
}

/** Muvaffaqiyatli to'lov: Nex balansga qo'shiladi. charge_id takrorlansa - qayta qo'shilmaydi. */
export async function applyNexPayment(payload: string, chargeId: string, stars: number, payerTelegramId: number) {
  const p = parseNexPayload(payload);
  if (!p) throw new Error("Noto'g'ri to'lov ma'lumoti");
  const pkgId = p.offerId === "first" ? "m" : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("SELECT id FROM users WHERE id = $1 AND telegram_id = $2 FOR UPDATE", [p.userId, payerTelegramId]);
    if (!u.rows[0]) throw new Error("To'lovchi mos kelmadi");
    // Paketni to'langan Stars bo'yicha aniqlaymiz (taklif kodi + to'lov summasi mos bo'lishi shart)
    const offers = await getNexOffersFor(p.offerId, p.dayKey);
    const o = offers.find((x) => x.stars === stars && (!pkgId || x.packageId === pkgId));
    if (!o) throw new Error("To'lov summasi taklifga mos emas");
    const ins = await client.query(
      `INSERT INTO stars_payments (user_id, token_id, kind, stars, charge_id, offer, day_key, nex_amount)
       VALUES ($1, NULL, 'nex', $2, $3, $4, $5, $6)
       ON CONFLICT (charge_id) DO NOTHING RETURNING id`,
      [p.userId, stars, chargeId, p.offerId, p.dayKey, o.nex]
    );
    if (!ins.rows.length) {
      await client.query("COMMIT");
      return { already: true, nex: o.nex, newBalance: null as string | null };
    }
    const b = await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2 RETURNING nex_trade_balance",
      [o.nex, p.userId]
    );
    await recordBalanceSnapshot(p.userId, b.rows[0].nex_trade_balance, client);
    await client.query("COMMIT");
    return { already: false, nex: o.nex, newBalance: b.rows[0].nex_trade_balance as string };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** To'lov kelganda: shu taklif kodi o'sha kuni qaysi paketlarga to'g'ri kelardi. */
async function getNexOffersFor(offerId: string, dayKey: string) {
  const y = Number(dayKey.slice(0, 4)), m = Number(dayKey.slice(4, 6)), d = Number(dayKey.slice(6, 8));
  const index = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const P = NEX_PACKAGES;
  if (offerId === "first") return [{ packageId: "m", stars: discounted(P[1].stars, 50), nex: P[1].nex }];
  if (offerId === "daily50") { const p = P[index % P.length]; return [{ packageId: p.id, stars: discounted(p.stars, 50), nex: p.nex }]; }
  if (offerId === "daily20") { const p = P[(index + 2) % P.length]; return [{ packageId: p.id, stars: discounted(p.stars, 20), nex: p.nex }]; }
  const p = P.find((x) => `std_${x.id}` === offerId);
  return p ? [{ packageId: p.id, stars: p.stars, nex: p.nex }] : [];
}
