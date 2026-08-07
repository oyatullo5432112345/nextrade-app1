# NexTrade — Telegram Mini App

Foydalanuvchilar o'z virtual tokenlarini yaratib, boshqa foydalanuvchilar bilan
almashadigan platforma. Real pul ishlatilmaydi — barcha savdo "Nex Trade" deb
ataladigan asosiy virtual token orqali amalga oshiriladi.

## Asosiy qoidalar

- Har bir yangi foydalanuvchi boshida **100 ta Nex Trade** token oladi
- Foydalanuvchi o'z tokenini yaratganda maksimal **10 000 ta** chiqarishi mumkin
- Token narxi **0.0001 – 0.01 UZS** oralig'ida, bonding curve formulasi orqali
  avtomatik hisoblanadi (foydalanuvchi qo'lda narx qo'ymaydi)
- Narx faqat savdo faoliyatiga (sotib olish/sotish) bog'liq — kim ko'p sotib
  olsa, narx oshadi; kim ko'p sotsa, narx tushadi

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

## Keyingi qadamlar

- Mini App frontend (React + Telegram WebApp SDK) — hali qo'shilmagan
- Admin panel va monitoring
- Loyiha kattalashganda: litsenziyalash va Telegram bilan rasmiy hamkorlik
