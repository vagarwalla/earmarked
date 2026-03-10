export async function register() {
  // Only run on the Node.js server runtime (not in the Edge runtime)
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Skip auto-migration on Vercel — the Management API is unreachable from
  // serverless functions, causing ETIMEDOUT on every cold start.  Run migrations
  // manually via the Supabase dashboard or a local `npx ts-node` script instead.
  if (process.env.VERCEL) {
    console.log('[instrumentation] Running on Vercel — skipping auto-migration.')
    return
  }

  try {
    const { applyMigrations } = await import('./lib/migrate')
    await applyMigrations()
  } catch (err) {
    // Migration errors must not crash the server — log and continue
    console.error('[instrumentation] Migration failed, server will start anyway:', err)
  }
}
