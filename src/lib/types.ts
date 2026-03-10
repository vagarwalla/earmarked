export type Format = 'hardcover' | 'paperback' | 'any'
export type Condition = 'new' | 'like_new' | 'very_good' | 'good'

export interface Cart {
  id: string
  slug: string
  name: string
  created_at: string
  item_count?: number
  default_conditions: Condition[]
  default_format: Format
  default_max_price: number | null
}

export interface CartItem {
  id: string
  cart_id: string
  title: string
  author: string | null
  work_id: string | null
  isbn_preferred: string | null
  cover_url: string | null
  format: Format
  conditions: Condition[]
  max_price: number | null
  flexible: boolean
  quantity: number
  sort_order: number
  created_at: string
}

export interface BookSearchResult {
  title: string
  author: string
  work_id: string // Open Library work ID e.g. "/works/OL45804W"
  cover_url: string | null
  first_publish_year: number | null
  series: string | null
}

export interface Edition {
  isbn: string
  title: string
  publisher: string | null
  publish_year: number | null
  format: Format
  cover_url: string | null
  cover_id: number | null
  edition_name: string | null  // e.g. "Penguin Classics", "Revised Edition"
  pages: number | null
}

export interface Listing {
  listing_id: string
  seller_id: string
  seller_name: string
  price: number
  shipping_base: number
  shipping_per_additional: number
  condition: string
  condition_normalized: Condition
  url: string
  isbn: string
}

export interface SellerGroup {
  seller_id: string
  seller_name: string
  assignments: Array<{
    item: CartItem
    listing: Listing
    quantity: number
    subtotal: number
  }>
  books_subtotal: number
  shipping: number
  group_total: number
}

export interface OptimizationResult {
  groups: SellerGroup[]
  grand_total: number
  naive_total: number
  savings: number
}

export interface SourceInfo {
  name: string
  search_url: string  // link users can click to browse manually
  found: number       // number of listings found (0 = no results)
}

export interface PriceResponse {
  listings: Record<string, Listing[]>
  sources: SourceInfo[]
}
