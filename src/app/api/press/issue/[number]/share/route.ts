/**
 * press — make an issue readable by anyone with the link, or stop.
 *
 *   POST { shared: true | false }  →  { visibility, url }
 *
 * The scoped client is the whole of the authorisation: the update matches by
 * id against a client that can only see this account's issues, so sharing
 * somebody else's is not refused, it simply matches nothing.
 *
 * Refuses an issue that has never been built. A shared draft would be a page
 * offering a PDF that does not exist, and the reader has no way to tell that
 * from a broken link.
 */

import { NextResponse } from 'next/server'
import { currentAccount } from '@/lib/press/accounts'
import { pressDb } from '@/lib/press/db'
import { setVisibility } from '@/lib/press/shared'
import { issueByNumber } from '@/lib/press/workbench'
import { NOT_FOUND, asResponse, issueNumber, pressUiEnabled } from '../../../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, context: { params: Promise<{ number: string }> }) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const { number: raw } = await context.params
  const number = issueNumber(raw)
  if (number === null) return NextResponse.json({ error: 'bad issue' }, { status: 400 })

  const body = (await request.json().catch(() => null)) as { shared?: boolean } | null
  if (typeof body?.shared !== 'boolean') {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  try {
    const account = await currentAccount()
    const db = pressDb(account.id)

    const issue = await issueByNumber(number, db)
    if (!issue) return NextResponse.json({ error: 'no such issue' }, { status: 404 })

    const updated = await setVisibility(issue.id, body.shared ? 'shared' : 'private', db)
    if (!updated) {
      return NextResponse.json(
        { error: 'Make the PDF first — there is nothing to read yet.' },
        { status: 409 },
      )
    }

    return NextResponse.json({
      visibility: updated.visibility,
      // The link to hand somebody, built here so the panel does not have to
      // know the handle or the shape of the URL.
      url: updated.visibility === 'shared' ? `/press/i/${account.handle}/${updated.number}` : null,
    })
  } catch (err) {
    return asResponse(err)
  }
}
