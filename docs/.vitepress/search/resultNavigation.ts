import type { Router } from 'vitepress'
import {
  cancelPendingScroll,
  pendingScrollQuery,
  scheduleScrollToMatch
} from '../theme/composables/searchScroll'
import { parseSearchQuery } from './normalization'

export function createSearchNavigation(
  router: Router,
  getQuery: () => string,
  getBase: () => string,
  close: () => void
) {
  function navigateToResult(
    id: string,
    matchContext: string | null = null,
    rawQuery = getQuery()
  ) {
    // Dismiss mobile keyboard immediately by blurring the active input.
    // This triggers a viewport resize so we calculate the correct scroll position.
    if (
      typeof document !== 'undefined' &&
      document.activeElement instanceof HTMLElement
    ) {
      document.activeElement.blur()
    }

    const [path, hash] = id.split('#')
    const query = parseSearchQuery(rawQuery).text
    let decodedHash: string | null = null
    try {
      decodedHash = hash ? decodeURIComponent(hash) : null
    } catch {
      /* malformed URI */
    }

    // Cancel any previous scroll-to-match operation
    cancelPendingScroll()

    if (decodedHash && isSamePageComparison(path)) {
      const targetEl = document.getElementById(decodedHash)
      if (targetEl) {
        close()
        window.history.pushState(null, '', `#${hash}`)
        // Single scroll directly to the matching element. For same-page,
        // use a longer delay on mobile so the virtual keyboard can dismiss
        // and the viewport height can settle before scrolling.
        const isMobile =
          typeof window !== 'undefined' && window.innerWidth < 768
        const delay = isMobile ? 300 : 80
        scheduleScrollToMatch(hash, query, delay, matchContext)
        return
      }
    }

    // Cross-page navigation: store query (with destination path so the router
    // hook can reject it if a different navigation supersedes this one), close
    // modal, start navigation.
    pendingScrollQuery.value = { query, matchContext, path }
    close()
    router.go(id)
  }

  function isSamePageComparison(destPath: string) {
    if (!destPath) return true
    const base = getBase()
    const clean = (p: string) => {
      let cleaned = p
        .replace(/^\.?\//, '/')
        .replace(/\.html$/, '')
        .replace(/\/index$/, '')
        .replace(/\/$/, '')
        .toLowerCase()
      if (
        base !== '/' &&
        cleaned.startsWith(base.toLowerCase().replace(/\/$/, ''))
      ) {
        cleaned = cleaned.slice(base.toLowerCase().replace(/\/$/, '').length)
      }
      return cleaned || '/'
    }
    const current = clean(window.location.pathname) || '/'
    const dest = clean(destPath) || '/'
    return current === dest
  }

  return navigateToResult
}

export function beforeSearchNavigation(to: string) {
  cancelPendingScroll()

  // A search navigation is only the one whose destination matches the
  // pending query's recorded path. Any other navigation (e.g. a sidebar
  // link clicked while the search target is still loading) must clear the
  // stale query so it is never consumed on the wrong page.
  const normalizePath = (p: string) =>
    p
      .replace(/\.html$/, '')
      .replace(/\/index$/, '')
      .replace(/\/$/, '')
      .toLowerCase() || '/'

  let isSearchNav = false
  const pending = pendingScrollQuery.value
  if (pending) {
    try {
      isSearchNav =
        normalizePath(new URL(to, window.location.href).pathname) ===
        normalizePath(new URL(pending.path, window.location.href).pathname)
    } catch {
      // If URL parsing fails, assume this is the search nav rather than
      // dropping the query and silently breaking scroll-to-match.
      isSearchNav = true
    }
  }

  if (!isSearchNav) {
    pendingScrollQuery.value = null
  }
}

export function afterSearchNavigation(hasPendingSearch: boolean) {
  // Scroll to the exact matching text after a search-result navigation
  if (hasPendingSearch) {
    const { query, matchContext } = pendingScrollQuery.value!
    pendingScrollQuery.value = null
    const hash = window.location.hash.slice(1)
    scheduleScrollToMatch(hash, query, 16, matchContext)
  }
}
