/**
 * Apply a migration to the linked Supabase project.
 *
 * The repo keeps its schema in `supabase/migrations/`, but nothing here ran
 * them: they were applied by hand in the dashboard, so a migration could sit
 * in the repo for months without existing in the database — which is exactly
 * what happened to `009_press_schema.sql`.
 *
 *   npx tsx scripts/db-apply.ts 009_press_schema.sql
 *   npx tsx scripts/db-apply.ts --list      # what the database actually has
 *
 * Auth is the Supabase *management* token (SUPABASE_ACCESS_TOKEN), not the
 * service-role key: creating tables is a project-level operation, not a data
 * one. The project ref comes from `supabase/.temp/project-ref`, written when
 * the CLI last linked this directory.
 *
 * Migrations here are written to be re-runnable (CREATE TABLE IF NOT EXISTS,
 * CREATE OR REPLACE FUNCTION), so applying one twice is a no-op rather than an
 * error — but this prints what it is about to do and refuses anything outside
 * `supabase/migrations/`.
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const MIGRATIONS = path.join(process.cwd(), 'supabase', 'migrations')

function projectRef(): string {
  const file = path.join(process.cwd(), 'supabase', '.temp', 'project-ref')
  if (!existsSync(file)) {
    throw new Error('no supabase/.temp/project-ref — run `supabase link` first')
  }
  return readFileSync(file, 'utf8').trim()
}

function token(): string {
  const t = process.env.SUPABASE_ACCESS_TOKEN
  if (!t) throw new Error('SUPABASE_ACCESS_TOKEN is unset (pull it from Vercel)')
  return t
}

async function query(sql: string): Promise<unknown> {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef()}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    },
  )
  const body = await response.text()
  if (!response.ok) throw new Error(`supabase ${response.status}: ${body.slice(0, 400)}`)
  return body ? JSON.parse(body) : null
}

/** Tables actually present, so "is it applied?" has an answer that is not a guess. */
async function list(): Promise<void> {
  const rows = (await query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  )) as { table_name: string }[]
  console.log(`${rows.length} tables in public:`)
  for (const row of rows) console.log(`  ${row.table_name}`)
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (!arg) throw new Error('usage: db-apply.ts <migration.sql> | --list')
  if (arg === '--list') return list()

  // The filename is joined onto a fixed directory and checked to still be
  // inside it, so `../../etc/passwd` cannot become a migration.
  const file = path.resolve(MIGRATIONS, arg)
  if (!file.startsWith(MIGRATIONS + path.sep)) throw new Error('outside supabase/migrations/')
  if (!existsSync(file)) throw new Error(`no such migration: ${arg}`)

  const sql = readFileSync(file, 'utf8')
  const statements = sql.split(';').filter((s) => s.trim() && !/^\s*--/.test(s)).length
  console.log(`applying ${arg} to ${projectRef()} (~${statements} statements)…`)

  await query(sql)
  console.log('applied.')
}

main().catch((err) => {
  console.error(`db-apply: ${(err as Error).message}`)
  process.exit(1)
})
