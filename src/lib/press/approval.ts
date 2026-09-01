/**
 * press — the approval gate (U6).
 *
 * One printed issue costs real money and a botched extraction wastes a hundred
 * pages, so nothing is ordered until V taps approve. This module owns the
 * tokens behind those links and the email that carries them.
 *
 * Two properties matter here and are tested:
 *
 *  1. **Action links are GET-safe.** Mail scanners and link previewers fetch
 *     every URL in a message. A GET only opens a confirmation page; the state
 *     change happens on POST. Otherwise Gmail's own prefetch would place an
 *     order, or burn the single-use token before V ever saw it.
 *  2. **Tokens are single-use and stored hashed.** Only the SHA-256 goes in
 *     the database, so a leaked row cannot be replayed as a link.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  consumeActionToken,
  expireIssueTokens,
  peekActionToken,
  storeActionToken,
  updateIssue,
  recordEvent,
} from './db'
import { loadSettings, type PressSettings } from './settings'
import { formatQuote } from './lulu'
import { formatMoney } from './orders'
import type { ActionKind, ActionToken, PrintQuote, TocEntry } from './types'

/** Long enough that a buried approval email is still actionable next week. */
export const TOKEN_TTL_DAYS = 30

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Constant-time compare, for anywhere a token is checked against a stored value. */
export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export interface IssuedToken {
  action: ActionKind
  itemId: string | null
  token: string
  url: string
}

function actionUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, '')}/press/confirm/${token}`
}

/**
 * Mint the links for one approval email. Any token still outstanding for the
 * issue is expired first, so a re-composed issue cannot be approved through a
 * link that describes the previous version of it.
 */
export async function issueActionTokens(
  issueId: string,
  actions: { action: ActionKind; itemId?: string | null }[],
  deps: { db?: SupabaseClient; settings?: PressSettings; now?: Date } = {},
): Promise<IssuedToken[]> {
  const settings = deps.settings ?? loadSettings()
  const now = deps.now ?? new Date()
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  await expireIssueTokens(issueId, deps.db)

  const issued: IssuedToken[] = []
  for (const { action, itemId } of actions) {
    const token = generateToken()
    await storeActionToken(
      {
        token_hash: hashToken(token),
        issue_id: issueId,
        // Always populated, even for one issue. Expiry matches on this array
        // and nothing else, so a token that left it empty would be one no
        // recompose could ever invalidate.
        issue_ids: [issueId],
        action,
        item_id: itemId ?? null,
        expires_at: expiresAt,
      },
      deps.db,
    )
    issued.push({ action, itemId: itemId ?? null, token, url: actionUrl(settings.appUrl, token) })
  }
  return issued
}

/**
 * Mint the ONE link that approves a whole bundle.
 *
 * One token, not one per issue. A bundle is a single Lulu job and the reader
 * makes a single decision about it; N links would be N chances to buy half a
 * parcel — exactly the outcome the all-or-nothing rule exists to prevent — and
 * the saving that justified bundling would be spent by the second click.
 *
 * The row carries the lead issue in `issue_id`, which is what the foreign key
 * and the confirmation page have always read, and every issue in `issue_ids`,
 * which is what the action route drives and what expiry matches on. So a
 * recompose of *any* member invalidates the bundle's link, and not just the
 * one that happens to lead it.
 */
export async function issueBundleToken(
  issueIds: string[],
  deps: { db?: SupabaseClient; settings?: PressSettings; now?: Date } = {},
): Promise<IssuedToken> {
  if (issueIds.length === 0) throw new Error('press/approval: a bundle token needs at least one issue')

  const settings = deps.settings ?? loadSettings()
  const now = deps.now ?? new Date()
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Every member, not just the lead. An outstanding link that would order
  // issue 4 on its own must not survive alongside one that orders 3 and 4
  // together: the two carry different idempotency keys, so both being followed
  // buys issue 4 twice.
  for (const issueId of issueIds) await expireIssueTokens(issueId, deps.db)

  const token = generateToken()
  await storeActionToken(
    {
      token_hash: hashToken(token),
      issue_id: issueIds[0],
      issue_ids: issueIds,
      action: 'approve',
      item_id: null,
      expires_at: expiresAt,
    },
    deps.db,
  )
  return { action: 'approve', itemId: null, token, url: actionUrl(settings.appUrl, token) }
}

export type TokenLookup =
  | { ok: true; token: ActionToken }
  | { ok: false; reason: 'unknown' | 'used' | 'expired' }

/**
 * Read a token without spending it — what the GET confirmation page does.
 * Never mutates, so a scanner's prefetch is harmless.
 */
export async function inspectToken(
  rawToken: string,
  deps: { db?: SupabaseClient; now?: Date } = {},
): Promise<TokenLookup> {
  const row = await peekActionToken(hashToken(rawToken), deps.db)
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.used_at) return { ok: false, reason: 'used' }
  if (new Date(row.expires_at) <= (deps.now ?? new Date())) return { ok: false, reason: 'expired' }
  return { ok: true, token: row }
}

/** Spend a token. Only the POST path calls this. */
export async function claimToken(
  rawToken: string,
  deps: { db?: SupabaseClient } = {},
): Promise<TokenLookup> {
  const row = await consumeActionToken(hashToken(rawToken), deps.db)
  if (!row) {
    // The atomic consume refuses used and expired alike; distinguish for the
    // page copy, which is the only thing that cares.
    const peeked = await peekActionToken(hashToken(rawToken), deps.db)
    if (!peeked) return { ok: false, reason: 'unknown' }
    return { ok: false, reason: peeked.used_at ? 'used' : 'expired' }
  }
  return { ok: true, token: row }
}

// ── The approval email ───────────────────────────────────────────────────────

export interface ApprovalEmailInput {
  issueNumber: number
  issueName: string
  pageCount: number
  quote: PrintQuote | null
  toc: TocEntry[]
  previewUrl: string
  approveUrl: string
  skipUrl: string
  /** itemId → the link that drops that one article and re-composes. */
  dropUrls: Map<string, string>
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function approvalSubject(input: ApprovalEmailInput): string {
  return `press — Issue ${input.issueNumber}: ${input.issueName} (${input.pageCount} pages)`
}

/**
 * Plain, legible HTML. The preview link points at the full composed interior,
 * not a thumbnail: a mangled extraction is only visible at full size, and this
 * is the last gate before the issue is printed.
 */
export function approvalHtml(input: ApprovalEmailInput): string {
  const rows = input.toc
    .map((entry) => {
      const drop = input.dropUrls.get(entry.itemId)
      const meta = [entry.byline, entry.sourceName].filter(Boolean).join(' · ')
      return `<tr>
  <td style="padding:6px 12px 6px 0;vertical-align:top">
    <div style="font:15px Georgia,serif">${escape(entry.title)}</div>
    ${meta ? `<div style="font:12px -apple-system,Helvetica,sans-serif;color:#777">${escape(meta)}</div>` : ''}
  </td>
  <td style="padding:6px 12px;text-align:right;color:#777;font:13px -apple-system,Helvetica,sans-serif;vertical-align:top">p.${entry.startPage}</td>
  <td style="padding:6px 0;text-align:right;vertical-align:top">${
    drop ? `<a href="${escape(drop)}" style="font:12px -apple-system,Helvetica,sans-serif;color:#a33">drop</a>` : ''
  }</td>
</tr>`
    })
    .join('\n')

  const cost = input.quote
    ? escape(formatQuote(input.quote))
    : 'no quote available — Lulu did not price this issue'

  return `<div style="max-width:560px;margin:0 auto;font:15px/1.5 -apple-system,Helvetica,sans-serif;color:#17171a">
  <h1 style="font:400 26px Georgia,serif;margin:0 0 4px">${escape(input.issueName)}</h1>
  <p style="margin:0 0 20px;color:#777;font-size:13px">Issue ${input.issueNumber} · ${input.pageCount} pages · ${cost}</p>

  <p style="margin:0 0 20px"><a href="${escape(input.previewUrl)}" style="font-size:14px">Read the full issue before deciding →</a></p>

  <table style="width:100%;border-collapse:collapse;margin:0 0 24px">${rows}</table>

  <p style="margin:0 0 8px">
    <a href="${escape(input.approveUrl)}" style="display:inline-block;padding:10px 18px;background:#17171a;color:#fff;text-decoration:none;border-radius:4px">Print it</a>
    <a href="${escape(input.skipUrl)}" style="display:inline-block;padding:10px 18px;color:#777;text-decoration:none">Not this one</a>
  </p>
  <p style="margin:16px 0 0;color:#999;font-size:12px">
    Nothing is ordered until you confirm on the page these links open.
    Skipping returns every article to the next issue.
  </p>
