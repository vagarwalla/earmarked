/**
 * press — Cloudflare Email Worker (U2, KTD5).
 *
 * Cloudflare routes mail for the press address here; this hands the raw MIME
 * to the Next.js webhook and gets out of the way. No parsing, no dependencies,
 * no state — everything that could need changing lives in the app.
 *
 * Deploy: see README.md. Secrets are set with `wrangler secret put`, never
 * committed — this repo is public.
 */

export default {
  /**
   * @param {{ raw: ReadableStream, from: string, to: string, setReject: (r: string) => void }} message
   * @param {{ PRESS_WEBHOOK_URL: string, PRESS_EMAIL_WEBHOOK_SECRET: string }} env
   */
  async email(message, env) {
    if (!env.PRESS_WEBHOOK_URL || !env.PRESS_EMAIL_WEBHOOK_SECRET) {
      // Reject rather than drop: a bounce is visible, a silent discard is not.
      message.setReject('press is not configured to accept mail right now')
      return
    }

    const raw = await new Response(message.raw).arrayBuffer()

    const response = await fetch(env.PRESS_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'message/rfc822',
        'x-press-secret': env.PRESS_EMAIL_WEBHOOK_SECRET,
        // Cloudflare has already validated the envelope; the app logs these
        // for diagnostics and does not trust them for classification.
        'x-press-envelope-from': message.from,
        'x-press-envelope-to': message.to,
      },
      body: raw,
    })

    if (!response.ok) {
      // Throwing makes Cloudflare retry the delivery. The app stores the raw
      // message before it does anything else, so a retry is safe.
      throw new Error(`press webhook returned ${response.status}`)
    }
  },
}
