/**
 * press — configuration.
 *
 * Everything personal or secret lives in env (Vercel, Fly, .env.local) because
 * this repo is public. Nothing in here has a real default that leaks anything;
 * the address fields are read at order time and never logged.
 */

export interface PressSettings {
  // Supabase (service-role — press tables deny the anon key entirely)
  supabaseUrl: string
  supabaseServiceKey: string
  storageBucket: string

  // Raindrop (U2/U9)
  raindropToken: string
  /** Numeric id of the `hw` / `homework` collection; resolved once at setup. */
  raindropCollectionId: string

  // Email (U2 in, U6/U7 out)
  emailWebhookSecret: string
  resendApiKey: string
  mailFrom: string
  mailTo: string
  /** Senders whose newsletters are printed. Curated by V; not "all of Substack" (KTD4). */
  newsletterAllowlist: string[]

  // Lulu (U6)
  luluClientKey: string
  luluClientSecret: string
  luluSandbox: boolean
  luluPackageId: string

  // Anthropic (KTD8 — optional; naming falls back to a date range)
  anthropicApiKey: string | null

  // Shipping (U6) — env only, never committed
  shipping: {
    name: string
    street1: string
    street2: string | null
    city: string
    stateCode: string
    postcode: string
    countryCode: string
    phone: string
  } | null

  // Issue policy
  pageThreshold: number
  maxIssueAgeWeeks: number

  /** Public origin of the Next.js app, for building approval links. */
  appUrl: string
  /** Signs action tokens (U6). */
  actionTokenSecret: string
}

function env(name: string): string {
  return process.env[name] ?? ''
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envList(name: string): string[] {
  return env(name)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function shippingFromEnv(): PressSettings['shipping'] {
  const street1 = env('PRESS_SHIP_STREET1')
  const city = env('PRESS_SHIP_CITY')
  const postcode = env('PRESS_SHIP_POSTCODE')
  // A partial address is worse than none — it would fail Lulu validation late.
  if (!street1 || !city || !postcode) return null
  return {
    name: env('PRESS_SHIP_NAME'),
    street1,
    street2: env('PRESS_SHIP_STREET2') || null,
    city,
    stateCode: env('PRESS_SHIP_STATE'),
    postcode,
    countryCode: env('PRESS_SHIP_COUNTRY') || 'US',
    phone: env('PRESS_SHIP_PHONE'),
  }
}

export function loadSettings(): PressSettings {
  return {
    supabaseUrl: env('NEXT_PUBLIC_SUPABASE_URL'),
    supabaseServiceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    storageBucket: env('PRESS_STORAGE_BUCKET') || 'press',

    raindropToken: env('RAINDROP_TOKEN'),
    raindropCollectionId: env('RAINDROP_COLLECTION_ID'),

    emailWebhookSecret: env('PRESS_EMAIL_WEBHOOK_SECRET'),
    resendApiKey: env('RESEND_API_KEY'),
    mailFrom: env('PRESS_MAIL_FROM'),
    mailTo: env('PRESS_MAIL_TO'),
    newsletterAllowlist: envList('PRESS_NEWSLETTER_ALLOWLIST'),

    luluClientKey: env('LULU_CLIENT_KEY'),
    luluClientSecret: env('LULU_CLIENT_SECRET'),
    luluSandbox: env('LULU_SANDBOX') !== 'false',
    luluPackageId: env('LULU_PACKAGE_ID') || '0700X1000.FC.STD.PB.060UW444.GXX',

    anthropicApiKey: env('ANTHROPIC_API_KEY') || null,

    shipping: shippingFromEnv(),

    pageThreshold: envInt('PRESS_PAGE_THRESHOLD', 100),
    maxIssueAgeWeeks: envInt('PRESS_MAX_ISSUE_AGE_WEEKS', 8),

    appUrl: env('PRESS_APP_URL') || 'http://localhost:3000',
    actionTokenSecret: env('PRESS_ACTION_TOKEN_SECRET'),
  }
}

/**
 * Names of settings that must be present before a given unit can run.
 * Used by the worker's startup check so a missing secret fails loudly at boot
 * rather than silently at 2am on the weekly tick.
 */
export const REQUIRED_BY_UNIT = {
  db: ['supabaseUrl', 'supabaseServiceKey'],
  ingest: ['raindropToken', 'raindropCollectionId'],
  emailIn: ['emailWebhookSecret'],
  mail: ['resendApiKey', 'mailFrom', 'mailTo'],
  order: ['luluClientKey', 'luluClientSecret', 'actionTokenSecret', 'appUrl'],
} as const satisfies Record<string, readonly (keyof PressSettings)[]>

export type UnitName = keyof typeof REQUIRED_BY_UNIT

/** Returns the settings a unit needs but does not have. */
export function missingSettings(unit: UnitName, settings = loadSettings()): string[] {
  return REQUIRED_BY_UNIT[unit].filter((key) => {
    const value = settings[key as keyof PressSettings]
    return value === '' || value === null || value === undefined
  })
}

export function assertConfigured(unit: UnitName, settings = loadSettings()): void {
  const missing = missingSettings(unit, settings)
  if (missing.length > 0) {
    throw new Error(`press/${unit}: missing configuration: ${missing.join(', ')}`)
  }
}