</div>`
}

// ── The bundle approval email ────────────────────────────────────────────────

export interface BundleIssueEmail {
  number: number
  name: string
  pageCount: number
  /** This issue's share of the job — its print cost plus a share of the parcel. */
  costCents: number | null
  previewUrl: string
  toc: TocEntry[]
}

export interface BundleApprovalEmailInput {
  issues: BundleIssueEmail[]
  quote: PrintQuote | null
  /** What the same issues would cost as one job each. Null for a bundle of one. */
  separateTotalCents: number | null
  savingCents: number | null
  quantity: number
  approveUrl: string
}

/**
 * The email for a bundle carries no skip link, and the omission is deliberate.
 *
 * Skipping returns an issue's articles to the next one — a per-issue decision
 * with a per-issue consequence — and a single button that declined three
 * issues at once would be the most destructive thing in the message sitting
 * next to the least. Not ordering a bundle is simply not clicking, and any one
 * issue can still be skipped from its own approval email or the workbench.
 */
export function bundleApprovalSubject(input: BundleApprovalEmailInput): string {
  if (input.issues.length === 1) {
    const only = input.issues[0]
    return `press — Issue ${only.number}: ${only.name} (${only.pageCount} pages)`
  }
  const total = input.quote ? `: ${formatMoney(input.quote.totalCents, input.quote.currency)}` : ''
  return `press — ${input.issues.length} issues in one parcel${total}`
}

/**
 * The same plain HTML as the single-issue email, with the one thing a bundle
 * has to answer for: what it saved.
 *
 * The saving is stated as the comparison it actually is — these issues as one
 * job against these issues as several — because "22.72" alone is a number
 * nobody can act on. It appears only when both halves were priced; a missing
 * quote leaves it out entirely rather than implying the saving was nothing.
 *
 * Each issue keeps its own contents and its own full-size preview link. The
 * bundle is a shipping arrangement, not an editorial one, and the last gate
 * against a mangled extraction is still per issue.
 */
export function bundleApprovalHtml(input: BundleApprovalEmailInput): string {
  const currency = input.quote?.currency ?? 'USD'
  const cost = input.quote
    ? escape(formatQuote(input.quote))
    : 'no quote available — Lulu did not price this'

  const sections = input.issues
    .map(
      (issue) => `<section style="margin:0 0 22px">
  <h2 style="font:400 19px Georgia,serif;margin:0 0 2px">${escape(issue.name)}</h2>
  <p style="margin:0 0 8px;color:#777;font-size:13px">
    Issue ${issue.number} · ${issue.pageCount} pages${
      issue.costCents === null ? '' : ` · ${escape(formatMoney(issue.costCents, currency))}`
    }
  </p>
  ${
    issue.previewUrl
      ? `<p style="margin:0 0 8px"><a href="${escape(issue.previewUrl)}" style="font-size:14px">Read it before deciding →</a></p>`
      : ''
  }
  <table style="width:100%;border-collapse:collapse">${issue.toc
    .map((entry) => {
      const meta = [entry.byline, entry.sourceName].filter(Boolean).join(' · ')
      return `<tr>
    <td style="padding:4px 12px 4px 0;vertical-align:top">
      <div style="font:14px Georgia,serif">${escape(entry.title)}</div>
      ${meta ? `<div style="font:12px -apple-system,Helvetica,sans-serif;color:#777">${escape(meta)}</div>` : ''}
    </td>
    <td style="padding:4px 0;text-align:right;color:#777;font:13px -apple-system,Helvetica,sans-serif;vertical-align:top">p.${entry.startPage}</td>
  </tr>`
    })
    .join('\n')}</table>
