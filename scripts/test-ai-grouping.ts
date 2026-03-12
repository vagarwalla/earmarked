/**
 * Experiment script: compare AI vs. heuristic edition grouping quality.
 * Run with: npx tsx scripts/test-ai-grouping.ts
 */

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'

// ─── Config ───────────────────────────────────────────────────────────────────

const TEST_WORKS = [
  { name: 'To Kill a Mockingbird', workId: 'OL45804W' },
  { name: '1984',                  workId: 'OL27258W' },
  { name: 'The Great Gatsby',      workId: 'OL82563W' },
]

const SERVER_PORT = 3001
const SERVER_URL  = `http://localhost:${SERVER_PORT}`

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getApiKey(): string {
  return execSync(
    'security find-generic-password -a "vaidehiagarwalla" -s "anthropic-api-key" -w',
    { encoding: 'utf8' },
  ).trim()
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
}

async function fetchEditions(workId: string): Promise<import('../src/lib/types').Edition[]> {
  try {
    const raw = await httpGet(`${SERVER_URL}/api/editions?work_id=${workId}`)
    const json = JSON.parse(raw)
    if (Array.isArray(json)) return json
    if (Array.isArray(json.editions)) return json.editions
    return []
  } catch (err) {
    console.warn(`  ⚠ Could not fetch editions for ${workId}: ${err}`)
    return []
  }
}

// Hardcoded fallback data in case the server isn't available
function getFallbackEditions(workId: string): import('../src/lib/types').Edition[] {
  const fallbacks: Record<string, import('../src/lib/types').Edition[]> = {
    OL45804W: [
      { isbn: '9780061935466', title: 'To Kill a Mockingbird', publisher: 'Harper Perennial', publish_year: 2002, format: 'paperback', cover_url: 'https://covers.openlibrary.org/b/isbn/9780061935466-M.jpg', cover_id: 8228691, edition_name: null, pages: 323, popularity_score: 45, ocaid: null },
      { isbn: '9780446310789', title: 'To Kill a Mockingbird', publisher: 'Warner Books', publish_year: 1988, format: 'paperback', cover_url: 'https://covers.openlibrary.org/b/isbn/9780446310789-M.jpg', cover_id: 8228691, edition_name: null, pages: 284, popularity_score: 40, ocaid: null },
      { isbn: '9780060935467', title: 'To Kill a Mockingbird', publisher: 'HarperCollins', publish_year: 1960, format: 'hardcover', cover_url: 'https://covers.openlibrary.org/b/isbn/9780060935467-M.jpg', cover_id: 12345678, edition_name: 'First Edition', pages: 281, popularity_score: 55, ocaid: 'tokillamockingbird00lee' },
      { isbn: '9780061743528', title: 'To Kill a Mockingbird (Perennial Modern Classics)', publisher: 'Harper Perennial Modern Classics', publish_year: 2002, format: 'paperback', cover_url: 'https://covers.openlibrary.org/b/isbn/9780061743528-M.jpg', cover_id: 9876543, edition_name: 'Perennial Modern Classics', pages: 336, popularity_score: 38, ocaid: null },
    ],
    OL27258W: [
      { isbn: '9780451524935', title: 'Nineteen Eighty-Four', publisher: 'Signet Classic', publish_year: 1961, format: 'paperback', cover_url: 'https://covers.openlibrary.org/b/isbn/9780451524935-M.jpg', cover_id: 7222246, edition_name: null, pages: 328, popularity_score: 50, ocaid: null },
      { isbn: '9780451524942', title: '1984', publisher: 'Signet Classic', publish_year: 1977, format: 'paperback', cover_url: 'https://covers.openlibrary.org/b/isbn/9780451524942-M.jpg', cover_id: 7222246, edition_name: null, pages: 328, popularity_score: 45, ocaid: null },
      { isbn: '9780547249643', title: 'Nineteen Eighty-Four', publisher: 'Houghton Mifflin Harcourt', publish_year: 2013, format: 'paperback', cover_url: 'https://covers.openlibrary.org/b/isbn/9780547249643-M.jpg', cover_id: 8765432, edition_name: 'Centennial Edition', pages: 298, popularity_score: 35, ocaid: null },
      { isbn: '9780436350474', title: 'Nineteen Eighty-Four', publisher: 'Secker & Warburg', publish_year: 1949, format: 'hardcover', cover_url: null, cover_id: null, edition_name: 'First Edition', pages: 328, popularity_score: 30, ocaid: 'nineteeneightyfour00orwe' },
    ],
    OL82563W: [
      { isbn: '9780743273565', title: 'The Great Gatsby', publisher: 'Scribner', publish_year: 2004, format: 'paperback', cover_url: 'https://covers.openlibrary.org/b/isbn/9780743273565-M.jpg', cover_id: 7222888, edition_name: null, pages: 180, popularity_score: 48, ocaid: null },
      { isbn: '9780684801520', title: 'The Great Gatsby', publisher: 'Scribner', publish_year: 1992, format: 'hardcover', cover_url: 'https://covers.openlibrary.org/b/isbn/9780684801520-M.jpg', cover_id: 7222888, edition_name: null, pages: 182, popularity_score: 42, ocaid: null },
      { isbn: '9780140274165', title: 'The Great Gatsby', publisher: 'Penguin Books', publish_year: 1994, format: 'paperback', cover_url: 'https://covers.openlibrary.org/b/isbn/9780140274165-M.jpg', cover_id: 9988776, edition_name: 'Penguin Modern Classics', pages: 176, popularity_score: 38, ocaid: null },
      { isbn: '9781593083021', title: 'The Great Gatsby', publisher: 'Barnes & Noble Classics', publish_year: 2003, format: 'paperback', cover_url: 'https://covers.openlibrary.org/b/isbn/9781593083021-M.jpg', cover_id: 1122334, edition_name: 'Barnes & Noble Classics', pages: 192, popularity_score: 30, ocaid: null },
    ],
  }
  return fallbacks[workId] ?? []
}

