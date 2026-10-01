/**
 * AI Integration Service - Claude API
 * Xabarlarni tahlil qilish va AI javob berish uchun
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

export interface AIResponse {
  response: string;
  messageType: "question" | "statement" | "feedback";
  confidence: number;
}

/**
 * Claude AI orqali xabarni tahlil qilish va javob berish
 * @param messageText - Foydalanuvchining xabari
 * @param context - Qo'shimcha ma'lumot (username, userId va hokazo)
 * @returns AI javob, xabar turi va ishonch darajasi
 */
export async function analyzeMessageWithAI(
  messageText: string,
  context?: { username?: string | null }
): Promise<AIResponse> {
  try {
    const username = context?.username ? `@${context.username}` : "Foydalanuvchi";

    const message = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 500,
      system: `Sen NexTrade bot AI assistantisan. O'zbek tilida javob ber.

      NexTrade - bu platform bu yerda:
      - Foydalanuvchilar tokenlar yaratadilari
      - Tokenlarni sotadilari va sotib oladilari
      - Pul ishlashdilari
      - Turli loyihalarni boshqaradilari

      Quyidagilar bo'yicha savollarga yordamchi javob ber:
      - NexTrade qanday ishlaydi
      - Tokenlar qanday yaratiladi
      - Savdo qanday qilish kerak
      - Referral bonuslar
      - Ligi va mukofotlar

      Agarda siz xabar turi belgi bo'lsa (savol, bayonot, fikr) aniqlang.
      Javob qisqa, tushunarli va foydalanuvchiga foydali bo'lsin.`,
      messages: [
        {
          role: "user",
          content: `${username} shunga dedi: "${messageText}"

          Unga Uzbek tilida tez va aniq javob ber. Agar NexTrade bilan bog'liq bo'lmasa, odat javobini ber.`,
        },
      ],
    });

    const responseText =
      message.content[0].type === "text" ? message.content[0].text : "";

    // Xabar turini aniqlash
    let messageType: "question" | "statement" | "feedback" = "statement";
    if (
      messageText.includes("?") ||
      messageText.includes("qanday") ||
      messageText.includes("nima") ||
      messageText.includes("qandoq")
    ) {
      messageType = "question";
    } else if (
      messageText.includes("yomon") ||
      messageText.includes("yaxshi") ||
      messageText.includes("o'ylayman")
    ) {
      messageType = "feedback";
    }

    return {
      response: responseText,
      messageType,
      confidence: 0.95,
    };
  } catch (error) {
    console.error("❌ Claude AI xatosi:", error);
    throw error;
  }
}

/**
 * Offline xabari - API muammoli bo'lganda yuborish
 */
export function getOfflineMessage(): string {
  return (
    "🤖 Hozir Nex Trade AI assistant offline\n\n" +
    "⏳ Tez orada admin sizga javob beradi\n\n" +
    "Saboqni boshqarish uchun @NexTradeBot'dan foydalaning"
  );
}
