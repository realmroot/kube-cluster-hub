import { ChevronLeft, ChevronRight } from 'lucide-react'

export function PaginationControls({
  page,
  hasNext,
  previous,
  next,
}: {
  page: number
  hasNext: boolean
  previous(): void
  next(): void
}) {
  if (page === 1 && !hasNext) return null
  return (
    <nav className="pagination" aria-label="Pagination">
      <button
        type="button"
        className="button secondary"
        disabled={page === 1}
        onClick={previous}
      >
        <ChevronLeft size={16} /> Previous
      </button>
      <span aria-live="polite">Page {page}</span>
      <button
        type="button"
        className="button secondary"
        disabled={!hasNext}
        onClick={next}
      >
        Next <ChevronRight size={16} />
      </button>
    </nav>
  )
}
