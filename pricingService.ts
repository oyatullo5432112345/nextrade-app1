/**
 * Bonding Curve narx mexanizmi.
 *
 * Narx formulasi:
 *   narx = base_price * (1 + circulating_supply / max_supply) ^ k
 *
 * Token qancha ko'p sotib olinsa (circulating_supply oshsa), narx ko'tariladi.
 * Token qancha ko'p sotilsa (circulating_supply kamaysa), narx tushadi.
 * Narx faqat foydalanuvchilarning savdo faoliyatiga bog'liq - qo'lda o'zgartirilmaydi.
 *
 * Natija har doim 0.0001 va 0.01 UZS oralig'ida cheklanadi.
 */

const MIN_PRICE = 0.0001;
const MAX_PRICE = 0.01;

export function calculatePrice(
  basePrice: number,
  circulatingSupply: number,
  maxSupply: number,
  k: number
): number {
  const ratio = circulatingSupply / maxSupply;
  const rawPrice = basePrice * Math.pow(1 + ratio, k);
  return clamp(rawPrice, MIN_PRICE, MAX_PRICE);
}

/**
 * Ma'lum miqdorda token sotib olish narxini hisoblaydi.
 * Supply o'zgarishi bo'yicha integral (o'rtacha narx) yordamida hisoblanadi,
 * shunda katta miqdorda sotib olish narxni bosqichma-bosqich oshiradi.
 */
export function calculateBuyCost(
  basePrice: number,
  currentSupply: number,
  maxSupply: number,
  k: number,
  buyAmount: number
): { totalCost: number; newSupply: number; newPrice: number } {
  const steps = 10; // aniqlik uchun bosqichlarga bo'lib hisoblaymiz
  const stepAmount = buyAmount / steps;
  let supply = currentSupply;
  let totalCost = 0;

  for (let i = 0; i < steps; i++) {
    const price = calculatePrice(basePrice, supply, maxSupply, k);
    totalCost += price * stepAmount;
    supply += stepAmount;
  }

  const newPrice = calculatePrice(basePrice, supply, maxSupply, k);
  return { totalCost, newSupply: supply, newPrice };
}

export function calculateSellReturn(
  basePrice: number,
  currentSupply: number,
  maxSupply: number,
  k: number,
  sellAmount: number
): { totalReturn: number; newSupply: number; newPrice: number } {
  const steps = 10;
  const stepAmount = sellAmount / steps;
  let supply = currentSupply;
  let totalReturn = 0;

  for (let i = 0; i < steps; i++) {
    const price = calculatePrice(basePrice, supply, maxSupply, k);
    totalReturn += price * stepAmount;
    supply -= stepAmount;
  }

  const newPrice = calculatePrice(basePrice, Math.max(supply, 0), maxSupply, k);
  return { totalReturn, newSupply: Math.max(supply, 0), newPrice };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Token yaratilganda boshlang'ich narxni tanlaydi (0.0001 - 0.01 oralig'ida).
 * Nom asosida deterministik "omad" hosil qilinadi - shu bilan bir xil nomdagi
 * tokenlar doim bir xil boshlang'ich narxdan boshlaydi.
 */
export function generateInitialPrice(symbol: string): number {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  }
  const fraction = (hash % 10000) / 10000; // 0..1 oralig'ida
  return MIN_PRICE + fraction * (MAX_PRICE - MIN_PRICE);
}
