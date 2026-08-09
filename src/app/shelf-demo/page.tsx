'use client'

// Design-options gallery — compare shelf treatments side by side.
// Option A (Modern Library) is currently applied to the stack page.
// Delete this page once a direction is settled.

const MOCK_BOOKS = [
  { id: '1', title: 'The Secret History', author: 'Donna Tartt', cover_url: 'https://covers.openlibrary.org/b/isbn/9780679410324-M.jpg' },
  { id: '2', title: 'Middlemarch', author: 'George Eliot', cover_url: 'https://covers.openlibrary.org/b/isbn/9780141439549-M.jpg' },
  { id: '3', title: 'Never Let Me Go', author: 'Kazuo Ishiguro', cover_url: 'https://covers.openlibrary.org/b/isbn/9781400078776-M.jpg' },
]

type Book = typeof MOCK_BOOKS[0]

function Pills() {
  return (
    <div className="flex gap-1 mt-2">
      <span className="text-[11px] px-2 py-0.5 rounded-full border border-border/80 text-muted-foreground">Good</span>
      <span className="text-[11px] px-2 py-0.5 rounded-full border border-border/80 text-muted-foreground">Fine</span>
    </div>
  )
}

function OptionHeader({ tag, title, blurb, applied }: { tag: string; title: string; blurb: string; applied?: boolean }) {
  return (
    <div className="mb-5">
      <p className="overline-label">
        Option {tag}
        {applied && <span className="ml-2 px-1.5 py-0.5 rounded bg-primary text-primary-foreground normal-case tracking-normal">applied</span>}
      </p>
      <h2 className="font-serif text-2xl font-semibold mt-0.5">{title}</h2>
      <p className="text-sm text-muted-foreground mt-1">{blurb}</p>
    </div>
  )
}

/* ——— A. Modern Library (uses the real global classes) ——— */
function ModernLibrary({ books }: { books: Book[] }) {
  return (
    <div>
      {books.map((book) => (
        <div key={book.id} className="shelf-book">
          <div className="flex gap-4 px-1">
            <div className="self-end shrink-0">
              <div className="book-cover w-20 h-30 overflow-hidden bg-muted">
                <img src={book.cover_url} alt={book.title} className="w-full h-full object-cover" />
              </div>
            </div>
            <div className="flex-1 min-w-0 pb-4">
              <div className="font-serif font-medium text-lg leading-snug">{book.title}</div>
              <div className="text-sm text-muted-foreground">{book.author}</div>
              <Pills />
            </div>
          </div>
          <div className="shelf-ledge" />
        </div>
      ))}
    </div>
  )
}

/* ——— B. Cozy Bookcase 2.0 ——— */
function CozyBookcase({ books }: { books: Book[] }) {
  return (
    <div className="v2-case">
      {books.map((book) => (
        <div key={book.id}>
          <div className="v2-bay">
            <img src={book.cover_url} alt={book.title} className="v2-cover" />
            <div className="min-w-0 pb-3">
              <div className="font-serif font-medium text-lg leading-snug text-[oklch(0.95_0.02_80)]">{book.title}</div>
              <div className="text-sm text-[oklch(0.8_0.03_75)]">{book.author}</div>
              <div className="flex gap-1 mt-2">
                <span className="text-[11px] px-2 py-0.5 rounded-full border border-[oklch(0.6_0.05_60)] text-[oklch(0.85_0.03_75)]">Good</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full border border-[oklch(0.6_0.05_60)] text-[oklch(0.85_0.03_75)]">Fine</span>
              </div>
            </div>
          </div>
          <div className="v2-plank" />
        </div>
      ))}
    </div>
  )
}

/* ——— C. Vintage Print ——— */
function VintagePrint({ books }: { books: Book[] }) {
  return (
    <div className="space-y-4">
      {books.map((book, i) => (
        <div key={book.id}>
          <div className="v3-card flex gap-4">
            <img src={book.cover_url} alt={book.title} className="w-16 h-24 object-cover border border-[#c9b795] shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-serif font-semibold text-lg leading-snug text-[#3a2c1c]">{book.title}</div>
              <div className="v3-meta">by {book.author} · acc. no. 00{i + 1}</div>
              <div className="mt-3 flex gap-2 items-center">
                <span className="v3-stamp">Good</span>
                <span className="v3-stamp v3-stamp-alt">Fine</span>
              </div>
            </div>
          </div>
          {i < books.length - 1 && <div className="v3-fleuron">❦</div>}
        </div>
      ))}
    </div>
  )
}

