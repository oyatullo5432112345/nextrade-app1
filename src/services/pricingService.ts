/**
 * Bonding Curve narx mexanizmi.
 *
 * Narx formulasi:
 *   narx = base_price * (1 + circulating_supply / max_supply) ^ k
 *
 * Token qancha ko'p sotib olinsa (circulating_supply oshsa), narx ko'tariladi.
 * Token qancha ko'p sotilsa (circulating_supply kamaysa), narx tushadi.
 * Bundan tashqari narxga avtomatik tebranish ham ta'sir qiladi (bu fayldagi
 * ABSOLUTE_MIN_PRICE bilan bir xil pastki chegarani hurmat qiladi, lekin
 * "priceFluctuationService.ts" faylida amalga oshiriladi).
 *
 * MUHIM: bu yerdagi MIN_PRICE/MAX_PRICE faqat token YARATILGANDA tanlanadigan
 * boshlang'ich narx (base_price) uchun ishlatiladi. Keyingi savdo/tebranish
 * jarayonida narxga yuqori chegara QO'YILMAYDI - faqat 0 ga tushib
 * ketmasligi uchun pastki chegara saqlanadi.
 */

const MIN_PRICE = 0.0001;
const MAX_PRICE = 0.01;

// Savdo/tebranish paytida narx hech qachon bundan pastga tushmaydi.
// (MIN_PRICE bilan bir xil qiymat, lekin nomi alohida - maqsadi boshqacha)
export const ABSOLUTE_MIN_PRICE = MIN_PRICE;

export function calculatePrice(
  basePrice: number,
  circulatingSupply: number,
  maxSupply: number,
  k: number
): number {
  const ratio = circulatingSupply / maxSupply;
  const rawPrice = basePrice * Math.pow(1 + ratio, k);
  // Faqat pastki chegara - yuqori chegara yo'q, narx erkin o'sishi mumkin
  return Math.max(rawPrice, ABSOLUTE_MIN_PRICE);
}

/**
 * Ma'lum miqdorda token sotib olish narxini hisoblaydi.
 * Supply o'zgarishi bo'yicha integral (o'rtacha narx) yordamida hisoblanadi,
 * shunda katta miqdorda sotib olish narxni bosqichma-bosqich oshiradi.
 *
 * MUHIM (XATOLIK TUZATILDI): avvalgi versiyada bu funksiya narxni faqat
 * base_price + circulating_supply asosida qayta hisoblardi - shu sabab
 * ekranda ko'rinib turgan (priceFluctuationService tomonidan tebratilgan)
 * current_price bilan savdo paytida ishlatiladigan narx bir-biriga mos
 * kelmasdi. Endi chaqiruvchi (tradeService) ekrandagi haqiqiy narxni
 * `displayedCurrentPrice` sifatida uzatadi - shu asosda "drift" koeffitsienti
 * hisoblanadi va savdo ANIQ shu narxdan boshlanadi.
 */
export function calculateBuyCost(
  basePrice: number,
  currentSupply: number,
  maxSupply: number,
  k: number,
  buyAmount: number,
  displayedCurrentPrice?: number
): { totalCost: number; newSupply: number; newPrice: number } {
  const steps = 10; // aniqlik uchun bosqichlarga bo'lib hisoblaymiz
  const stepAmount = buyAmount / steps;
  let supply = currentSupply;
  let totalCost = 0;

  // Bonding curve formulasi joriy supply uchun qanday narx berishini
  // hisoblaymiz, so'ng buni ekranda ko'rsatilgan haqiqiy narxga solishtirib
  // "drift" (siljish) koeffitsientini topamiz. Shu koeffitsient har bir
  // qadamdagi narxga qo'llanadi - natijada savdo doim ekrandagi narxdan
  // boshlanadi, lekin curve'ning nisbiy shakli (narx qanday o'sishi) saqlanib qoladi.
  const curvePriceAtSupply = calculatePrice(basePrice, currentSupply, maxSupply, k);
  const drift =
    displayedCurrentPrice && curvePriceAtSupply > 0
      ? displayedCurrentPrice / curvePriceAtSupply
      : 1;

  for (let i = 0; i < steps; i++) {
    const price = calculatePrice(basePrice, supply, maxSupply, k) * drift;
    totalCost += price * stepAmount;
    supply += stepAmount;
  }

  const newPrice = calculatePrice(basePrice, supply, maxSupply, k) * drift;
  return { totalCost, newSupply: supply, newPrice };
}

export function calculateSellReturn(
  basePrice: number,
  currentSupply: number,
  maxSupply: number,
  k: number,
  sellAmount: number,
  displayedCurrentPrice?: number
): { totalReturn: number; newSupply: number; newPrice: number } {
  const steps = 10;
  const stepAmount = sellAmount / steps;
  let supply = currentSupply;
  let totalReturn = 0;

  const curvePriceAtSupply = calculatePrice(basePrice, currentSupply, maxSupply, k);
  const drift =
    displayedCurrentPrice && curvePriceAtSupply > 0
      ? displayedCurrentPrice / curvePriceAtSupply
      : 1;

  for (let i = 0; i < steps; i++) {
    const price = calculatePrice(basePrice, supply, maxSupply, k) * drift;
    totalReturn += price * stepAmount;
    supply -= stepAmount;
  }

  const newPrice = calculatePrice(basePrice, Math.max(supply, 0), maxSupply, k) * drift;
  return { totalReturn, newSupply: Math.max(supply, 0), newPrice };
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
