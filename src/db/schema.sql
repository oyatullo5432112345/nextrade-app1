-- NexTrade platformasi uchun baza sxemasi

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    nex_trade_balance NUMERIC(20, 4) NOT NULL DEFAULT 100.0000,  -- boshlang'ich 100 ta Nex Trade
    referred_by INTEGER REFERENCES users(id),  -- kim taklif qilgani (referal)
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tokens (
    id SERIAL PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    name VARCHAR(64) NOT NULL,
    symbol VARCHAR(16) NOT NULL UNIQUE,
    max_supply NUMERIC(20, 4) NOT NULL CHECK (max_supply > 0 AND max_supply <= 10000),
    circulating_supply NUMERIC(20, 4) NOT NULL DEFAULT 0,
    base_price NUMERIC(10, 8) NOT NULL CHECK (base_price >= 0.0001 AND base_price <= 0.01),
    current_price NUMERIC(10, 8) NOT NULL,
    curve_k NUMERIC(5, 2) NOT NULL DEFAULT 1.5,  -- bonding curve tezligi
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS holdings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    amount NUMERIC(20, 4) NOT NULL DEFAULT 0 CHECK (amount >= 0),
    UNIQUE(user_id, token_id)
);

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    type VARCHAR(4) NOT NULL CHECK (type IN ('buy', 'sell')),
    amount NUMERIC(20, 4) NOT NULL CHECK (amount > 0),
    price NUMERIC(10, 8) NOT NULL,
    total_cost NUMERIC(20, 4) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Savdodan mustaqil, har 10 soniyada qo'shiladigan avtomatik narx tebranishlari.
