/**
 * press — the confirmation page (U6).
 *
 * Every action link in the approval email lands here. This page only *reads*
 * the token: mail scanners and link previewers fetch URLs, and if the GET
 * itself acted, Gmail's own prefetch would place an order or burn the token
 * before V ever opened the message. The button below posts to the action
 * route, which is where anything actually happens.
 */

import { inspectToken } from '@/lib/press/approval'
import { getIssue } from '@/lib/press/db'
import ConfirmButton from './ConfirmButton'

export const dynamic = 'force-dynamic'

const COPY: Record<string, { title: string; body: string; cta: string }> = {
  approve: {
    title: 'Print this issue?',
    body: 'This orders one copy from Lulu and posts it to you. It cannot be undone once the printer starts.',
    cta: 'Print it',
  },
  /**
   * A bundle is one job and one decision. There is no half of it to confirm,
   * so the page says what the whole parcel is before the button is pressed.
   */
  'approve-bundle': {
    title: 'Print these issues?',
    body: 'This sends ONE order to Lulu with all of them in one parcel, which is what makes it cheaper than ordering them one at a time. It cannot be undone once the printer starts.',
    cta: 'Print them',
  },
  skip: {
    title: 'Skip this issue?',
    body: 'Every article goes back to the issue that is filling now. Nothing is lost and nothing is printed.',
    cta: 'Skip it',
  },
  drop: {
    title: 'Drop this article?',
    body: 'It leaves this issue and will not be printed. The issue is rebuilt and a new approval email follows.',
    cta: 'Drop it',
  },
  preview: {
    title: 'Preview',
    body: 'This link opens the composed issue.',
    cta: 'Open',
  },
}

const EXPLAIN: Record<string, string> = {
  unknown: 'This is not a link we issued. It may have been mistyped, or cut short by a mail client.',
  used: 'This link has already been used. Each one works exactly once.',
  expired: 'This link has expired. The next weekly run will send a new approval email.',
}

export default async function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const lookup = await inspectToken(token)

  if (!lookup.ok) {
    return (
      <Shell title="That link no longer works">
        <p className="text-muted-foreground text-sm">{EXPLAIN[lookup.reason]}</p>
      </Shell>
    )
  }

  // Every issue the link acts on, which for everything but a bundle is the
  // one it has always been. Read here rather than in the button because this
  // page is the last description of what is about to be bought.
  const issueIds = lookup.token.issue_ids?.length ? lookup.token.issue_ids : [lookup.token.issue_id]
  const issues = (await Promise.all(issueIds.map((id) => getIssue(id)))).filter((i) => i !== null)
  const bundled = lookup.token.action === 'approve' && issues.length > 1
  const copy = (bundled ? COPY['approve-bundle'] : COPY[lookup.token.action]) ?? COPY.approve

  return (
    <Shell title={copy.title}>
      {issues.length > 0 && (
        <ul className="text-muted-foreground mb-4 space-y-0.5 text-sm">
          {issues.map((issue) => (
            <li key={issue.id}>
              Issue {issue.number}
              {issue.name ? ` — ${issue.name}` : ''}
              {issue.page_total ? ` · ${issue.page_total} pages` : ''}
            </li>
          ))}
        </ul>
      )}
      <p className="mb-6 text-sm">{copy.body}</p>
      <ConfirmButton token={token} label={copy.cta} />
    </Shell>
  )
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="mb-3 font-serif text-2xl">{title}</h1>
      {children}
    </main>
  )
}
