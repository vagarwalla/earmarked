/**
 * press — the one place that actually launches Chromium.
 *
 * Kept in its own module and imported lazily by `render.ts` so that unit tests
 * (and anything that only needs the HTML) never load the Vivliostyle CLI.
 * Runs in the Fly worker (assumption 6); Chromium does not fit a Vercel
 * function.
 */

import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CSS_FILENAME, IMAGE_DIR, type PdfRenderer, type RenderJob } from './render'

/** Vivliostyle's inline config is a large valibot-inferred type; this is the slice used. */
interface BuildOptions {
  input: string
  output: { path: string; format: 'pdf' }[]
  logLevel: 'silent' | 'info' | 'verbose' | 'debug'
  singleDoc: boolean
  executableBrowser?: string
  timeout?: number
}

type BuildFn = (options: BuildOptions) => Promise<void>

/**
 * Where to find a browser. Vivliostyle downloads its own Playwright Chromium
 * when this is unset; the worker image sets it to the system binary
 * (`@sparticuz/chromium` in serverless, plain chromium in the Fly image).
 */
function executableBrowser(): string | undefined {
  return (
    process.env.PRESS_CHROMIUM_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    undefined
  )
}

/** Minutes, not seconds: a 100-page single-pass issue render is not quick. */
const RENDER_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Write the job to a scratch directory, run `vivliostyle build`, read the PDF
 * back, and clean up. Everything the document references is inside that
 * directory: no network fetch happens at render time.
 */
export const vivliostyleRenderer: PdfRenderer = async (job: RenderJob) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'press-render-'))
  try {
    const htmlPath = path.join(dir, 'index.html')
    await writeFile(htmlPath, job.html, 'utf8')
    await writeFile(path.join(dir, CSS_FILENAME), job.css, 'utf8')

    if (job.images.size > 0) {
      const imageDir = path.join(dir, IMAGE_DIR)
      await mkdir(imageDir, { recursive: true })
      for (const [name, bytes] of job.images) {
        // `imageFileName()` guarantees a flat, separator-free name.
        await writeFile(path.join(imageDir, path.basename(name)), bytes)
      }
    }

    const outPath = path.join(dir, 'interior.pdf')
    const { build } = (await import('@vivliostyle/cli')) as unknown as { build: BuildFn }
    await build({
      input: htmlPath,
      output: [{ path: outPath, format: 'pdf' }],
      logLevel: 'silent',
      singleDoc: true,
      executableBrowser: executableBrowser(),
      timeout: RENDER_TIMEOUT_MS,
    })

    return new Uint8Array(await readFile(outPath))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
