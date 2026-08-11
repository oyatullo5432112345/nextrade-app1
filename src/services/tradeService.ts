import { pool } from "../db/pool";
import { calculateBuyCost, calculateSellReturn } from "./pricingService";
import { addFrozenAmount } from "./frozenService";
import { addCreatorBonus } from "./bonusService";
import { notifyCreatorCommission } from "../bot/bot";

// Token yaratuvchisi o'z tokenidan max_supply ning 25% igacha, oddiy
// foydalanuvchilar esa faqat 10% igacha egalik qilishi mumkin (joriy
// holdings.amount + yangi xarid shu chegaradan oshmasligi kerak).
const CREATOR_MAX_HOLDING_PCT = 0.25;
const USER_MAX_HOLDING_PCT = 0.10;

// Har bir sotib olish/sotishda umumiy tranzaksiya qiymatidan 0.25% komissiya
// olinadi: shundan 0.1% token yaratuvchisiga, 0.15% esa muzlatilgan fondga
// (faqat admin tomonidan bot/mini-appni rivojlantirish uchun yechib olinadi).
const TOTAL_COMMISSION_PCT = 0.0025;
const CREATOR_COMMISSION_SHARE = 0.001;
const FROZEN_COMMISSION_SHARE = 0.0015;

/**
 * Token sotib olish. Butun operatsiya bitta SQL tranzaksiyada bajariladi
 * va qatorlar FOR UPDATE bilan qulflanadi - shu bilan bir vaqtda kelgan
 * ikkita so'rov bir-birining ustidan yozib yubormaydi (race condition oldini olish).
 */
