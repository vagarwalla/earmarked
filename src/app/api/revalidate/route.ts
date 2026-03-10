import { revalidateTag, revalidatePath } from 'next/cache'
import { NextResponse } from 'next/server'

export async function POST() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(revalidateTag as any)('editions')
  // Bust all fetch() Data Cache entries across every route
  revalidatePath('/', 'layout')
  return NextResponse.json({ revalidated: true })
}
