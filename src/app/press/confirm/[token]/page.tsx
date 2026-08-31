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
    body: 'This places a single-copy order with Lulu and mails it to you. It cannot be undone once the printer picks it up.',
    cta: 'Print it',
  },
  skip: {
    title: 'Skip this issue?',
    body: 'Every article goes back into the issue that is currently filling. Nothing is lost and nothing is printed.',
    cta: 'Skip it',
  },
  drop: {
    title: 'Drop this article?',
    body: 'It leaves this issue and will not be printed. The issue is re-composed and a fresh approval email follows.',
    cta: 'Drop it',
  },
  preview: {
    title: 'Preview',
    body: 'This link opens the composed issue.',
    cta: 'Open',
  },
}

const EXPLAIN: Record<string, string> = {
  unknown: 'This link is not one we issued. It may have been mistyped or truncated by a mail client.',
  used: 'This link has already been used. Each one works exactly once.',
  expired: 'This link has expired. The next weekly tick will send a fresh approval email.',
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

  const issue = await getIssue(lookup.token.issue_id)
  const copy = COPY[lookup.token.action] ?? COPY.approve

  return (
    <Shell title={copy.title}>
      {issue && (
        <p className="text-muted-foreground mb-4 text-sm">
          Issue {issue.number}
          {issue.name ? ` — ${issue.name}` : ''}
          {issue.page_total ? ` · ${issue.page_total} pages` : ''}
        </p>
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