export async function buyToken(userId: number, tokenId: number, amount: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tokenRes = await client.query(
      "SELECT * FROM tokens WHERE id = $1 FOR UPDATE",
      [tokenId]
    );
    if (tokenRes.rows.length === 0) throw new Error("Token topilmadi");
    const token = tokenRes.rows[0];

    const newSupplyCheck = Number(token.circulating_supply) + amount;
    if (newSupplyCheck > Number(token.max_supply)) {
      throw new Error("So'ralgan miqdor tokenning maksimal ta'minotidan oshib ketadi");
    }

    const userRes = await client.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (userRes.rows.length === 0) throw new Error("Foydalanuvchi topilmadi");
    const user = userRes.rows[0];

    // Xaridorning ushbu tokendan joriy egaligini (holding) oldindan qulflab
    // olamiz - keyinroq avg_cost hisoblashda ham shu qatordan foydalanamiz.
    const existingHolding = await client.query(
      "SELECT amount, avg_cost FROM holdings WHERE user_id = $1 AND token_id = $2 FOR UPDATE",
      [userId, tokenId]
    );
    const existingAmount = existingHolding.rows.length > 0 ? Number(existingHolding.rows[0].amount) : 0;

    // Egalik chegarasi: yaratuvchi uchun 25%, boshqa foydalanuvchilar uchun 10%
    const isCreator = Number(token.owner_id) === userId;
    const holdingLimitPct = isCreator ? CREATOR_MAX_HOLDING_PCT : USER_MAX_HOLDING_PCT;
    const maxAllowedAmount = Number(token.max_supply) * holdingLimitPct;
    if (existingAmount + amount > maxAllowedAmount + 1e-9) {
      const limitLabel = isCreator ? "25%" : "10%";
      throw new Error(
        `Bu tokendan ${limitLabel} dan ortiq (maks. ${maxAllowedAmount.toFixed(4)} ta) egalik qilib bo'lmaydi`
      );
    }

    // token.current_price - ekranda foydalanuvchi ko'rib turgan aynan shu
    // narx (avtomatik tebranish bilan yangilangan). Savdo shu narxdan
    // boshlanishi uchun calculateBuyCost'ga uzatamiz (bug tuzatildi).
    const { totalCost, newSupply, newPrice } = calculateBuyCost(
      Number(token.base_price),
      Number(token.circulating_supply),
      Number(token.max_supply),
      Number(token.curve_k),
      amount,
      Number(token.current_price)
    );

    // Komissiya: 0.25% - shundan 0.1% yaratuvchiga, 0.15% muzlatilgan fondga
    const commission = totalCost * TOTAL_COMMISSION_PCT;
    const creatorCommission = totalCost * CREATOR_COMMISSION_SHARE;
    const frozenCommission = totalCost * FROZEN_COMMISSION_SHARE;
    const totalCharge = totalCost + commission;

    if (Number(user.nex_trade_balance) < totalCharge) {
      throw new Error("Balansda yetarli Nex Trade yo'q");
    }

    await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance - $1 WHERE id = $2",
      [totalCharge, userId]
    );

    await client.query(
      "UPDATE tokens SET circulating_supply = $1, current_price = $2 WHERE id = $3",
      [newSupply, newPrice, tokenId]
    );

    // Komissiyaning 0.1% ulushi token yaratuvchisiga o'tadi - lekin balansga
    // DARHOL emas, "kutilayotgan bonus" jamg'armasiga qo'shiladi (haftada
    // 1 marta Profil > Bonuslar bo'limidan yechib olinadi).
    let creatorTelegramId: number | null = null;
    if (creatorCommission > 0) {
      await addCreatorBonus(client, token.owner_id, creatorCommission);
      const creatorRes = await client.query(
        "SELECT telegram_id FROM users WHERE id = $1",
        [token.owner_id]
      );
      creatorTelegramId = creatorRes.rows[0]?.telegram_id ?? null;
    }

    // Komissiyaning 0.15% ulushi muzlatilgan fondga qo'shiladi
    await addFrozenAmount(client, tokenId, frozenCommission);

    // O'rtacha xarid narxini (avg_cost) hisoblaymiz - portfelda foyda/zarar
    // foizini ko'rsatish uchun kerak. Yangi va eski xaridlar og'irlik bo'yicha o'rtachalanadi.
    // (Komissiya avg_cost ga kiritilmaydi - u faqat bonding curve narxiga asoslanadi.)
    const pricePerUnit = totalCost / amount;
    let newAvgCost = pricePerUnit;
    if (existingHolding.rows.length > 0) {
      const oldAmount = existingAmount;
      const oldAvgCost = Number(existingHolding.rows[0].avg_cost);
      const totalAmount = oldAmount + amount;
      newAvgCost = totalAmount > 0
        ? (oldAmount * oldAvgCost + amount * pricePerUnit) / totalAmount
        : pricePerUnit;
    }

    await client.query(
      `INSERT INTO holdings (user_id, token_id, amount, avg_cost)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, token_id) DO UPDATE SET amount = holdings.amount + $3, avg_cost = $4`,
      [userId, tokenId, amount, newAvgCost]
    );

    await client.query(
      `INSERT INTO transactions (user_id, token_id, type, amount, price, total_cost, commission)
       VALUES ($1, $2, 'buy', $3, $4, $5, $6)`,
      [userId, tokenId, amount, newPrice, totalCost, commission]
    );

    await client.query("COMMIT");

    // Tranzaksiya muvaffaqiyatli yakunlangandan keyingina yaratuvchiga xabar
    // yuboramiz - shu bilan ROLLBACK bo'lgan savdolar uchun noto'g'ri xabar
    // ketmaydi. sendMessage tarmoq chaqiruvi tranzaksiyani ushlab turmasligi kerak.
    if (creatorTelegramId && creatorCommission > 0) {
      notifyCreatorCommission(creatorTelegramId, token.name, token.symbol, creatorCommission, "buy");
    }

    return { totalCost, commission, totalCharge, newPrice, newSupply };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function sellToken(userId: number, tokenId: number, amount: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tokenRes = await client.query(
      "SELECT * FROM tokens WHERE id = $1 FOR UPDATE",
      [tokenId]
    );
    if (tokenRes.rows.length === 0) throw new Error("Token topilmadi");
    const token = tokenRes.rows[0];

    const holdingRes = await client.query(
      "SELECT * FROM holdings WHERE user_id = $1 AND token_id = $2 FOR UPDATE",
      [userId, tokenId]
    );
    const holding = holdingRes.rows[0];
    if (!holding || Number(holding.amount) < amount) {
      throw new Error("Sotish uchun yetarli token yo'q");
    }

    const { totalReturn, newSupply, newPrice } = calculateSellReturn(
      Number(token.base_price),
      Number(token.circulating_supply),
      Number(token.max_supply),
      Number(token.curve_k),
      amount,
      Number(token.current_price)
    );

    // Komissiya: 0.25% - shundan 0.1% yaratuvchiga, 0.15% muzlatilgan fondga.
    // Sotuvchiga esa komissiya ushlab qolingandan keyingi sof summa tushadi.
    const commission = totalReturn * TOTAL_COMMISSION_PCT;
    const creatorCommission = totalReturn * CREATOR_COMMISSION_SHARE;
    const frozenCommission = totalReturn * FROZEN_COMMISSION_SHARE;
    const netReturn = totalReturn - commission;

    // Sotishda o'rtacha xarid narxi o'zgarmaydi (faqat miqdor kamayadi).
    // Agar barcha token sotilsa, keyingi xariddan yangi hisob boshlanishi uchun avg_cost ni 0 ga tushiramiz.
    const remaining = Number(holding.amount) - amount;
    await client.query(
      "UPDATE holdings SET amount = $1::numeric, avg_cost = CASE WHEN $1::numeric <= 0 THEN 0 ELSE avg_cost END WHERE user_id = $2 AND token_id = $3",
      [remaining, userId, tokenId]
    );

    await client.query(
      "UPDATE tokens SET circulating_supply = $1, current_price = $2 WHERE id = $3",
      [newSupply, newPrice, tokenId]
    );

    await client.query(
      "UPDATE users SET nex_trade_balance = nex_trade_balance + $1 WHERE id = $2",
      [netReturn, userId]
    );

    // Komissiyaning 0.1% ulushi token yaratuvchisiga o'tadi - balansga
    // DARHOL emas, "kutilayotgan bonus" jamg'armasiga (haftalik yechib olish).
    let creatorTelegramId: number | null = null;
    if (creatorCommission > 0) {
      await addCreatorBonus(client, token.owner_id, creatorCommission);
      const creatorRes = await client.query(
        "SELECT telegram_id FROM users WHERE id = $1",
        [token.owner_id]
      );
      creatorTelegramId = creatorRes.rows[0]?.telegram_id ?? null;
    }

    // Komissiyaning 0.15% ulushi muzlatilgan fondga qo'shiladi
    await addFrozenAmount(client, tokenId, frozenCommission);

    await client.query(
      `INSERT INTO transactions (user_id, token_id, type, amount, price, total_cost, commission)
       VALUES ($1, $2, 'sell', $3, $4, $5, $6)`,
      [userId, tokenId, amount, newPrice, totalReturn, commission]
    );

    await client.query("COMMIT");

    // Tranzaksiya muvaffaqiyatli yakunlangandan keyingina yaratuvchiga xabar
    // yuboramiz - shu bilan ROLLBACK bo'lgan savdolar uchun noto'g'ri xabar
    // ketmaydi. sendMessage tarmoq chaqiruvi tranzaksiyani ushlab turmasligi kerak.
    if (creatorTelegramId && creatorCommission > 0) {
      notifyCreatorCommission(creatorTelegramId, token.name, token.symbol, creatorCommission, "sell");
    }

    return { totalReturn: netReturn, grossReturn: totalReturn, commission, newPrice, newSupply };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
