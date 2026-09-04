import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { buildCoverHtml, issueDateline } from '../src/lib/press/compose'
import { renderHtml } from '../src/lib/press/layout/render'
import type { TocEntry } from '../src/lib/press/types'

async function main() {
  const out = process.argv[2]
  await mkdir(out, { recursive: true })
  for (let n = 1; n <= 9; n++) {
    const meta = JSON.parse(await readFile(`${process.env.HOME}/earmarked/.press/issue-${n}/meta.json`, 'utf8'))
    const toc = JSON.parse(await readFile(`${process.env.HOME}/earmarked/.press/issue-${n}/toc.json`, 'utf8')) as TocEntry[]
    const html = buildCoverHtml({
      issueName: meta.name ?? `Issue ${n}`,
      issueNumber: n,
      pageCount: meta.pageCount,
      dateRange: issueDateline(),
      toc,
    })
    const res = await renderHtml(html)
    await writeFile(path.join(out, `cover-${n}.pdf`), res.pdf)
    console.log('issue', n, meta.name ?? '(unnamed)', meta.pageCount + 'pp')
  }
}
main()
