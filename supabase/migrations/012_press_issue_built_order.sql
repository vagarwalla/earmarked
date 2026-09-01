-- press: what the PDFs on file were actually built from.
--
-- Editing an issue and rendering it are deliberately separate: a hundred-page
-- render takes minutes, so edits land immediately and the PDF catches up when
-- someone asks for it. Between those two moments the stored interior and the
-- issue's contents disagree, and the review page has to say so rather than
-- print page numbers that belong to a running order that no longer exists.
--
-- Locally that comparison is against `meta.json`, written beside the PDFs at
-- build time. Postgres had no equivalent, so this is it: the item ids, in the
-- order the current interior_path/cover_path were rendered from.
--
-- NULL means never built. A row whose built_order differs from its items'
-- current order — in membership or in sequence — is stale.

ALTER TABLE press_issues
  ADD COLUMN IF NOT EXISTS built_order UUID[];

COMMENT ON COLUMN press_issues.built_order IS
  'press_items.id in the order the stored interior/cover were rendered from. NULL = never built. Differs from the live order = the PDFs are stale.';
