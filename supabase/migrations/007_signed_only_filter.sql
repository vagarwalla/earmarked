-- Add collectible attribute filters to cart_items
-- signed_only: only show signed/autographed copies (AbeBooks: data-test-id="listing-signed")
-- first_edition_only: only show first edition copies (AbeBooks: data-test-id="listing-firstedition")
-- dust_jacket_only: only show copies with dust jacket (AbeBooks: "With dust jacket" in description)
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS signed_only BOOLEAN DEFAULT false;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS first_edition_only BOOLEAN DEFAULT false;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS dust_jacket_only BOOLEAN DEFAULT false;

-- Add corresponding defaults to carts table
ALTER TABLE carts ADD COLUMN IF NOT EXISTS default_signed_only BOOLEAN DEFAULT false;
ALTER TABLE carts ADD COLUMN IF NOT EXISTS default_first_edition_only BOOLEAN DEFAULT false;
ALTER TABLE carts ADD COLUMN IF NOT EXISTS default_dust_jacket_only BOOLEAN DEFAULT false;

-- Add isbns_candidates column if not already present (referenced in app but missing from schema)
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS isbns_candidates TEXT[];
