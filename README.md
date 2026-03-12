# Earmarked

Find cheap used books and minimize shipping costs. Build a list of books, pick your preferred editions, and Earmarked finds the cheapest way to buy them all by grouping sellers.

## What it does

- Search for books by title or author (powered by Open Library)
- Pick which edition and cover you want for each book
- Fetches live listings from ThriftBooks, Better World Books, and AbeBooks
- Optimizes across sellers to minimize the number of orders (and shipping costs)
- Supports per-book filters: condition, format, max price, signed/first edition/dust jacket

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Requires a Supabase project — copy `.env.example` to `.env.local` and fill in your Supabase URL and anon key.

## Stack

- Next.js (App Router)
- Supabase (Postgres)
- Tailwind CSS + shadcn/ui
- Open Library API (book search + editions)
- BookFinder scraper (listings from ThriftBooks, BWB, AbeBooks)

## Naming conventions

The user-facing term for a list of books is **"stack"** (not "cart"). This rename happened in March 2026.

- UI copy, URLs (`/stack/[slug]`), and button labels all say "stack"
- Internal code (TypeScript types, variable names, API routes) still uses `cart`/`Cart` — this is intentional to avoid a massive refactor. Don't change the API routes (`/api/cart/...`) or the DB schema.
- If you add new user-facing copy, use "stack"

## Project structure

```
src/
  app/
    page.tsx              # Homepage — lists all stacks
    stack/[slug]/         # Individual stack page
    api/
      cart/               # REST API for stacks (named "cart" internally)
      prices/             # Fetches live listings
      optimize/           # Seller grouping optimizer
      editions/           # Book editions from Open Library
  components/
    CartItemCard.tsx      # Per-book item in a stack
    CartDefaults.tsx      # Default filters for a stack
    OptimizationPanel.tsx # Right panel: find deals + results
    BookSearch.tsx        # Book search input
    EditionPicker.tsx     # Choose edition for a book
  lib/
    optimizer/            # Seller grouping algorithms
    relaxation.ts         # Suggests loosening filters when no listings found
    types.ts              # Shared TypeScript types
```
