/**
 * press — serve a generated PDF to the review UI.
 *
 * Two sources, as everywhere in press: the file on V's disk, or the object in
 * the `press` Storage bucket when deployed. Storage is private, so the remote
 * case redirects to a short-lived signed URL rather than proxying six megabytes
 * of PDF through a serverless function.
 *
 * The path comes from the URL, so `resolveIssueFile` allowlists the two files
 * we generate and refuses anything that escapes `.press/`. Disabled in
 * production unless PRESS_UI_ENABLED=1, because these are V's saved articles.
 */

import { readFile } from 'node:fs/promises'
import { NextResponse } from 'next/server'
import { pressUiEnabled, resolveIssueFile } from '@/lib/press/local'
import { remoteIssueFileUrl } from '@/lib/press/remote'
import { reviewSource } from '@/lib/press/review'
import { ownerDb } from '../../../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ issue: string; file: string }> },
) {
  if (!pressUiEnabled()) return new NextResponse('not found', { status: 404 })

  const { issue, file } = await context.params
  if (!/^\d+$/.test(issue)) return new NextResponse('not found', { status: 404 })
  if (file !== 'interior.pdf' && file !== 'cover.pdf') {
    return new NextResponse('not found', { status: 404 })
  }

  if (reviewSource() === 'supabase') {
    const url = await remoteIssueFileUrl(Number.parseInt(issue, 10), file, await ownerDb())
    if (!url) return new NextResponse('not found', { status: 404 })
    // The signed URL is the response; it expires on its own.
    return NextResponse.redirect(url, { status: 307 })
  }

  const resolved = resolveIssueFile(issue, file)
  if (!resolved) return new NextResponse('not found', { status: 404 })

  const bytes = await readFile(resolved)
  const download = new URL(request.url).searchParams.has('download')

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/pdf',
      // inline so the browser previews it; download when explicitly asked.
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="press-issue-${issue}-${file}"`,
      'cache-control': 'no-store',
    },
  })
}
