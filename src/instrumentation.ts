const SCHEMA = `
  CREATE TABLE IF NOT EXISTS carts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id UUID REFERENCES carts(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    author TEXT,
    work_id TEXT,
    isbn_preferred TEXT,
    cover_url TEXT,
    format TEXT DEFAULT 'any',
    condition_min TEXT DEFAULT 'like_new',
    flexible BOOLEAN DEFAULT false,
    quantity INT DEFAULT 1,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS price_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    isbn TEXT NOT NULL,
    listings JSONB NOT NULL,
    cached_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS price_cache_isbn_idx ON price_cache(isbn);
  CREATE INDEX IF NOT EXISTS cart_items_cart_id_idx ON cart_items(cart_id);

  ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE price_cache ENABLE ROW LEVEL SECURITY;

  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'carts' AND policyname = 'public_all') THEN
      CREATE POLICY "public_all" ON carts FOR ALL USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cart_items' AND policyname = 'public_all') THEN
      CREATE POLICY "public_all" ON cart_items FOR ALL USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'price_cache' AND policyname = 'public_all') THEN
      CREATE POLICY "public_all" ON price_cache FOR ALL USING (true) WITH CHECK (true);
    END IF;
  END $$;
`

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN

  if (!supabaseUrl || !accessToken) return

  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1]
  if (!projectRef) return

  try {
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: SCHEMA }),
      }
    )
    if (!res.ok) {
      const err = await res.text()
      console.error('[bookbundle] Schema migration failed:', err)
    } else {
      console.log('[bookbundle] Schema migration OK')
    }
  } catch (err) {
    console.error('[bookbundle] Schema migration error:', err)
  }
}
