'use client'

/**
 * Read a JSON body that might not be JSON.
 *
 * These routes answer with plain text (the PRESS_UI_ENABLED 404), HTML (the
 * password challenge, Next's error page) and JSON, and an unguarded
 * `res.json()` on the first two rejects — skipping the error handler entirely
 * and leaving the button looking like it did nothing at all.
 */
export async function readJson<T>(res: Response): Promise<Partial<T> & { error?: string }> {
  try {
    return (await res.json()) as Partial<T> & { error?: string }
  } catch {
    return { error: res.ok ? undefined : `${res.status} ${res.statusText || 'request failed'}` } as Partial<T> & { error?: string }
  }
}
