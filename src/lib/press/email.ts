/**
 * press — the email door (U2).
 *
 * A Cloudflare Email Worker (infra/email-worker) forwards raw MIME to
 * /api/press/email-in with a shared secret. Four kinds of mail arrive:
 *
 *   1. Gmail's forwarding-confirmation code — relayed onward, never ingested;
 *      Gmail will not switch auto-forwarding on until V confirms it, and the
 *      code lands here rather than in her inbox.
 *   2. A newsletter from the curated allowlist (KTD4) — the delivered HTML is
 *      the full text, including paid posts, so it is kept as the item content.
 *   3. A PDF attachment — already a laid-out document; normalized onto the
 *      print media box here so Lulu preflight cannot reject it at U5.
 *   4. A link drop — bare URL(s) in the body, each queued *and* mirrored into
 *      the `hw` Raindrop collection so Raindrop stays the canonical list.
 *
 * The raw MIME of every delivery is stored before anything is classified: the
 * parser will eventually meet a shape it does not understand, and the message
 * itself is the only thing that can be replayed.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import PostalMime, { type Attachment, type Email } from 'postal-mime'
import { PDFDocument } from 'pdf-lib'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  insertItem,
  normalizeUrl,
  putObject,
  recordEvent,
  storagePath,
  updateItem,
} from './db'
import { createRaindropClient, type RaindropClient } from './raindrop'
import { loadSettings, type PressSettings } from './settings'
import { BLEED_PT, MEDIA_HEIGHT_PT, MEDIA_WIDTH_PT, type PressItem } from './types'

/** Header the Cloudflare worker signs each delivery with. */
export const EMAIL_WEBHOOK_HEADER = 'x-press-secret'

/** Gmail's sender for the "confirm this forwarding address" mail. */
export const GMAIL_FORWARDING_SENDER = 'forwarding-noreply@google.com'

/** A link drop is a short mail. More prose than this and the URLs are incidental. */
const LINK_DROP_MAX_PROSE = 1000

/** A single mail can only mean so many articles; the rest is a signature or a digest. */
const MAX_LINKS_PER_MAIL = 10

const RESEND_API = 'https://api.resend.com/emails'

export type MailKind = 'gmail_verification' | 'newsletter' | 'pdf' | 'link' | 'unknown'

// ── Shared secret ────────────────────────────────────────────────────────────

/**
 * Constant-time comparison of the webhook secret. Both sides are hashed first
 * so the compare is over fixed-length buffers and cannot leak the length of
 * the configured secret.
 */
