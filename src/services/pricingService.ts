/**
 * NARX YORDAMCHILARI (v8 - order book)
 *
 * v8 dan boshlab narxni formula emas, BUYURTMALAR KITOBI (order book)
 * belgilaydi: joriy narx = oxirgi kelishuv narxi. Bu fayldagi formula faqat
 * yangi token chiqarilganda platformaning boshlang'ich sotuv "zinapoyasi"
 * (genesis/IPO) narxlarini hisoblash uchun ishlatiladi.
 */

const MIN_PRICE = 0.0001;
const MAX_PRICE = 0.01;

// Narx 8 xona aniqlikda saqlanadi
export const ABSOLUTE_MIN_PRICE = 0.00000001;

// Token miqdori bazada NUMERIC(20,4) - ya'ni 4 xonagacha aniqlik.
export const AMOUNT_DECIMALS = 4;
export const MIN_TRADE_AMOUNT = 0.0001;

// Har bir savdo ishtirokchisidan 0.25% komissiya:
// shundan 0.1% token yaratuvchisiga, 0.15% muzlatilgan fondga.
export const TOTAL_FEE = 0.0025;
export const CREATOR_FEE_SHARE = 0.1 / 0.25;

/** Miqdorni 4 xonagacha PASTGA yaxlitlaydi (foydalanuvchi oladigan token/pul uchun). */
export function floor4(n: number): number {
  return Math.floor(n * 10_000 + 1e-7) / 10_000;
}

/** Allaqachon 4 xonali sonlarni qo'shish/ayirish natijasini tozalaydi (0.0201 - 0.0101 = 0.00999999 -> 0.01). */
export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Miqdorni 4 xonagacha YUQORIGA yaxlitlaydi (foydalanuvchidan yechiladigan pul uchun). */
export function ceil4(n: number): number {
  return Math.ceil(n * 10_000 - 1e-7) / 10_000;
}

/** Narxni 8 xonaga yaxlitlaydi. */
export function round8(n: number): number {
  return Math.max(Math.round(n * 1e8) / 1e8, ABSOLUTE_MIN_PRICE);
}

/** Xaridor to'laydigan summa (komissiya bilan). */
export function buyerPays(qty: number, price: number): number {
  return ceil4(qty * price * (1 + TOTAL_FEE));
}

/** Sotuvchiga tushadigan sof summa (komissiyadan keyin). */
export function sellerGets(qty: number, price: number): number {
  return floor4(qty * price * (1 - TOTAL_FEE));
}

/**
 * Token yaratilganda boshlang'ich narxni tanlaydi (0.0001 - 0.01 oralig'ida).
 * Nom asosida deterministik "omad" hosil qilinadi.
 */
export function generateInitialPrice(symbol: string): number {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  }
  const fraction = (hash % 10000) / 10000;
  return MIN_PRICE + fraction * (MAX_PRICE - MIN_PRICE);
}

/**
 * Platforma sotuv zinapoyasi: `remaining` ta tokenni `levels` pog'onaga bo'lib,
 * har biriga narx beradi. Narx `startPrice` dan boshlab, eski egri chiziq
 * shaklida (k darajasi) asta ko'tariladi - token qancha ko'p tarqalsa,
 * keyingi pog'ona shuncha qimmat. Natija: [{ price, amount }]
 */
export function genesisLadder(
  startPrice: number,
  circulating: number,
  maxSupply: number,
  remaining: number,
  k = 1.5,
  levels = 20
): { price: number; amount: number }[] {
  remaining = floor4(remaining);
  if (!(remaining >= MIN_TRADE_AMOUNT) || !(maxSupply > 0)) return [];
  const n = Math.max(1, Math.min(levels, Math.floor(remaining / MIN_TRADE_AMOUNT)));
  const step = floor4(remaining / n);
  const F = (x: number) => Math.pow(1 + x / maxSupply, k + 1);
  const p0 = Math.max(startPrice, ABSOLUTE_MIN_PRICE);
  const base = p0 / Math.pow(1 + circulating / maxSupply, k);
  const out: { price: number; amount: number }[] = [];
  let s = circulating;
  let left = remaining;
  for (let i = 0; i < n; i++) {
    const amt = i === n - 1 ? floor4(left) : step;
    if (amt < MIN_TRADE_AMOUNT) break;
    // Pog'onadagi o'rtacha narx = egri chiziq ostidagi yuza / miqdor
    const area = (base * maxSupply) / (k + 1) * (F(s + amt) - F(s));
    out.push({ price: round8(area / amt), amount: amt });
    s += amt;
    left = floor4(left - amt);
  }
  return out;
}
