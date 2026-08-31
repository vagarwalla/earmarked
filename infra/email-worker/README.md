# press — inbound email worker

Cloudflare Email Routing accepts mail for the press address and hands the raw
MIME to `POST /api/press/email-in` on the Vercel app. This is the second door
into the pipeline (KTD5): newsletters, mailed links, and PDF uploads.

Cloudflare is doing the part that is genuinely hard — running an SMTP endpoint
with a real reputation — and nothing else. Classification, storage and
ingestion all happen in the app, so changing how mail is handled never means
redeploying this worker.

## Setup

1. **Email Routing** on the domain (Cloudflare dashboard → Email → Email
   Routing), verified per Cloudflare's instructions.
2. **Deploy the worker:**
   ```
   cd infra/email-worker
   npx wrangler deploy
   npx wrangler secret put PRESS_WEBHOOK_URL          # https://<the app>/api/press/email-in
   npx wrangler secret put PRESS_EMAIL_WEBHOOK_SECRET # same value as in Vercel
   ```
   Generate the secret with `openssl rand -hex 32`. It must match
   `PRESS_EMAIL_WEBHOOK_SECRET` in the Vercel environment — the route returns
   503 rather than accepting anything while it is unset.
3. **Route the address:** Email → Routing rules → add the press address with
   *Send to a Worker* → `press-email-in`.

## Gmail auto-forward

Forwarding a curated allowlist of newsletter senders (KTD4 — subscribing is not
the same as wanting something printed) needs Gmail's forwarding address to be
verified first. Gmail sends a confirmation code to the new address, which lands
here; the app recognises the sender `forwarding-noreply@google.com` and relays
that message to `PRESS_MAIL_TO` instead of ingesting it, so the code is
readable. Confirm it, then add the per-sender filter.

## Retries

A non-2xx response throws, which makes Cloudflare retry the delivery. The app
stores the raw MIME before classifying anything, so a retry cannot lose a
message — at worst the same raw copy is written twice.
