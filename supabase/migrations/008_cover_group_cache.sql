-- Cache for holistic AI cover grouping results.
-- Keyed by SHA-256 of the sorted cluster representative URLs.
-- Avoids re-running Claude on every EditionPicker open for the same set of covers.
CREATE TABLE IF NOT EXISTS cover_group_cache (
  cache_key   TEXT PRIMARY KEY,
  groups      JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE cover_group_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_all" ON cover_group_cache FOR ALL USING (true) WITH CHECK (true);
NOTIFY pgrst, 'reload schema';
