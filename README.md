# NexTrade — Telegram Mini App

Foydalanuvchilar o'z virtual tokenlarini yaratib, boshqa foydalanuvchilar bilan
almashadigan platforma. Real pul ishlatilmaydi — barcha savdo "Nex Trade" deb
ataladigan asosiy virtual token orqali amalga oshiriladi.

## Asosiy qoidalar

- Har bir yangi foydalanuvchi boshida **100 ta Nex Trade** token oladi
- Foydalanuvchi o'z tokenini yaratganda maksimal **10 000 ta** chiqarishi mumkin
- **v8: Order book (haqiqiy birja).** Narxni formula emas, foydalanuvchilarning
  buyurtmalari belgilaydi. Joriy narx = oxirgi kelishuv narxi.
  - *Bozor narxida* (market): kitobdagi eng yaxshi narxlardan darhol bajariladi,
    2% narx himoyasi bilan.
  - *O'z narximda* (limit): darhol mos keladigan qismi bajariladi, qolgani
    kitobda kutadi. Xarid buyurtmasida Nex, sotuvda tokenlar muzlatiladi;
    bekor qilinsa qaytadi.
  - Navbat: eng yaxshi narx, teng bo'lsa - kim oldin qo'ygan (price-time).
  - Token yaratilganda butun ta'minot platformaning 20 pog'onali sotuv
    "zinapoyasi" (IPO) sifatida kitobga qo'yiladi; tushum yaratuvchiga.
  - Komissiya: har tomondan 0.25% (0.1% yaratuvchiga, 0.15% muzlatilgan fondga).
  - "Kuchaytirish" = buyback & burn: egasi Nex bilan sotuvlarni sotib oladi
    va tokenlarni yoqadi (ta'minot kamayadi).
  - Eski tokenlar birinchi ishga tushishda avtomatik ko'chiriladi: egalardagi
    tokenlar joyida qoladi, qolgan ta'minot joriy narxdan boshlab zinapoyaga qo'yiladi.

- **v9:** pastki menyu (Asosiy / Bozor / Yaratish / Vazifalar / Profil);
  Telegram Stars orqali Nex (har kuni -50% va -20% chegirmalar, birinchi xarid -50%);
  real TON va NOT (CoinGecko + OKX narxi, 3% dan ortiq farq bo'lsa savdo to'xtaydi);
  Nex narxi ±5% oralig'ida nazorat qilinadi; har foydalanuvchiga 3 tagacha token;
  kafolat (muzlatilgan Nex) bilan yuqoriroq boshlang'ich narx; rasmni telefondan yuklash;
  kuniga bir marta g'ildirak o'zi ochiladi; yangi o'yinchi: +100 Nex -> g'ildirak -> token yaratish.

- **v10:** bepul to'ldirish o'chirildi ("To'ldirish" = Stars do'koni); chiqarish oynasi
  (Stars / USD / TON / NOT kursi bilan, WITHDRAW_OPEN_DATE gacha yopiq); 🔮 bashorat o'yini (x1.9);
  🏁 haftalik turnir (hamma 1000 bilan teng); 📣 narx signallari; 👥 do'stlar reytingi;
  token tavsifi va kanal havolasi; yaratuvchi statistikasi; 🛡 kafolatlangan tokenlar trendda yuqorida;
  admin: Stars daromadi va shubhali akkauntlar; Render keep-alive.

- **v11: 🤖 Nex AI** - bozor tahlilchisi: har bir tokenni trend, RSI, buyurtmalar kitobi,
  kafolat (pol narx), 24 soatlik o'zgarish va faollik bo'yicha baholaydi; "Kuchli olish / Olish /
  Kutish / Olmang" signali, ishonch %, balansga mos summa (bir tugma bilan sotib olish), maqsad va
  himoya narxi; portfel bo'yicha "foydani oling" maslahati; tavsiyalar aniqligi 24 soatdan keyin
  o'lchanadi. Botda /ai buyrug'i. Tashqi API va pul talab qilmaydi.

## v13: token yaratish, guruhda belgilash, zaxira
- Token miqdori **10 dan 1 000 000 gacha** (tugmalar: 1 000 / 10 000 / 100 000 / 1 000 000). Egalik chegarasi: oddiy egasi **20%**, yaratuvchi **30%**.
- Yaratish ekranida "Tokeningiz qisqacha" kartasi: narx, bozor qiymati, kim qancha ega bo'la oladi.
- Kuniga **25 ta** yangi token joyi (`TOKEN_DAILY_SLOTS`). Ekranda va guruh reklamasida haqiqiy qolgan joylar soni ko'rinadi.
- Guruh reklamasi har safar guruhning bitta a'zosini belgilaydi ("👤 Ali, siz uchun!") - avval hali o'ynamaganlar, bir odam 24 soatda bir marta. Bot a'zolarni ko'rishi uchun guruhda **admin** bo'lishi (yoki BotFather -> /setprivacy -> Disable) kerak.
- **Zaxira**: har 6 soatda butun baza Telegram'ga yuboriladi va **qadab qo'yiladi**. Baza o'chib, yangi bo'sh baza ulansa - server ishga tushganda qadalgan zaxiradan **avtomatik tiklaydi**.

## v12: likvidlik va tezkor real narx
- **🤖 MM (likvidlik buyurtmalari)**: har daqiqada har bir faol foydalanuvchi tokeni uchun platforma narxdan -3%, -6%, -10% pastda xarid buyurtmalari qo'yadi (va o'zi olgan tokenlarni +3%, +6% yuqorida sotadi). Faqat buyurtmalar - soxta savdo yoki soxta hajm yo'q. Kitobda "🤖 MM" belgisi bilan ko'rinadi.
- Himoya: narx = min(joriy, 24 soatlik VWAP); token kamida 3 soatlik va 2 egali bo'lishi kerak; har token uchun 24 soatda 200 Nex, umumiy 3000 Nex limit (`MM_*` sozlamalari, `.env.example`).
- **TON/NOT**: narx 4 manbadan (CoinGecko, OKX, Binance, Bybit) har 20 soniyada olinadi, mediana bo'yicha; platforma buyurtmalari har 15 soniyada yangilanadi.

## O'rnatish

```bash
npm install
cp .env.example .env   # keyin .env faylini o'z ma'lumotlaringiz bilan to'ldiring
npm run migrate        # bazada jadvallarni yaratish
npm run dev             # ishlab chiqish rejimida ishga tushirish
```

## Loyiha strukturasi

```
src/
  db/            baza ulanishi va SQL sxema
  services/      biznes logika (narx, token, savdo, foydalanuvchi)
  routes/        Mini App uchun REST API
  bot/           Telegram bot (/start buyrug'i, Mini App tugmasi)
  index.ts       server va botni ishga tushirish
```

## API endpointlari

| Metod | Yo'l | Tavsif |
|---|---|---|
| POST | /api/user/init | Foydalanuvchini ro'yxatdan o'tkazish/olish |
| GET | /api/user/:userId/holdings | Foydalanuvchi portfeli |
| POST | /api/tokens | Yangi token yaratish |
| GET | /api/tokens | Top tokenlar ro'yxati |
| GET | /api/tokens/:id | Bitta token ma'lumoti |
| POST | /api/trade/buy | Token sotib olish |
| POST | /api/trade/sell | Token sotish |

## Xavfsizlik (v2)

- Foydalanuvchi **faqat** Telegram imzolagan `initData` orqali aniqlanadi
  (`X-Telegram-Init-Data` sarlavhasi, `src/middleware/auth.ts`). Body'dagi
  `user_id` e'tiborga olinmaydi.
- Bot Render'da avtomatik **webhook** rejimida ishlaydi (`RENDER_EXTERNAL_URL`),
  shuning uchun server uxlab qolsa ham Telegram xabari uni uyg'otadi.
- Mini App shu serverning o'zidan ham beriladi: `https://<nom>.onrender.com/`

## Keyingi qadamlar

- Mini App frontend (React + Telegram WebApp SDK) — hali qo'shilmagan
- Admin panel va monitoring
- Loyiha kattalashganda: litsenziyalash va Telegram bilan rasmiy hamkorlik

## Bot buyruqlari

**Hamma uchun:** /start, /kunlik, /hamyon, /liga, /top, /narx UZB, /guruhlar, /referral
**Guruhda:** /qoshil (guruh jamoasiga qo'shilish), guruh adminlari uchun /reklama_vaqt 30, /reklama_stop, /reklama_start
**Inline:** istalgan chatda `@NexTradexbot UZB` (BotFather'da /setinline yoqilgan bo'lishi kerak)
**Admin:** /statistika, /xabar, /giveaway 50 100, /ban, /unban, /tokenochir, /izohochir,
/reklama_matn, /reklama_rasm, /reklama_test, /reklamalar, /reklama_hozir, /zaxira, /tiklash
