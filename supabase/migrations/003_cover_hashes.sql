CREATE TABLE IF NOT EXISTS cover_hashes (
  cover_url TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  computed_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE cover_hashes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_all" ON cover_hashes FOR ALL USING (true) WITH CHECK (true);
NOTIFY pgrst, 'reload schema';
