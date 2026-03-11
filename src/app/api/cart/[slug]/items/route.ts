import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// Columns added in migration_v2 — not yet in DB on older deployments
const NEW_COLUMNS = ['conditions', 'max_price']

function isMissingColumnError(msg: string) {
  return NEW_COLUMNS.some((col) => msg.includes(`'${col}' column`))
}

// Map old condition_min (single value) → new conditions (array)
function normalizeItem(item: Record<string, unknown>) {
  if (!item.conditions && item.condition_min) {
    const min = item.condition_min as string
    const map: Record<string, string[]> = {
      new: ['new'],
      like_new: ['fine', 'new'],
      fine: ['fine', 'new'],
      very_good: ['good', 'fine', 'new'],
      good: ['good', 'fine', 'new'],
      acceptable: ['fair', 'good', 'fine', 'new'],
      fair: ['fair', 'good', 'fine', 'new'],
    }
    item.conditions = map[min] ?? ['new', 'fine', 'good']
  }
  if (!item.conditions) item.conditions = ['new', 'fine', 'good']
  if (item.max_price === undefined) item.max_price = null
  if (item.isbns_candidates === undefined) item.isbns_candidates = null
  if (item.signed_only === undefined || item.signed_only === null) item.signed_only = false
  if (item.first_edition_only === undefined || item.first_edition_only === null) item.first_edition_only = false
  if (item.dust_jacket_only === undefined || item.dust_jacket_only === null) item.dust_jacket_only = false
  return item
}

async function getCart(slug: string) {
  const { data } = await supabase.from('carts').select('id').eq('slug', slug).single()
  return data
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const cart = await getCart(slug)
    if (!cart) return NextResponse.json({ error: 'Cart not found' }, { status: 404 })

    const { data, error } = await supabase
      .from('cart_items')
      .select('*')
      .eq('cart_id', cart.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json((data || []).map(normalizeItem))
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const cart = await getCart(slug)
    if (!cart) return NextResponse.json({ error: 'Cart not found' }, { status: 404 })

    const body = await req.json()

    let result = await supabase
      .from('cart_items')
      .insert({ ...body, cart_id: cart.id })
      .select()
      .single()

    // If new columns don't exist yet (pre-migration), retry without them
    if (result.error && isMissingColumnError(result.error.message)) {
      const { conditions, max_price, ...legacyBody } = body
      result = await supabase
        .from('cart_items')
        .insert({ ...legacyBody, cart_id: cart.id })
        .select()
        .single()
      if (!result.error && result.data) {
        return NextResponse.json(
          normalizeItem({ ...result.data, conditions: conditions ?? ['new', 'fine', 'good'], max_price: max_price ?? null }),
          { status: 201 }
        )
      }
    }

    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 })
    return NextResponse.json(normalizeItem(result.data as Record<string, unknown>), { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
