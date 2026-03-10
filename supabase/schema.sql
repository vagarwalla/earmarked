CREATE TABLE carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id UUID REFERENCES carts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT,
  work_id TEXT,
  isbn_preferred TEXT,
  cover_url TEXT,
  format TEXT DEFAULT 'any', -- 'hardcover' | 'paperback' | 'any'
  condition_min TEXT DEFAULT 'like_new', -- 'new' | 'like_new' | 'very_good' | 'good'
  flexible BOOLEAN DEFAULT false,
  quantity INT DEFAULT 1,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE price_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  isbn TEXT NOT NULL,
  listings JSONB NOT NULL,
  cached_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX ON price_cache(isbn);
CREATE INDEX ON cart_items(cart_id);

-- Enable RLS (required for publishable key)
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_cache ENABLE ROW LEVEL SECURITY;

-- Allow full public access (this is a personal/shared tool with no auth)
CREATE POLICY "public_all" ON carts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public_all" ON cart_items FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public_all" ON price_cache FOR ALL USING (true) WITH CHECK (true);