export function secretMatches(provided: string | null | undefined, expected: string): boolean {
  if (!expected || !provided) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

// ── Parsing and classification (pure) ────────────────────────────────────────

/** Lowercased address of the sender, or null when the mail has no usable From. */
export function fromAddress(mail: Email): string | null {
  const from = mail.from
  const address = from && 'address' in from ? from.address : undefined
  return address ? address.trim().toLowerCase() : null
}

export function isAllowlistedNewsletter(mail: Email, allowlist: string[]): boolean {
  const from = fromAddress(mail)
  return from !== null && allowlist.some((a) => a.trim().toLowerCase() === from)
}

export function pdfAttachments(mail: Email): Attachment[] {
  return (mail.attachments ?? []).filter(
    (a) =>
      a.mimeType?.toLowerCase() === 'application/pdf' ||
      (a.filename ?? '').toLowerCase().endsWith('.pdf'),
  )
}

/** Visible text of a mail — the text part if there is one, else the HTML stripped back. */
function bodyText(mail: Pick<Email, 'text' | 'html'>): string {
  if (mail.text && mail.text.trim()) return mail.text
  if (!mail.html) return ''
  return mail.html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
}

/** Trailing punctuation that belongs to the sentence, not the URL. */
function trimUrl(raw: string): string {
  let url = raw.replace(/[).,;:!?'"\]]+$/, '')
  // Keep a balanced trailing paren (Wikipedia-style URLs).
  if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1)
  return url
}

/**
 * Bare URLs in the body, deduped by the same normalization the database uses,
 * so "the same link twice" in one mail is one item.
 */
export function extractUrls(mail: Pick<Email, 'text' | 'html'>): string[] {
  const text = bodyText(mail)
  const found: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const url = trimUrl(match[0])
    const key = normalizeUrl(url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    found.push(url)
    if (found.length >= MAX_LINKS_PER_MAIL) break
  }
  return found
}

/** Body text with the URLs taken out — what is left is prose. */
function proseLength(mail: Pick<Email, 'text' | 'html'>): number {
  return bodyText(mail).replace(/https?:\/\/[^\s<>"'`]+/gi, ' ').trim().length
}

/**
 * Which door this mail came through.
 *
 * Order matters. Sender identity is the strongest signal, so the Gmail relay
 * and the newsletter allowlist are checked first; an attachment beats a body;
 * and a mail that merely *contains* links is only a link drop if it is short —
 * otherwise a marketing mail from an unknown sender would fan out into a dozen
 * items. Anything else is kept as raw MIME and left alone.
 */
export function classifyMail(mail: Email, allowlist: string[]): MailKind {
  if (fromAddress(mail) === GMAIL_FORWARDING_SENDER) return 'gmail_verification'
  if (isAllowlistedNewsletter(mail, allowlist)) return 'newsletter'
  if (pdfAttachments(mail).length > 0) return 'pdf'
  if (extractUrls(mail).length > 0 && proseLength(mail) <= LINK_DROP_MAX_PROSE) return 'link'
  return 'unknown'
}

// ── PDF normalization ────────────────────────────────────────────────────────

/**
 * Scale and centre every page onto the 7×10-plus-bleed media box.
 *
 * A PDF that arrives by mail is whatever size its author chose — A4, Letter,
 * a slide deck. Lulu preflight rejects an interior whose pages are not the
 * ordered trim, and by U5 the mistake is expensive, so the correction happens
 * at ingest while the source is still to hand. Aspect ratio is preserved (the
 * page is letterboxed rather than stretched) and the trim box is marked inside
 * the bleed so the printer knows where the cut falls.
 */
export async function normalizePdfToMediaBox(
  bytes: Uint8Array,
): Promise<{ pdf: Uint8Array; pageCount: number }> {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const out = await PDFDocument.create()

  // Embedded one at a time rather than in a batch: a page with no content
  // stream (a deliberate blank, or a page some producer left empty) makes
  // pdf-lib throw, and one such page must not cost the whole document. The
  // blank still gets a sheet, so the page count and the pagination hold.
  for (const sourcePage of source.getPages()) {
    const sheet = out.addPage([MEDIA_WIDTH_PT, MEDIA_HEIGHT_PT])
    sheet.setTrimBox(BLEED_PT, BLEED_PT, MEDIA_WIDTH_PT - 2 * BLEED_PT, MEDIA_HEIGHT_PT - 2 * BLEED_PT)

    // pdf-lib defers the actual embed to save(), so a try/catch here would not
    // catch it — the contentless page has to be spotted before it is embedded.
    if (!sourcePage.node.Contents()) continue

    const [page] = await out.embedPages([sourcePage])

    const scale = Math.min(MEDIA_WIDTH_PT / page.width, MEDIA_HEIGHT_PT / page.height)
    const width = page.width * scale
    const height = page.height * scale
    sheet.drawPage(page, {
      xScale: scale,
      yScale: scale,
      x: (MEDIA_WIDTH_PT - width) / 2,
      y: (MEDIA_HEIGHT_PT - height) / 2,
    })
  }

  return { pdf: await out.save(), pageCount: out.getPageCount() }
}

/** postal-mime hands attachment bodies back in whichever shape the part used. */
function attachmentBytes(attachment: Attachment): Uint8Array {
  const content = attachment.content
  if (content instanceof Uint8Array) return content
  if (content instanceof ArrayBuffer) return new Uint8Array(content)
  return new Uint8Array(Buffer.from(content, attachment.encoding === 'utf8' ? 'utf8' : 'base64'))
}

// ── Storage paths ────────────────────────────────────────────────────────────

/**
 * Retained newsletter HTML. It goes under the item's own prefix (the
 * convention every other artefact in `storagePath` follows) rather than under
 * `raw-email/`, because it is the item's *content*, not a copy of the
 * delivery: `raw_email_path` already holds the whole MIME message. The item's
 * `content_path` points here until U3 replaces it with the normalized
 * article JSON extracted from it.
 */
export function newsletterHtmlPath(itemId: string): string {
  return `items/${itemId}/newsletter.html`
}

// ── Ingestion ────────────────────────────────────────────────────────────────

export interface IngestOptions {
  db?: SupabaseClient
  settings?: PressSettings
  /** Injected in tests; built from settings otherwise. */
  raindrop?: RaindropClient
  /** Injected in tests for the Resend relay. */
  fetchImpl?: typeof fetch
}

export interface IngestResult {
  kind: MailKind
  /** Storage path of the raw MIME, stored before anything is classified. */
  rawEmailPath: string
  items: PressItem[]
  /** True when the mail was forwarded to V instead of being ingested. */
  relayed: boolean
}

function toBytes(raw: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof raw === 'string') return new TextEncoder().encode(raw)
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  return raw
}

/**
 * Parse one delivery, store it, and act on it. Returns what was created so the
 * route can answer with a summary and the tests can assert on real rows.
 */
export async function ingestEmail(
  raw: string | Uint8Array | ArrayBuffer,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const settings = options.settings ?? loadSettings()
  const db = options.db
  const bytes = toBytes(raw)
  const mail = await PostalMime.parse(bytes)

  // Raw first, always: a mail this parser mishandles is still recoverable.
  const rawEmailPath = storagePath.rawEmail(crypto.randomUUID())
  await putObject(rawEmailPath, bytes, 'message/rfc822', db)

  const kind = classifyMail(mail, settings.newsletterAllowlist)
  await recordEvent({ kind: 'email_received', detail: { classified: kind, raw_email_path: rawEmailPath } }, db)

  const result: IngestResult = { kind, rawEmailPath, items: [], relayed: false }

  switch (kind) {
    case 'gmail_verification':
      await relayToOwner(mail, settings, options.fetchImpl ?? fetch)
      result.relayed = true
      return result

    case 'newsletter':
      result.items = await ingestNewsletter(mail, rawEmailPath, db)
      return result

    case 'pdf':
      result.items = await ingestPdfs(mail, rawEmailPath, db)
      return result

    case 'link':
      result.items = await ingestLinks(mail, rawEmailPath, settings, options.raindrop, db)
      return result

    default:
      // Stored, not queued. Surfaces in the audit log rather than vanishing.
      await recordEvent({ kind: 'email_unclassified', detail: { raw_email_path: rawEmailPath } }, db)
      return result
  }
}

/** The HTML of the delivered newsletter is the article — nothing is fetched (KTD4). */
async function ingestNewsletter(
  mail: Email,
  rawEmailPath: string,
  db?: SupabaseClient,
): Promise<PressItem[]> {
  const html = mail.html ?? (mail.text ? `<pre>${mail.text}</pre>` : '')
  const item = await insertItem(
    {
      source: 'newsletter',
      // No url: a newsletter's canonical link is buried among tracking and
      // "view in browser" links, and guessing wrong would poison the dedupe key.
      title: mail.subject?.trim() || null,
      source_name: fromAddress(mail),
      published_at: mail.date ?? null,
      raw_email_path: rawEmailPath,
      state: 'queued',
    },
    db,
  )
  if (!item) return []

  // Remote CDN images are left as they stand; U3 downloads and rewrites them,
  // because the renderer must never resolve a network URL.
  const path = newsletterHtmlPath(item.id)
  await putObject(path, html, 'text/html; charset=utf-8', db)
  await updateItem(item.id, { content_path: path }, db)
  return [{ ...item, content_path: path }]
}

/**
 * A PDF arrives already laid out, so it skips extraction and layout entirely
 * and is inserted straight into `laid_out`. The normalized file is written
 * after the insert because the fragment path is keyed by the item id; a
 * failure between the two leaves an item with a page count and no fragment,
 * which the next compose reports rather than printing blank pages.
 */
async function ingestPdfs(mail: Email, rawEmailPath: string, db?: SupabaseClient): Promise<PressItem[]> {
  const items: PressItem[] = []

  for (const attachment of pdfAttachments(mail)) {
    const title = attachment.filename?.replace(/\.pdf$/i, '') || mail.subject?.trim() || null

    let normalized: { pdf: Uint8Array; pageCount: number }
    try {
      normalized = await normalizePdfToMediaBox(attachmentBytes(attachment))
    } catch (err) {
      const reason = `pdf normalization failed: ${err instanceof Error ? err.message : String(err)}`
      const failed = await insertItem(
        { source: 'pdf', title, raw_email_path: rawEmailPath, state: 'failed', failure_reason: reason },
        db,
      )
      if (failed) items.push(failed)
      continue
    }

    const item = await insertItem(
      {
        source: 'pdf',
        title,
        published_at: mail.date ?? null,
        raw_email_path: rawEmailPath,
        page_count: normalized.pageCount,
        state: 'laid_out',
      },
      db,
    )
    if (!item) continue

    const fragmentPath = storagePath.fragment(item.id)
    await putObject(fragmentPath, normalized.pdf, 'application/pdf', db)
    await updateItem(item.id, { fragment_path: fragmentPath }, db)
    items.push({ ...item, fragment_path: fragmentPath, page_count: normalized.pageCount })
  }

  return items
}

/**
 * Each URL becomes an item and a raindrop in `hw`, in that order: the item is
 * the thing that gets printed, and inserting it first means a link already in
 * the pipeline is not mirrored into Raindrop a second time. A Raindrop outage
 * costs the mirror, never the item.
 */
async function ingestLinks(
  mail: Email,
  rawEmailPath: string,
  settings: PressSettings,
  client: RaindropClient | undefined,
  db?: SupabaseClient,
): Promise<PressItem[]> {
  const raindrop =
    client ?? (settings.raindropToken ? createRaindropClient({ token: settings.raindropToken }) : null)
  const items: PressItem[] = []

  for (const url of extractUrls(mail)) {
    const item = await insertItem(
      {
        source: 'email_link',
        url,
        title: mail.subject?.trim() || null,
        raw_email_path: rawEmailPath,
        state: 'queued',
      },
      db,
    )
    if (!item) continue // already in the pipeline, and so already in `hw`

    let raindropId: string | null = null
    if (raindrop && settings.raindropCollectionId) {
      try {
        const drop = await raindrop.createRaindrop(url, settings.raindropCollectionId)
        raindropId = String(drop._id)
        await updateItem(item.id, { raindrop_id: raindropId }, db)
      } catch (err) {
        await recordEvent(
          {
            item_id: item.id,
            kind: 'raindrop_mirror_failed',
            detail: { reason: err instanceof Error ? err.message : String(err) },
          },
          db,
        )
      }
    }

    items.push({ ...item, raindrop_id: raindropId })
  }

  return items
}

/**
 * Forward a mail to V rather than ingesting it. Only Gmail's forwarding
 * confirmation takes this path; it carries a code that expires, so it is sent
 * straight through with the body intact.
 *
 * Talks to Resend over its REST API — U6/U7 will want a shared mailer, but one
 * POST does not justify pulling the SDK into the webhook's cold start.
 */
async function relayToOwner(mail: Email, settings: PressSettings, doFetch: typeof fetch): Promise<void> {
  if (!settings.resendApiKey || !settings.mailFrom || !settings.mailTo) {
    // Nothing to be done by retrying; the raw MIME is stored and the code can
    // be read out of it by hand.
    console.error('press/email: forwarding confirmation arrived but mail settings are unset')
    return
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
      subject: `Fwd: ${mail.subject ?? 'forwarding confirmation'}`,
      ...(mail.html ? { html: mail.html } : {}),
      text: mail.text ?? '',
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`press/email: relay failed (${res.status}): ${body.slice(0, 200)}`)
  }
}
