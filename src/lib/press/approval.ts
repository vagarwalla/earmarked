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
      { token_hash: hashToken(token), issue_id: issueId, action, item_id: itemId ?? null, expires_at: expiresAt },
      deps.db,
    )
    issued.push({ action, itemId: itemId ?? null, token, url: actionUrl(settings.appUrl, token) })
  }
  return issued
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
