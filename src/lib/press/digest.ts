/**
 * press — the weekly failure digest (U7).
 *
 * Extraction fails on hostile pages and that is expected; what is not
 * acceptable is failures disappearing. Anything that landed in `failed` since
 * the last digest is reported here, so a systematically broken source shows up
 * as a pattern rather than as an issue that quietly gets thinner.
 *
 * Reader-dropped items are excluded: V dropping an article is a decision, not
 * a failure, and reporting it back to her would be noise.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { itemsInState } from './db'
import { sendMail, type MailerDeps } from './approval'
import type { PressItem } from './types'

export const DROPPED_REASON = 'reader-dropped'

export interface DigestLine {
  title: string
  url: string | null
  source: string
  reason: string
  when: string
}

/** Failures worth telling V about. */
export function digestLines(items: PressItem[], since: Date): DigestLine[] {
  return items
    .filter((i) => i.state === 'failed')
    .filter((i) => i.failure_reason !== DROPPED_REASON)
    .filter((i) => new Date(i.updated_at) >= since)
    .map((i) => ({
      title: i.title ?? i.url ?? '(untitled)',
      url: i.url,
      source: i.source,
      reason: i.failure_reason ?? 'unknown',
      when: i.updated_at.slice(0, 10),
    }))
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function digestHtml(lines: DigestLine[]): string {
  const rows = lines
    .map(
      (l) => `<tr>
  <td style="padding:6px 12px 6px 0;vertical-align:top">
    <div style="font:14px Georgia,serif">${escape(l.title)}</div>
    ${l.url ? `<div style="font:11px -apple-system,Helvetica,sans-serif;color:#999">${escape(l.url)}</div>` : ''}
  </td>
  <td style="padding:6px 0;font:12px -apple-system,Helvetica,sans-serif;color:#a33;vertical-align:top">${escape(l.reason)}</td>
</tr>`,
    )
    .join('\n')

  return `<div style="max-width:560px;margin:0 auto;font:15px/1.5 -apple-system,Helvetica,sans-serif;color:#17171a">
  <h1 style="font:400 20px Georgia,serif;margin:0 0 4px">Didn't make it in</h1>
  <p style="margin:0 0 20px;color:#777;font-size:13px">${lines.length} item${lines.length === 1 ? '' : 's'} failed this week.</p>
  <table style="width:100%;border-collapse:collapse">${rows}</table>
  <p style="margin:20px 0 0;color:#999;font-size:12px">Re-save anything worth another try; it will be picked up on the next poll.</p>
</div>`
}

/**
 * Send the digest, or send nothing. A weekly "all clear" email trains its
 * reader to ignore the channel, and this channel needs to be believed.
 */
export async function sendWeeklyDigest(
  since: Date,
  deps: MailerDeps & { db: SupabaseClient },
): Promise<{ sent: boolean; count: number }> {
  const failed = await itemsInState(['failed'], deps.db, 500)
  const lines = digestLines(failed, since)
  if (lines.length === 0) return { sent: false, count: 0 }

  await sendMail(
    { subject: `press — ${lines.length} item${lines.length === 1 ? '' : 's'} didn't make it in`, html: digestHtml(lines) },
    deps,
  )
  return { sent: true, count: lines.length }
}