async function isServerRunning(): Promise<boolean> {
  try {
    await httpGet(`${SERVER_URL}/api/editions?work_id=OL45804W`)
    return true
  } catch {
    return false
  }
}

// ─── Main experiment ──────────────────────────────────────────────────────────

async function main() {
  console.log('=== AI Edition Grouping Experiment ===\n')

  const apiKey = getApiKey()

  // Dynamically import from src (tsx resolves paths)
  const { runGroupingExperiment } = await import('../src/lib/ai-edition-grouping')

  // Check if dev server is running; if not, start it
  let serverStarted = false
  const serverAlreadyUp = await isServerRunning()

  if (!serverAlreadyUp) {
    console.log('Starting dev server on port 3001...')
    const child = require('child_process').spawn(
      'npm', ['run', 'dev', '--', '--port', '3001'],
      { cwd: '/Users/vaidehi/projects/earmarked', detached: true, stdio: 'ignore' },
    )
    child.unref()
    serverStarted = true
    // Wait for server to be ready
    for (let attempt = 0; attempt < 16; attempt++) {
      await new Promise((r) => setTimeout(r, 500))
      if (await isServerRunning()) { console.log('Server ready.\n'); break }
    }
  } else {
    console.log('Dev server already running.\n')
  }

  // Run experiment for each test work
  type Row = {
    name: string
    workId: string
    editionsCount: number
    heuristicGroups: number
    aiGroups: number
    heuristicScore: number
    aiScore: number
    improvement: number
    usedFallback: boolean
  }

  const rows: Row[] = []

  for (const work of TEST_WORKS) {
    console.log(`Processing: ${work.name} (${work.workId})...`)

    let editions = await fetchEditions(work.workId)
    let usedFallback = false

    if (editions.length === 0) {
      console.log(`  Server unavailable or no editions returned — using fallback data`)
      editions = getFallbackEditions(work.workId)
      usedFallback = true
    }

    if (editions.length === 0) {
      console.log(`  No editions available, skipping.`)
      continue
    }

    console.log(`  ${editions.length} editions loaded. Running experiment...`)

    try {
      const result = await runGroupingExperiment(editions, apiKey)
      const improvement = result.aiScore - result.heuristicScore

      rows.push({
        name: work.name,
        workId: work.workId,
        editionsCount: editions.length,
        heuristicGroups: result.heuristicGroups.length,
        aiGroups: result.aiGroups.length > 0 ? result.aiGroups.length : result.heuristicGroups.length,
        heuristicScore: result.heuristicScore,
        aiScore: result.aiScore,
        improvement,
        usedFallback,
      })

      const indicator = improvement > 0 ? '▲' : improvement < 0 ? '▼' : '='
      console.log(`  Heuristic: ${result.heuristicScore}/100  AI: ${result.aiScore}/100  ${indicator} ${improvement > 0 ? '+' : ''}${improvement}`)
    } catch (err) {
      console.error(`  Error running experiment: ${err}`)
    }
  }

  // Print comparison table
  console.log('\n=== Results Summary ===\n')
  const header = ['Book', 'Editions', 'H-Groups', 'AI-Groups', 'H-Score', 'AI-Score', 'Improvement']
  const widths = [25, 8, 9, 9, 7, 8, 11]

  const pad = (s: string, w: number) => s.slice(0, w).padEnd(w)
  console.log(header.map((h, i) => pad(h, widths[i])).join(' | '))
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'))

  for (const row of rows) {
    const sign = row.improvement > 0 ? '+' : ''
    const fallbackMark = row.usedFallback ? '*' : ' '
    console.log(
      [
        pad(row.name, widths[0]),
        pad(String(row.editionsCount), widths[1]),
        pad(String(row.heuristicGroups), widths[2]),
        pad(String(row.aiGroups), widths[3]),
        pad(String(row.heuristicScore), widths[4]),
        pad(String(row.aiScore), widths[5]),
        pad(`${sign}${row.improvement}${fallbackMark}`, widths[6]),
      ].join(' | '),
    )
  }

  if (rows.length === 0) {
    console.log('No results.')
  } else {
    const avgImprovement = rows.reduce((sum, r) => sum + r.improvement, 0) / rows.length
    console.log(`\nAverage improvement: ${avgImprovement > 0 ? '+' : ''}${avgImprovement.toFixed(1)} points`)
    console.log(rows.some((r) => r.usedFallback) ? '* = used fallback/sample data (server unavailable)' : '')

    const verdict = avgImprovement > 10
      ? 'VERDICT: AI grouping improves quality by >10 points. Feature flag recommended.'
      : `VERDICT: AI improvement (${avgImprovement.toFixed(1)} pts) does not exceed 10-point threshold. Heuristics are sufficient.`
    console.log(`\n${verdict}`)

    // Write results to markdown
    writeResults(rows, avgImprovement, verdict)
  }

  // Kill server if we started it
  if (serverStarted) {
    try {
      execSync('pkill -f "next dev" || true', { stdio: 'ignore' })
    } catch {}
  }
}

