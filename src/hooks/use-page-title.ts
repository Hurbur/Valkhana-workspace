import { useEffect } from 'react'
import { APP_NAME } from '@/lib/brand'

const BASE_TITLE = APP_NAME

/**
 * Sets document.title for the current page.
 * Usage: usePageTitle('Sessions') → "Sessions — Valkhana"
 */
export function usePageTitle(page: string) {
  useEffect(() => {
    document.title = page ? `${page} — ${BASE_TITLE}` : BASE_TITLE
    return () => {
      document.title = BASE_TITLE
    }
  }, [page])
}
