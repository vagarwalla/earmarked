'use client'

/**
 * press — settings.
 *
 * Four groups, and one of them is deliberately not a form. The address, the
 * email and the print policy are rows in `press_settings`; payment is a
 * sentence and a link, because no card number should ever enter this app and
 * the only way to be sure of that is to have nowhere to put one. Lulu bills
 * the account on file.
 *
 * A field left empty means "let the environment answer", which is what the
 * hints under each group are saying. Env is the floor: a database that has
 * never been filled in behaves exactly as it did before this table existed.
 *
 * The address saves as a unit because a partial address is treated as no
 * address — `shippingFromEnv()` has always done that, since half a postcode
 * fails Lulu's validation late, after you believe the thing is bought.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §5.
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { FIELD } from './controls'
import { readJson } from './readJson'
import type { PressSettingsRow } from '@/lib/press/settings-db'

export interface SettingsProps {
  row: PressSettingsRow
  hasRow: boolean
  env: {
    hasShipping: boolean
    mailTo: string | null
    pageThreshold: number
    luluPackageId: string | null
    luluSandbox: boolean
  }
  effective: {
    hasShipping: boolean
    mailTo: string | null
    luluSandbox: boolean
    copies: number
  }
}

const ADDRESS_FIELDS = [
  ['ship_name', 'Name'],
  ['ship_street1', 'Street'],
  ['ship_street2', 'Street 2'],
  ['ship_city', 'City'],
  ['ship_state', 'State'],
  ['ship_postcode', 'Postcode'],
  ['ship_country', 'Country'],
  ['ship_phone', 'Phone'],
] as const

export function SettingsPanel({
  row,
  env,
  effective,
  onError,
  onNote,
  onRefresh,
}: SettingsProps & {
  onError: (m: string | null) => void
  onNote: (m: string | null) => void
  onRefresh: () => void
}) {
  const [draft, setDraft] = useState<PressSettingsRow>(row)
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof PressSettingsRow>(key: K, value: PressSettingsRow[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const save = async () => {
    setBusy(true)
    onError(null)
    try {
      const res = await fetch('/api/press/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const body = await readJson<{ hasShipping: boolean }>(res)
      if (!res.ok) {
        onError(body.error ?? 'Could not save.')
        return
      }
      onNote(
        body.hasShipping
          ? 'Saved.'
          : 'Saved — but the address is incomplete, so ordering stays disabled.',
      )
      onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const field = (key: keyof PressSettingsRow, label: string) => (
    <label key={key} className="block">
      <span className="text-muted-foreground text-xs">{label}</span>
      <input
        value={(draft[key] as string | null) ?? ''}
        onChange={(e) => set(key, e.target.value as never)}
        className={`${FIELD} mt-1`}
      />
    </label>
  )

  return (
    <div className="max-h-[calc(100vh-11rem)] space-y-5 overflow-y-auto rounded-lg border p-3">
      <section>
        <h3 className="font-serif text-sm">Ship to</h3>
        <div className="mt-2 grid grid-cols-2 gap-2">{ADDRESS_FIELDS.map(([k, l]) => field(k, l))}</div>
        <p className="text-muted-foreground mt-1.5 text-xs">
          {effective.hasShipping
            ? 'Complete — orders can be placed.'
            : 'Street, city and postcode are all required; anything less is treated as no address at all.'}
          {env.hasShipping && !row.ship_street1 && ' Currently inherited from PRESS_SHIP_*.'}
        </p>
      </section>

      <section>
        <h3 className="font-serif text-sm">Email on file</h3>
        <label className="mt-2 block">
          <span className="text-muted-foreground text-xs">
            Where the approval link goes, and what the order confirms against
          </span>
          <input
            value={draft.contact_email ?? ''}
            onChange={(e) => set('contact_email', e.target.value)}
            placeholder={env.mailTo ?? 'you@example.com'}
            className={`${FIELD} mt-1`}
          />
        </label>
        {!draft.contact_email && env.mailTo && (
          <p className="text-muted-foreground mt-1 text-xs">Inherited from PRESS_MAIL_TO: {env.mailTo}</p>
        )}
      </section>

      <section>
        <h3 className="font-serif text-sm">Payment</h3>
        <p className="text-muted-foreground mt-1.5 text-xs">
          Lulu bills the card on your Lulu account. No card number is stored here, and there is nowhere
          to put one — which is the point of linking out rather than asking.
        </p>
        <a
          href="https://developers.lulu.com/user/billing"
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs underline"
        >
          Lulu payment settings →
        </a>
      </section>

      <section>
        <h3 className="font-serif text-sm">Print</h3>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-muted-foreground text-xs">Copies per order</span>
            <input
              type="number"
              min={1}
              value={draft.copies}
              onChange={(e) => set('copies', Number(e.target.value))}
              className={`${FIELD} mt-1`}
            />
          </label>
          <label className="block">
            <span className="text-muted-foreground text-xs">Page threshold</span>
            <input
              type="number"
              min={1}
              value={draft.page_threshold}
              onChange={(e) => set('page_threshold', Number(e.target.value))}
              className={`${FIELD} mt-1`}
            />
          </label>
        </div>
        <label className="mt-2 block">
          <span className="text-muted-foreground text-xs">Lulu package id</span>
          <input
            value={draft.lulu_package_id ?? ''}
            onChange={(e) => set('lulu_package_id', e.target.value)}
            placeholder={env.luluPackageId ?? ''}
            className={`${FIELD} mt-1 font-mono`}
          />
        </label>

        {/* This is NOT the control that decides whether money moves, and it
            must not be dressed as one. The Lulu credentials in the environment
            are production credentials, and Lulu's sandbox host 401s against
            them — so a "safe" sandbox order does not spend nothing, it fails.
            The guard is PRESS_ORDER_ENABLED, which is an environment variable
            precisely so it cannot be flipped from the screen that presses the
            button. See 08ff4e8. */}
        <fieldset className="mt-3">
          <legend className="text-muted-foreground text-xs">Environment</legend>
          <div className="mt-1 flex gap-2">
            {([true, false] as const).map((sandbox) => (
              <button
                key={String(sandbox)}
                type="button"
                onClick={() => set('lulu_sandbox', sandbox)}
                aria-pressed={draft.lulu_sandbox === sandbox}
                className={`h-9 flex-1 rounded-lg border px-3 text-sm font-medium ${
                  draft.lulu_sandbox === sandbox
                    ? sandbox
                      ? 'border-foreground bg-accent'
                      : 'border-destructive bg-destructive/10 text-destructive'
                    : 'text-muted-foreground'
                }`}
              >
                {sandbox ? 'Sandbox' : 'Live'}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground mt-1.5 text-xs">
            {draft.lulu_sandbox
              ? 'Sandbox — orders go to Lulu’s test host. Note the credentials on file are production ones, which the sandbox host rejects, so this is likely to fail rather than to be free.'
              : 'Live — orders go to Lulu proper.'}
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            Neither setting is what stops a charge.{' '}
            <code className="bg-muted rounded px-1 py-0.5">PRESS_ORDER_ENABLED=1</code> is required
            before any order is placed at all, and it lives in the environment so it cannot be
            turned on from this form.
          </p>
        </fieldset>
      </section>

      <Button size="lg" className="w-full" disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save settings'}
      </Button>
    </div>
  )
}