-- Grafikda savdo tarixi bilan birga ko'rsatiladi.
CREATE TABLE IF NOT EXISTS price_ticks (
    id SERIAL PRIMARY KEY,
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    price NUMERIC(20, 8) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_holdings_token ON holdings(token_id);
CREATE INDEX IF NOT EXISTS idx_transactions_token ON transactions(token_id);
CREATE INDEX IF NOT EXISTS idx_tokens_owner ON tokens(owner_id);
CREATE INDEX IF NOT EXISTS idx_price_ticks_token ON price_ticks(token_id);

-- Narxga endi yuqori chegara qo'yilmagani uchun ustunlar kengligini oshiramiz
-- (base_price hamon 0.0001-0.01 oralig'ida cheklangan, faqat current_price
-- va tranzaksiya narxi endi erkin o'sishi mumkin).
ALTER TABLE tokens ALTER COLUMN current_price TYPE NUMERIC(20, 8);
ALTER TABLE transactions ALTER COLUMN price TYPE NUMERIC(20, 8);

-- Kunlik bonus oxirgi marta qachon olinganini kuzatish uchun
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_bonus_at TIMESTAMP;

-- Portfelda foyda/zarar foizini hisoblash uchun o'rtacha xarid narxi
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS avg_cost NUMERIC(20, 8) NOT NULL DEFAULT 0;

-- Sevimli tokenlar
CREATE TABLE IF NOT EXISTS favorites (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);

-- Foydalanuvchi tanlagan tokenlar uchun narx bildirishnomalari
CREATE TABLE IF NOT EXISTS token_alerts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    threshold_pct NUMERIC(5, 2) NOT NULL DEFAULT 5,
    last_notified_price NUMERIC(20, 8),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_token_alerts_token ON token_alerts(token_id);

-- Savdo komissiyasi: har bir sotib olish/sotishda 0.25% komissiya olinadi.
-- total_cost ustuni bonding curve bo'yicha xarajat/tushumni saqlaydi (o'zgarmaydi),
-- commission esa shundan ALOHIDA ushlab qolingan 0.25% miqdorni saqlaydi
-- (buni 0.1% qismi token yaratuvchisiga, 0.15% qismi muzlatilgan fondga boradi).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS commission NUMERIC(20, 8) NOT NULL DEFAULT 0;

-- Har bir savdo komissiyasining 0.15% qismi shu yerga - tokenga bog'liq
-- "muzlatilgan mablag'" fondiga - yig'ilib boriladi. Bu fond faqat ADMIN
-- tomonidan botni/mini-appni rivojlantirish maqsadida yechib olinishi mumkin
-- (qarang: src/services/frozenService.ts).
CREATE TABLE IF NOT EXISTS frozen_balances (
    token_id INTEGER PRIMARY KEY REFERENCES tokens(id),
    amount NUMERIC(20, 8) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Admin tomonidan muzlatilgan fonddan yechib olingan mablag'lar tarixi
-- (audit va shaffoflik uchun saqlanadi).
CREATE TABLE IF NOT EXISTS frozen_withdrawals (
    id SERIAL PRIMARY KEY,
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    amount NUMERIC(20, 8) NOT NULL,
    admin_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_frozen_withdrawals_token ON frozen_withdrawals(token_id);

-- Nex Trade (asosiy valyuta) ning real dunyo (UZS) qiymati. Bitta qatorli
-- jadval - hozirgi narxni saqlaydi. Boshlang'ich qiymat 0.9957 UZS.
CREATE TABLE IF NOT EXISTS nex_trade_price (
    id INTEGER PRIMARY KEY DEFAULT 1,
    price NUMERIC(20, 8) NOT NULL DEFAULT 0.9957,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK (id = 1)
);
INSERT INTO nex_trade_price (id, price)
VALUES (1, 0.9957)
ON CONFLICT (id) DO NOTHING;

-- Nex Trade narxining tarixi - grafik chizish uchun (tokenlardagi price_ticks
-- kabi, lekin bu safar butun platformaning asosiy valyutasi uchun).
CREATE TABLE IF NOT EXISTS nex_trade_price_ticks (
    id SERIAL PRIMARY KEY,
    price NUMERIC(20, 8) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nex_trade_price_ticks_time ON nex_trade_price_ticks(created_at);

-- Foydalanuvchi Nex Trade balansi har o'zgarganda shu yerga "surat" (snapshot)
-- sifatida yoziladi - Portfolio grafigini chizish uchun ishlatiladi.
CREATE TABLE IF NOT EXISTS balance_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    balance NUMERIC(20, 4) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_balance_history_user_time ON balance_history(user_id, created_at);

-- Token uchun rasm (logotip) - foydalanuvchi token yaratganda URL kiritadi.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Token egasi o'z Nex Trade'ini tokeniga "kiritib" (qaytarilmas tarzda)
-- narxini doimiy oshirishi mumkin - shu tarix shu yerda saqlanadi.
CREATE TABLE IF NOT EXISTS token_boosts (
    id SERIAL PRIMARY KEY,
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount NUMERIC(20, 4) NOT NULL,
    old_base_price NUMERIC(20, 8) NOT NULL,
    new_base_price NUMERIC(20, 8) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_boosts_token ON token_boosts(token_id);

-- MUHIM TUZATISH: base_price ustuni hali ham eski CHECK (<= 0.01) chegarasini
-- va tor NUMERIC(10,8) turini saqlab turgan edi. Shu sabab "kuchaytirish" (boost)
-- funksiyasi bazaga yozishda har doim xato berayotgan edi, chunki base_price
-- boost natijasida 0.01 dan oshib ketishi tabiiy holat. Endi bu chegara olib
-- tashlanadi va ustun current_price kabi keng turga o'tkaziladi.
ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_base_price_check;
ALTER TABLE tokens ALTER COLUMN base_price TYPE NUMERIC(20, 8);

-- PRO NISHON: bu real pulga aloqasi yo'q, faqat ichki Nex Trade sarflab
-- tokenni "tasdiqlangan/PRO" deb belgilash - reklama/nishon maqsadida.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS is_pro BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS pro_since TIMESTAMP;
