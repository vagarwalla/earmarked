import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// Columns added in migration_v2 that may not exist in older DB deployments
const NEW_COLUMNS = ['conditions', 'max_price']

function isMissingColumnError(msg: string) {
  return NEW_COLUMNS.some((col) => msg.includes(`'${col}' column`))
    || msg.includes('Cannot coerce the result to a single JSON object')
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ slug: string; itemId: string }> }) {
  try {
    const { itemId } = await params
    const body = await req.json()

    // Try the full update first (works after migration is applied)
    let result = await supabase
      .from('cart_items')
      .update(body)
      .eq('id', itemId)
      .select()
      .single()

    if (!result.error) {
      return NextResponse.json(result.data)
    }

    // Pre-migration fallback: strip new columns and retry with legacy ones
    if (isMissingColumnError(result.error.message)) {
      const { conditions, max_price, ...legacyBody } = body

      if (Object.keys(legacyBody).length > 0) {
        result = await supabase
          .from('cart_items')
          .update(legacyBody)
          .eq('id', itemId)
          .select()
          .single()
        if (!result.error && result.data) {
          return NextResponse.json({
            ...result.data,
            ...(conditions !== undefined && { conditions }),
            ...(max_price !== undefined && { max_price }),
          })
        }
      } else {
        // Only new columns in body — fetch current row and merge
        const { data } = await supabase
          .from('cart_items')
          .select('*')
          .eq('id', itemId)
          .single()
        return NextResponse.json({
          ...data,
          ...(conditions !== undefined && { conditions }),
          ...(max_price !== undefined && { max_price }),
        })
      }
    }

    return NextResponse.json({ error: result.error.message }, { status: 500 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ slug: string; itemId: string }> }) {
  try {
    const { itemId } = await params
    const { error } = await supabase.from('cart_items').delete().eq('id', itemId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
