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
