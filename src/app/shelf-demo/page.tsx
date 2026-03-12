'use client'

// Demo page — each book on its own shelf. Delete when done.

const MOCK_BOOKS = [
  { id: '1', title: 'The Secret History', author: 'Donna Tartt', cover_url: 'https://covers.openlibrary.org/b/isbn/9780679410324-M.jpg' },
  { id: '2', title: 'Middlemarch', author: 'George Eliot', cover_url: 'https://covers.openlibrary.org/b/isbn/9780141439549-M.jpg' },
  { id: '3', title: 'Never Let Me Go', author: 'Kazuo Ishiguro', cover_url: 'https://covers.openlibrary.org/b/isbn/9781400078776-M.jpg' },
]

function BookCard({ book }: { book: typeof MOCK_BOOKS[0] }) {
  return (
    <div className="flex gap-3 p-3 rounded-lg border bg-card">
      <div className="shrink-0 w-14 h-20 rounded overflow-hidden bg-muted">
        <img src={book.cover_url} alt={book.title} className="w-full h-full object-cover" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-base leading-tight">{book.title}</div>
        <div className="text-sm text-muted-foreground mt-0.5">{book.author}</div>
        <div className="flex gap-1 mt-2">
          <span className="text-xs px-2 py-0.5 rounded border text-muted-foreground">Good</span>
          <span className="text-xs px-2 py-0.5 rounded border text-muted-foreground">Fine</span>
        </div>
      </div>
    </div>
  )
}

export default function ShelfDemoPage() {
  return (
    <main className="min-h-screen bg-background py-10 px-6">
      <div className="max-w-xl mx-auto">
        <h1 className="font-serif text-3xl font-bold mb-1">Each book, its own shelf</h1>
        <p className="text-muted-foreground mb-8">One plank per book, continuous side walls.</p>

        <div className="bookcase-outer">
          <div className="bookcase-wall-l" />
          <div className="bookcase-scroll">
            {MOCK_BOOKS.map((book) => (
              <div key={book.id}>
                <div className="bookcase-book-bay">
                  <BookCard book={book} />
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

        <p className="text-sm text-muted-foreground mt-12 text-center">
          Delete <code className="text-xs bg-muted px-1 py-0.5 rounded">src/app/shelf-demo/page.tsx</code> once decided.
        </p>
      </div>
    </main>
  )
}