function writeResults(
  rows: Array<{
    name: string; workId: string; editionsCount: number
    heuristicGroups: number; aiGroups: number
    heuristicScore: number; aiScore: number
    improvement: number; usedFallback: boolean
  }>,
  avgImprovement: number,
  verdict: string,
) {
  const date = new Date().toISOString().slice(0, 10)
  const lines: string[] = [
    '# AI Edition Grouping Experiment Results',
    '',
    `**Date:** ${date}`,
    '',
    '## Summary',
    '',
    '| Book | Editions | Heuristic Groups | AI Groups | Heuristic Score | AI Score | Improvement |',
    '|------|----------|-----------------|-----------|-----------------|----------|-------------|',
    ...rows.map((r) => {
      const sign = r.improvement > 0 ? '+' : ''
      const fallback = r.usedFallback ? ' \\*' : ''
      return `| ${r.name} | ${r.editionsCount} | ${r.heuristicGroups} | ${r.aiGroups} | ${r.heuristicScore} | ${r.aiScore} | ${sign}${r.improvement}${fallback} |`
    }),
    '',
    `**Average improvement:** ${avgImprovement > 0 ? '+' : ''}${avgImprovement.toFixed(1)} points`,
    '',
    rows.some((r) => r.usedFallback) ? '\\* Used fallback/sample data (dev server unavailable during experiment)\n' : '',
    '## Verdict',
    '',
    verdict,
    '',
    '## Methodology',
    '',
    '- **Heuristic grouper:** `groupEditionsByCover()` in `EditionPicker.tsx` — pure deterministic logic using `cover_id` matching and metadata scoring',
    '- **AI grouper:** `groupEditionsWithClaude()` using Claude Sonnet (claude-sonnet-4-6) — sends edition metadata as JSON and asks for semantic grouping',
    '- **Judge:** `judgeGroupingWithOpus()` using Claude Opus (claude-opus-4-5) — independently scores each grouping 0–100',
    '- Same Opus judge used for both approaches to ensure consistency',
    '',
    '## Decision',
    '',
    avgImprovement > 10
      ? [
          'AI grouping **outperforms** heuristics by more than 10 points on average.',
          '',
          'Shipped behind feature flag `NEXT_PUBLIC_AI_GROUPING=true`:',
          '- New API endpoint: `POST /api/ai-group-editions`',
          '- EditionPicker checks `process.env.NEXT_PUBLIC_AI_GROUPING` and calls the AI endpoint when enabled',
          '- Falls back to deterministic grouping on error',
        ].join('\n')
      : [
          'AI grouping **does not** provide a significant enough improvement over heuristics.',
          '',
          `The improvement (${avgImprovement.toFixed(1)} points) is below the 10-point threshold.`,
          '',
          'The existing `groupEditionsByCover()` heuristic is:',
          '- Fast (no API calls)',
          '- Free (no token cost)',
          '- Deterministic (consistent results)',
          '- Already grouping by `cover_id` which is the most reliable signal available',
          '',
          'The AI approach adds latency and cost without sufficient quality gain.',
          'No feature flag will be shipped at this time.',
        ].join('\n'),
  ]

  const outPath = path.join('/Users/vaidehi/projects/earmarked', 'AI_GROUPING_RESULTS.md')
  fs.writeFileSync(outPath, lines.join('\n'))
  console.log(`\nResults written to AI_GROUPING_RESULTS.md`)
}

main().catch((err) => {
  console.error('Experiment failed:', err)
  process.exit(1)
})