/* ——— D. Warm Modern ——— */
function WarmModern({ books }: { books: Book[] }) {
  return (
    <div className="v4-grid">
      {books.map((book) => (
        <div key={book.id} className="v4-card">
          <img src={book.cover_url} alt={book.title} className="v4-cover" />
          <div className="font-serif font-medium leading-snug mt-3">{book.title}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{book.author}</div>
          <div className="flex gap-1 mt-2.5">
            <span className="v4-chip">Good</span>
            <span className="v4-chip">Fine</span>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ——— Before: the old skeuomorphic bookcase ——— */
function OldBookcase({ books }: { books: Book[] }) {
  return (
    <>
      <div className="bookcase-outer">
        <div className="bookcase-wall-l" />
        <div className="bookcase-scroll">
          {books.map((book) => (
            <div key={book.id}>
              <div className="bookcase-book-bay">
                <div className="flex gap-3 p-3 rounded-lg border bg-card">
                  <div className="shrink-0 w-14 h-20 rounded overflow-hidden bg-muted">
                    <img src={book.cover_url} alt={book.title} className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-base leading-tight">{book.title}</div>
                    <div className="text-sm text-muted-foreground mt-0.5">{book.author}</div>
                    <Pills />
                  </div>
                </div>
              </div>
              <div className="bookcase-shelf-top" />
              <div className="bookcase-shelf-face" />
            </div>
          ))}
        </div>
        <div className="bookcase-wall-r" />
      </div>
      <div className="bookcase-bottom">
        <div className="bookcase-bottom-wall-l" />
        <div className="bookcase-bottom-plank" />
        <div className="bookcase-bottom-wall-r" />
      </div>
    </>
  )
}

const galleryCss = `
/* B. Cozy Bookcase 2.0 */
.v2-case {
  border-radius: 12px;
  background: linear-gradient(180deg, oklch(0.42 0.06 50), oklch(0.34 0.055 47));
  padding: 14px 14px 14px;
  box-shadow: inset 0 2px 5px oklch(1 0 0 / 10%), 0 14px 30px -14px oklch(0.15 0.04 45 / 60%);
}
.v2-bay {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 16px;
  padding: 20px 16px 0;
  background: radial-gradient(120% 90% at 50% 0%, oklch(0.5 0.06 55) 0%, oklch(0.4 0.055 50) 60%, oklch(0.36 0.05 48) 100%);
  box-shadow: inset 0 10px 24px oklch(0 0 0 / 30%), inset 0 -4px 10px oklch(0 0 0 / 20%);
  border-radius: 6px 6px 0 0;
}
.v2-bay::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(60% 70% at 50% 0%, oklch(0.85 0.11 75 / 22%), transparent 65%);
  pointer-events: none;
  border-radius: 6px 6px 0 0;
}
.v2-cover {
  width: 76px;
  height: 112px;
  object-fit: cover;
  border-radius: 2px 4px 4px 2px;
  box-shadow: inset 3px 0 5px -3px oklch(0 0 0 / 50%), 0 2px 3px oklch(0 0 0 / 40%), 8px 12px 20px -6px oklch(0 0 0 / 55%);
}
.v2-plank {
  height: 12px;
  margin: 0 -6px;
  border-radius: 2px;
  background: linear-gradient(oklch(0.56 0.06 58), oklch(0.42 0.055 50));
  box-shadow: 0 3px 0 oklch(0.28 0.045 46), 0 10px 16px -6px oklch(0 0 0 / 50%);
}
.v2-case > div:last-child .v2-plank { margin-bottom: 0; }

/* C. Vintage Print */
.v3-card {
  background: oklch(0.95 0.025 85);
  border: 1px solid oklch(0.82 0.04 80);
  border-radius: 2px;
  padding: 16px 18px 16px 26px;
  background-image:
    linear-gradient(to right, transparent 17px, oklch(0.6 0.14 25 / 35%) 17px, oklch(0.6 0.14 25 / 35%) 18px, transparent 18px),
    repeating-linear-gradient(transparent 0 26px, oklch(0.65 0.06 240 / 25%) 26px 27px);
  box-shadow: 0 1px 3px oklch(0.3 0.04 60 / 15%);
}
.v3-meta {
  font-family: var(--font-geist-mono, ui-monospace, monospace);
  font-size: 12px;
  color: oklch(0.45 0.04 60);
  margin-top: 2px;
}
.v3-stamp {
  display: inline-block;
  border: 2px solid oklch(0.45 0.13 25);
  color: oklch(0.45 0.13 25);
  padding: 1px 7px;
  font-family: var(--font-geist-mono, ui-monospace, monospace);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  border-radius: 2px;
  transform: rotate(-3deg);
  opacity: 0.85;
}
.v3-stamp-alt { transform: rotate(2deg); border-color: oklch(0.45 0.06 250); color: oklch(0.45 0.06 250); }
.v3-fleuron { text-align: center; color: oklch(0.55 0.06 60); font-size: 14px; padding: 6px 0; }
.dark .v3-card { background: oklch(0.88 0.03 85); }

/* D. Warm Modern */
.v4-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.v4-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 14px;
  box-shadow: 0 2px 6px oklch(0.5 0.1 60 / 8%), 0 12px 28px -14px oklch(0.5 0.1 60 / 25%);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.v4-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 4px 10px oklch(0.7 0.15 70 / 15%), 0 18px 36px -12px oklch(0.65 0.15 65 / 35%);
}
.v4-cover {
  width: 100%;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  border-radius: 10px;
  box-shadow: 0 4px 10px oklch(0.3 0.05 55 / 25%);
}
.v4-chip {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  background: linear-gradient(135deg, oklch(0.75 0.13 70 / 18%), oklch(0.65 0.15 45 / 18%));
  color: oklch(0.5 0.11 55);
  border: 1px solid oklch(0.75 0.1 65 / 40%);
}
.dark .v4-chip { color: oklch(0.8 0.1 70); }
`

export default function ShelfDesignOptionsPage() {
  return (
    <main className="min-h-screen bg-background py-12 px-6">
      <style>{galleryCss}</style>
      <div className="max-w-xl mx-auto space-y-16">
        <div>
          <p className="overline-label">Earmarked · design studio</p>
          <h1 className="font-serif text-3xl font-bold mt-1 mb-2">Shelf design options</h1>
          <p className="text-muted-foreground">
            Four directions for the shelves page, all keeping the bookish charm.
            Option A is live on the stack page now — any of the others can be swapped in.
          </p>
        </div>

        <section>
          <OptionHeader
            tag="A"
            title="Modern Library"
            blurb="Editorial and quiet — covers rest on a thin wooden ledge, the shelf is a line rather than furniture. Fraunces serif, hairline borders, paper-grain background."
            applied
          />
          <ModernLibrary books={MOCK_BOOKS} />
        </section>

        <section>
          <OptionHeader
            tag="B"
            title="Cozy Bookcase 2.0"
            blurb="The skeuomorphic bookcase, rebuilt: richer walnut, warm lamplight glow in each bay, covers standing tall on real planks. Maximally cozy."
          />
          <CozyBookcase books={MOCK_BOOKS} />
        </section>

        <section>
          <OptionHeader
            tag="C"
            title="Vintage Print"
            blurb="Library ephemera — checkout-card rows with ruled lines, a red margin rule, rotated condition stamps, and fleurons between books."
          />
          <VintagePrint books={MOCK_BOOKS} />
        </section>

        <section>
          <OptionHeader
            tag="D"
            title="Warm Modern"
            blurb="The most contemporary: cover-forward grid, big radii, amber-terracotta accents, cards that lift on hover. Bookish through warmth, not wood."
          />
          <WarmModern books={MOCK_BOOKS} />
        </section>

        <section>
          <OptionHeader
            tag="0"
            title="Before — the old bookcase"
            blurb="The previous design, kept here for comparison."
          />
          <OldBookcase books={MOCK_BOOKS} />
        </section>

        <p className="text-sm text-muted-foreground text-center pb-4">
          Delete <code className="text-xs bg-muted px-1 py-0.5 rounded">src/app/shelf-demo/page.tsx</code> once a direction is settled.
        </p>
      </div>
    </main>
  )
}