</section>`,
    )
    .join('\n')

  // Stated only when both halves are real numbers. An unpriced comparison
  // silently becomes no claim at all, rather than a claim of zero.
  const saving =
    input.savingCents !== null && input.separateTotalCents !== null && input.quote
      ? `<p style="margin:0 0 20px;padding:10px 12px;background:#f4f4f2;border-radius:4px;font-size:13px">
    One parcel for all ${input.issues.length}. Ordered separately they would be
    ${escape(formatMoney(input.separateTotalCents, currency))} — Lulu charges shipping per job, not per book —
    so this saves <strong>${escape(formatMoney(input.savingCents, currency))}</strong>.
  </p>`
      : ''

  const heading =
    input.issues.length === 1
      ? escape(input.issues[0].name)
      : `${input.issues.length} issues, one parcel`

  return `<div style="max-width:560px;margin:0 auto;font:15px/1.5 -apple-system,Helvetica,sans-serif;color:#17171a">
  <h1 style="font:400 26px Georgia,serif;margin:0 0 4px">${heading}</h1>
  <p style="margin:0 0 20px;color:#777;font-size:13px">${
    input.quantity > 1 ? `${input.quantity} copies of each · ` : ''
  }${cost}</p>

  ${saving}

  ${sections}

  <p style="margin:0 0 8px">
    <a href="${escape(input.approveUrl)}" style="display:inline-block;padding:10px 18px;background:#17171a;color:#fff;text-decoration:none;border-radius:4px">${
      input.issues.length === 1 ? 'Print it' : 'Print them'
    }</a>
  </p>
  <p style="margin:16px 0 0;color:#999;font-size:12px">
    Nothing is ordered until you confirm on the page this link opens. It works once, and it
    orders ${input.issues.length === 1 ? 'this issue' : `all ${input.issues.length} issues`} as a single job —
    there is no way to buy part of a parcel.
  </p>
</div>`
}

// ── Sending ──────────────────────────────────────────────────────────────────

export const RESEND_API = 'https://api.resend.com/emails'

export interface MailerDeps {
  settings?: PressSettings
  fetchImpl?: typeof fetch
}

/** One Resend call. Throws on failure so the caller can retry on the next tick. */
export async function sendMail(
  message: { subject: string; html: string; text?: string },
  deps: MailerDeps = {},
): Promise<void> {
  const settings = deps.settings ?? loadSettings()
  const doFetch = deps.fetchImpl ?? fetch

  if (!settings.resendApiKey || !settings.mailFrom || !settings.mailTo) {
    throw new Error('press/mail: RESEND_API_KEY, PRESS_MAIL_FROM and PRESS_MAIL_TO must all be set')
  }

  const res = await doFetch(RESEND_API, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: settings.mailFrom,
      to: [settings.mailTo],
      subject: message.subject,
      html: message.html,
      ...(message.text ? { text: message.text } : {}),
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`press/mail: send failed (${res.status}): ${body.slice(0, 200)}`)
  }
}

/**
 * Send one email covering a bundle, and mark every issue in it as asked about.
 *
 * `approval_sent_at` is per issue and stays that way: it is what the weekly
 * tick reads to decide whether an issue still needs chasing, and an issue
 * whose only outstanding approval is a bundle link has, in the only sense that
 * matters to that check, been asked about.
 */
export async function sendBundleApprovalEmail(
  issueIds: string[],
  input: BundleApprovalEmailInput,
  deps: MailerDeps & { db?: SupabaseClient; now?: Date } = {},
): Promise<void> {
  await sendMail({ subject: bundleApprovalSubject(input), html: bundleApprovalHtml(input) }, deps)
  const sentAt = (deps.now ?? new Date()).toISOString()
  for (const [i, issueId] of issueIds.entries()) {
    await updateIssue(issueId, { approval_sent_at: sentAt }, deps.db)
    await recordEvent(
      {
        issue_id: issueId,
        kind: 'approval_sent',
        detail: {
          pageCount: input.issues[i]?.pageCount ?? 0,
          ...(issueIds.length > 1 ? { bundledWith: issueIds.length - 1 } : {}),
        },
      },
      deps.db,
    )
  }
}

export async function sendApprovalEmail(
  issueId: string,
  input: ApprovalEmailInput,
  deps: MailerDeps & { db?: SupabaseClient; now?: Date } = {},
): Promise<void> {
  await sendMail({ subject: approvalSubject(input), html: approvalHtml(input) }, deps)
  await updateIssue(issueId, { approval_sent_at: (deps.now ?? new Date()).toISOString() }, deps.db)
  await recordEvent(
    { issue_id: issueId, kind: 'approval_sent', detail: { pageCount: input.pageCount } },
    deps.db,
  )
}
