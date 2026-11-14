import type { ModalTranslations } from 'vitepress/types/local-search'
import type { Ref } from 'vue'
import type { LocalSearchResult, SearchMetadata, SidebarItem } from './types'
import localSearchIndex from '@localSearchIndex'
import {
  computedAsync,
  onKeyStroke,
  useEventListener,
  useLocalStorage,
  useScrollLock,
  useSessionStorage,
  watchDebounced
} from '@vueuse/core'
import { useFocusTrap } from '@vueuse/integrations/useFocusTrap'
import Mark from 'mark.js/src/vanilla.js'
import { inBrowser, useRouter } from 'vitepress'
import { useData } from 'vitepress/dist/client/theme-default/composables/data'
import { createSearchTranslate } from 'vitepress/dist/client/theme-default/support/translation'
import {
  computed,
  markRaw,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  triggerRef,
  watch,
  watchEffect
} from 'vue'
import { sidebar } from '../shared'
import {
  sanitizeRichHtml,
  sanitizeSearchHtml
} from '../theme/composables/sanitize'
import {
  formMarkRegex,
  getRelativeOffsetTop,
  groupMarks,
  mergeNearbyMarks
} from './matchHighlighting'
import { createSearchNavigation } from './resultNavigation'
import {
  excerptCache,
  fetchExcerpt,
  filterResults,
  lookupExcerptText,
  processExcerpts
} from './resultPreviews'
import { createSearchEngine, loadSearchIndex } from './searchEngine'
import {
  buildUrlQuery,
  looksLikeUrlQuery,
  normalizeUrlSearchValue,
  urlMatchesNormalizedUrl
} from './urlMatching'

const RESULTS_PAGE_SIZE = 16
const MAX_RECENT_SEARCHES = 20
const SEARCH_DEBOUNCE_MS = 350
const MIN_CANDIDATE_POOL = 32

// Persisted results state across mount/unmount of the modal
const globalLastQuery = ref('')
const globalLastFuzzy = ref(false)
const globalLastUrlSearch = ref(false)
const globalLastDetailed = ref(false)
const globalResults = ref<LocalSearchResult[]>([])
const globalAllResults = ref<LocalSearchResult[]>([])
const globalTotalResultsCount = ref(0)
const globalResultMarks = ref<Map<number, HTMLElement[][]>>(new Map())
const globalCurrentMarkIndex = ref<Map<number, number>>(new Map())
const globalResultLimit = ref(RESULTS_PAGE_SIZE)
const globalUsedSubstringExpansion = ref(false)
const globalMayHaveMore = ref(false)

export function useSearchModal() {
  const show = ref(true)

  function close() {
    show.value = false
  }

  const el = shallowRef<HTMLElement>()
  const resultsEl = shallowRef<HTMLElement>()

  /* Search */

  const searchIndexData = shallowRef(localSearchIndex)

  // Hot Module Replacement - updates search index without full page reload during development
  if (import.meta.hot) {
    import.meta.hot.accept('@localSearchIndex', (m: { default: unknown }) => {
      if (m) {
        searchIndexData.value = m.default as typeof localSearchIndex
      }
    })
  }

  const vitePressData = useData()
  const { activate } = useFocusTrap(el, {
    allowOutsideClick: true,
    clickOutsideDeactivates: true,
    escapeDeactivates: true
  })
  const { localeIndex, theme } = vitePressData

  /**
   * Fuzzy search toggle state.
   * - false: Exact phrase matching (default)
   * - true: Fuzzy matching with typo tolerance and multi-word queries
   * Persisted in localStorage for user preference across sessions.
   */
  const isFuzzySearch = useLocalStorage('vitepress:local-search-fuzzy', false)
  // Opt-in: also match results by the URLs (link hrefs) they contain. Default off.
  const isUrlSearch = useLocalStorage('vitepress:local-search-url', false)

  // Section ids are the first path segment of a result id: "/gaming#anchor" -> "/gaming".
  function resultCategoryOf(id: string): string {
    const segment = id
      .split('#')[0]
      .replace(/\.html$/, '')
      .split('/')
      .filter(Boolean)[0]
    return segment ? `/${segment}` : '/'
  }

  function computeCategoryCounts(results: LocalSearchResult[]) {
    const counts = new Map<string, number>()
    for (const r of results) {
      const category = resultCategoryOf(r.id)
      counts.set(category, (counts.get(category) ?? 0) + 1)
    }
    return counts
  }

  // Categories and labels come from the sidebar, which is static at build time,
  // so this runs once. Wiki and Tools entries pointing at the same page
  // (e.g. /audio#audio-tools) keep the first (Wiki) label.
  const searchCategories = (() => {
    const entries: { id: string; label: string }[] = []
    const seen = new Set<string>()
    const collect = (items: SidebarItem[]) => {
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        if (Array.isArray(item.items)) {
          collect(item.items)
        } else if (typeof item.link === 'string' && item.link.startsWith('/')) {
          const id = resultCategoryOf(item.link)
          if (seen.has(id)) continue
          seen.add(id)
          entries.push({
            id,
            label: (item.text ?? '').replace(/<[^>]*>/g, '').trim()
          })
        }
      }
    }
    collect(Array.isArray(sidebar) ? sidebar : [])
    return entries
  })()

  const activeCategory = ref('')

  // Chips count what's actually displayed (after excerpt filtering in
  // detailed view), not the raw pool. Rebuilt in watcher 2 when the
  // underlying result set changes.
  const categoryCounts = shallowRef<Map<string, number>>(new Map())

  const totalCategoryCount = computed(() =>
    [...categoryCounts.value.values()].reduce((sum, n) => sum + n, 0)
  )

  const visibleCategories = computed(() =>
    searchCategories
      .filter(
        (c) =>
          (categoryCounts.value.get(c.id) ?? 0) > 0 ||
          activeCategory.value === c.id
      )
      // Most matches first; ties keep the sidebar order (stable sort).
      .sort(
        (a, b) =>
          (categoryCounts.value.get(b.id) ?? 0) -
          (categoryCounts.value.get(a.id) ?? 0)
      )
  )

  const activeCategoryLabel = computed(
    () =>
      searchCategories.find((c) => c.id === activeCategory.value)?.label ?? ''
  )

  function selectCategory(id: string) {
    activeCategory.value = activeCategory.value === id ? '' : id
    resultLimit.value = RESULTS_PAGE_SIZE
    shouldResetScroll.value = true
  }

  function onCategoryWheel(event: WheelEvent) {
    const el = event.currentTarget as HTMLElement
    if (el.scrollWidth <= el.clientWidth) return
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
    event.preventDefault()
    el.scrollLeft += event.deltaY
  }

  const customMetadata = shallowRef<SearchMetadata>({})

  const searchIndex = computedAsync(async () => {
    const rawIndex = (await searchIndexData.value[localeIndex.value]?.())
      ?.default
    if (!rawIndex) return null
    const options =
      theme.value.search?.provider === 'local'
        ? theme.value.search.options?.miniSearch
        : undefined
    const loaded = loadSearchIndex(
      rawIndex,
      options?.options,
      options?.searchOptions
    )
    if (!loaded) return null
    customMetadata.value = loaded.metadata
    return markRaw(loaded.index)
  })

  const engine = computed(() =>
    searchIndex.value
      ? createSearchEngine(
          searchIndex.value,
          customMetadata.value,
          Array.isArray(sidebar) ? sidebar : []
        )
      : null
  )

  const disableQueryPersistence = computed(() => {
    return (
      theme.value.search?.provider === 'local' &&
      theme.value.search.options?.disableQueryPersistence === true
    )
  })

  const filterText = disableQueryPersistence.value
    ? ref('')
    : useSessionStorage('vitepress:local-search-filter', '')

  // URL matching also kicks in automatically when the query *looks* like a URL even with the manual toggle off.
  const urlSearchAuto = computed(
    () =>
      !isUrlSearch.value &&
      !!filterText.value &&
      looksLikeUrlQuery(filterText.value)
  )

  const showDetailedList = useLocalStorage(
    'vitepress:local-search-detailed-list',
    theme.value.search?.provider === 'local' &&
      theme.value.search.options?.detailedView === true
  )

  const disableDetailedView = computed(() => {
    return (
      theme.value.search?.provider === 'local' &&
      (theme.value.search.options?.disableDetailedView === true ||
        theme.value.search.options?.detailedView === false)
    )
  })

  const buttonText = computed(() => {
    const options = theme.value.search?.options ?? theme.value.algolia

    return (
      options?.locales?.[localeIndex.value]?.translations?.button?.buttonText ||
      options?.translations?.button?.buttonText ||
      'Search'
    )
  })

  watchEffect(() => {
    if (disableDetailedView.value) {
      showDetailedList.value = false
    }
  })

  function matchesGlobalState() {
    return (
      inBrowser &&
      filterText.value === globalLastQuery.value &&
      isFuzzySearch.value === globalLastFuzzy.value &&
      isUrlSearch.value === globalLastUrlSearch.value &&
      showDetailedList.value === globalLastDetailed.value
    )
  }

  const isRestoring = matchesGlobalState()

  const results: Ref<LocalSearchResult[]> = shallowRef(
    isRestoring ? globalResults.value : []
  )
  const allResults = shallowRef<LocalSearchResult[]>(
    isRestoring ? globalAllResults.value : []
  )
  const totalResultsCount = ref(isRestoring ? globalTotalResultsCount.value : 0)
  const resultMarks = shallowRef<Map<number, HTMLElement[][]>>(
    isRestoring ? new Map(globalResultMarks.value) : new Map()
  )
  const currentMarkIndex = shallowRef<Map<number, number>>(
    isRestoring ? new Map(globalCurrentMarkIndex.value) : new Map()
  )

  const enableNoResults = ref(isRestoring)
  const isSearching = ref(!isRestoring && !!filterText.value)
  const usedSubstringExpansion = ref(
    isRestoring ? globalUsedSubstringExpansion.value : false
  )
  const resultLimit = ref(
    isRestoring ? globalResultLimit.value : RESULTS_PAGE_SIZE
  )
  const mayHaveMore = ref(isRestoring ? globalMayHaveMore.value : false)

  const recentSearches = useLocalStorage<string[]>(
    'vitepress:local-search-recent',
    []
  )

  const shouldResetScroll = ref(false)

  const autoSuggestions = computed(() => {
    if (!filterText.value || results.value.length > 0 || !searchIndex.value)
      return []

    return engine.value?.suggest(filterText.value) ?? []
  })

  watch([filterText, isFuzzySearch, isUrlSearch], () => {
    activeCategory.value = ''
    enableNoResults.value = false
    resultLimit.value = RESULTS_PAGE_SIZE
    shouldResetScroll.value = true
  })

  const cache = excerptCache

  /**
   * Main search handler - debounced to avoid excessive re-renders while typing.
   * Watches: search index, filter text, detail view toggle, and fuzzy search mode.
   */
  watch(
    [filterText, isFuzzySearch, isUrlSearch, showDetailedList, searchIndex],
    () => {
      isSearching.value = !matchesGlobalState() && !!filterText.value
    },
    { immediate: true }
  )

  // Rendered excerpts belong to the current locale/index, including during HMR.
  watch(searchIndex, () => cache.clear(), { immediate: true })

  // 1. Debounced Search watcher: Only runs the index query and gets the raw matching results list
  watchDebounced(
    () =>
      [
        searchIndex.value,
        filterText.value,
        isFuzzySearch.value,
        isUrlSearch.value,
        showDetailedList.value
      ] as const,
    async ([index, filterTextValue], old, onCleanup) => {
      const indexChanged = old && old[0] !== undefined && old[0] !== index
      if (!indexChanged && matchesGlobalState()) {
        return
      }

      let canceled = false
      onCleanup(() => {
        canceled = true
      })

      if (!index || !filterTextValue.trim()) {
        allResults.value = []
        totalResultsCount.value = 0
        mayHaveMore.value = false

        // Clear global cache for empty query
        globalAllResults.value = []
        globalTotalResultsCount.value = 0
        globalLastQuery.value = ''
        globalResults.value = []
        globalResultMarks.value = new Map()
        globalCurrentMarkIndex.value = new Map()
        globalMayHaveMore.value = false
        return
      }

      const { results: boostedResults, usedSubstringExpansion: expanded } =
        engine.value!.search(filterTextValue, {
          fuzzy: isFuzzySearch.value,
          urls: isUrlSearch.value
        })
      usedSubstringExpansion.value = expanded

      enableNoResults.value = true

      if (canceled) return
      allResults.value = boostedResults

      // Save to global cache (totalResultsCount is set by watcher 2 after excerpt filtering)
      globalAllResults.value = boostedResults
      globalLastQuery.value = filterTextValue
      globalLastFuzzy.value = isFuzzySearch.value
      globalLastUrlSearch.value = isUrlSearch.value
      globalLastDetailed.value = showDetailedList.value
      globalUsedSubstringExpansion.value = usedSubstringExpansion.value
    },
    { debounce: SEARCH_DEBOUNCE_MS, immediate: true }
  )

  // 2. Synchronous Watcher: Handles slicing, excerpt fetching, DOM rendering, and highlight marking instantly
  watch(
    () =>
      [
        allResults.value,
        resultLimit.value,
        showDetailedList.value,
        activeCategory.value
      ] as const,
    async ([allRes, limit, showDetailedListValue], old, onCleanup) => {
      let canceled = false
      onCleanup(() => {
        canceled = true
      })

      // Only rebuild chips when the result set itself changed (new query,
      // pagination, detail view), switching category doesn't.
      const resultSetChanged =
        !old ||
        allRes !== old[0] ||
        limit !== old[1] ||
        showDetailedListValue !== old[2]

      // Section filter slices the in-memory results before pagination; switching
      // sections doesn't re-run the index query
      const category = activeCategory.value
      const scopedResults = category
        ? allRes.filter((r) => resultCategoryOf(r.id) === category)
        : allRes

      const sliced = scopedResults.slice(0, limit)
      if (sliced.length === 0) {
        results.value = []
        resultMarks.value = new Map()
        currentMarkIndex.value = new Map()
        if (!(old === undefined && filterText.value)) {
          isSearching.value = false
        }
        totalResultsCount.value = 0
        mayHaveMore.value = false
        if (resultSetChanged) {
          categoryCounts.value = computeCategoryCounts(allRes)
        }
        return
      }

      const terms = new Set<string>()

      const mapResult = (r: LocalSearchResult, text: string) => {
        if (isFuzzySearch.value) {
          for (const term of Object.keys(r.match || {})) {
            terms.add(term)
          }
        }
        return { ...r, text }
      }

      let finalResults: LocalSearchResult[]
      let totalCount: number
      let mayHaveMoreValue = false
      // Only the exact + detailed branch sets this, after excerpt filtering.
      // Null = the raw pool is what's shown, so chips count from allRes.
      let postFiltered: LocalSearchResult[] | null = null

      const isExactSearch =
        !isFuzzySearch.value && !usedSubstringExpansion.value

      if (isExactSearch) {
        // Exact mode now runs in both views. We fetch a dynamic candidate pool
        // so contiguous phrase matches don't get ranked away, and the list (and
        // chips) look the same in compact and detailed.
        const candidateLimit = Math.max(MIN_CANDIDATE_POOL, limit * 2)
        const candidates = scopedResults.slice(0, candidateLimit)

        const candidatesToFetch = candidates.filter((r) => {
          const [id] = r.id.split('#')
          return !cache.has(id)
        })
        const mods = await Promise.all(
          candidatesToFetch.map((r) => fetchExcerpt(r.id))
        )
        if (canceled) return

        await processExcerpts(mods, vitePressData, () => canceled)
        if (canceled) return

        const mapped = candidates.map((r) => {
          const text = lookupExcerptText(r.id)
          return mapResult(r, text)
        })

        const filtered = filterResults(mapped, filterText.value)
        postFiltered = filtered
        finalResults = filtered.slice(0, limit)
        totalCount = filtered.length
        // Untested remainder beyond the candidate pool may contain more matches;
        // expanding resultLimit re-runs this branch with a larger candidateLimit.
        mayHaveMoreValue = scopedResults.length > candidateLimit
      } else {
        // Fuzzy search or substring expansion: slice to limit directly
        const slicedToFetch = showDetailedListValue
          ? sliced.filter((r) => {
              const [id] = r.id.split('#')
              return !cache.has(id)
            })
          : []
        const mods = await Promise.all(
          slicedToFetch.map((r) => fetchExcerpt(r.id))
        )
        if (canceled) return

        await processExcerpts(mods, vitePressData, () => canceled)
        if (canceled) return

        const mapped = sliced.map((r) => {
          const text = showDetailedListValue ? lookupExcerptText(r.id) : ''
          return mapResult(r, text)
        })

        finalResults = mapped
        totalCount = mapped.length + Math.max(0, scopedResults.length - limit)
      }

      if (resultSetChanged) {
        // Category active = excerpt filter only covers that category, so count
        // the raw pool or the other chips disappear and you can't switch back.
        // Without a category, the post filtered set is what's shown (fuzzy/compact
        // don't filter, so allRes is it).
        categoryCounts.value = computeCategoryCounts(
          postFiltered && !category ? postFiltered : allRes
        )
      }

      if (!isFuzzySearch.value) {
        terms.add(filterText.value)
      }

      results.value = finalResults
      totalResultsCount.value = totalCount
      mayHaveMore.value = mayHaveMoreValue

      await nextTick()
      if (canceled) return

      await new Promise<void>((resolve) => {
        if (!resultsEl.value) {
          resolve()
          return
        }
        const targets = resultsEl.value.querySelectorAll(
          '.result-item:not(.result-list-leave-active) .titles, .result-item:not(.result-list-leave-active) .excerpt'
        )
        if (targets.length === 0) {
          resolve()
          return
        }
        const m = new Mark(Array.from(targets))
        m.unmark({
          done: () => {
            m.markRegExp(
              formMarkRegex(terms, filterText.value, isFuzzySearch.value),
              {
                exclude: ['.title-icon'],
                acrossElements: false,
                done: () => resolve()
              }
            )
          }
        })
      })
      if (canceled) return

      if (isFuzzySearch.value) {
        mergeNearbyMarks(resultsEl.value)
      }

      // URL matches match on a link's href, which mark.js can't highlight because
      // the query text isn't in the visible link text. Highlight the specific
      // link(s) in the excerpt whose href matched the query.
      if (finalResults.some((r) => r.urlMatched)) {
        const urlQuery = buildUrlQuery(filterText.value)
        for (const r of finalResults) {
          if (!r.urlMatched || !urlQuery) continue
          const item = resultsEl.value?.querySelector(
            `[data-id="${CSS.escape(r.id)}"]`
          )
          if (!item) continue
          const anchors =
            item.querySelectorAll<HTMLAnchorElement>('.excerpt a[href]')
          for (const anchor of anchors) {
            const href = anchor.getAttribute('href') ?? ''
            if (
              !urlMatchesNormalizedUrl(normalizeUrlSearchValue(href), urlQuery)
            )
              continue
            if (anchor.querySelector('mark[data-markjs="true"]')) continue
            const mark = document.createElement('mark')
            mark.setAttribute('data-markjs', 'true')
            mark.append(...anchor.childNodes)
            anchor.appendChild(mark)
          }
        }
      }

      const excerpts = Array.from(
        resultsEl.value?.querySelectorAll(
          '.result-item:not(.result-list-leave-active) .result .excerpt'
        ) ?? []
      ) as HTMLElement[]
      const scrollTargets: { excerpt: HTMLElement; scrollTop: number }[] = []
      for (const excerpt of excerpts) {
        const markElement = excerpt.querySelector(
          'mark[data-markjs="true"]'
        ) as HTMLElement | null
        if (markElement) {
          const markRelTop = getRelativeOffsetTop(markElement, excerpt)
          const scrollTop =
            markRelTop -
            (excerpt.clientHeight || 80) / 2 +
            markElement.offsetHeight / 2
          scrollTargets.push({ excerpt, scrollTop })
        }
      }
      for (const { excerpt, scrollTop } of scrollTargets) {
        excerpt.scrollTop = scrollTop
      }

      /**
       * Custom feature: Initialize match navigation state.
       */
      const newResultMarks = new Map<number, HTMLElement[][]>()
      const newCurrentMarkIndex = new Map<number, number>()

      results.value.forEach((r, index) => {
        const item = resultsEl.value?.querySelector(
          `[data-id="${CSS.escape(r.id)}"]`
        )
        const marks = Array.from(
          item?.querySelectorAll('.excerpt mark[data-markjs="true"]') ?? []
        ) as HTMLElement[]
        if (marks.length > 0) {
          newResultMarks.set(index, groupMarks(marks))
          newCurrentMarkIndex.set(index, 0)
        }
      })
      resultMarks.value = newResultMarks
      currentMarkIndex.value = newCurrentMarkIndex

      if (resultsEl.value && shouldResetScroll.value) {
        resultsEl.value.scrollTop = 0
        shouldResetScroll.value = false
      }

      isSearching.value = false

      // Save to global cache
      globalResults.value = finalResults
      globalTotalResultsCount.value = totalCount
      globalResultMarks.value = resultMarks.value
      globalCurrentMarkIndex.value = currentMarkIndex.value
      globalResultLimit.value = limit
      globalMayHaveMore.value = mayHaveMoreValue
    },
    { immediate: true }
  )

  /**
   * Merges adjacent highlight marks that are visually close together.
   * This reduces the number of navigation stops in fuzzy mode where
   * each individual word match would otherwise be a separate highlight.
   *
   * Merging criteria (tuned via constants at top of file):
   * - Marks must be on the same line (within MARK_SAME_LINE_THRESHOLD_PX)
   * - Marks must be close horizontally (< MARK_MERGE_DISTANCE_PX)
   */
  /**
   * Custom feature: Navigate to the next highlighted match in the current result.
   * Cycles back to the first match when reaching the end.
   * Smoothly scrolls the excerpt to center the highlighted match.
   */
  function nextMatch(index: number) {
    if (selectedIndex.value !== index) {
      selectedIndex.value = index
    }
    const marks = resultMarks.value.get(index)
    let curr = currentMarkIndex.value.get(index) ?? 0
    if (!marks) return

    // Remove 'current' class from previous group of marks
    marks[curr]?.forEach((m) => m.classList.remove('current'))

    curr = (curr + 1) % marks.length
    currentMarkIndex.value.set(index, curr)
    triggerRef(currentMarkIndex)

    // Add 'current' class to new group of marks
    const newGroup = marks[curr]
    if (newGroup && newGroup.length > 0) {
      newGroup.forEach((m) => m.classList.add('current'))
      const newMark = newGroup[0]
      const excerpt = newMark.closest<HTMLElement>('.excerpt')
      if (excerpt) {
        const markRelTop = getRelativeOffsetTop(newMark, excerpt)
        excerpt.scrollTo({
          top: markRelTop - excerpt.clientHeight / 2 + newMark.offsetHeight / 2,
          behavior: 'smooth'
        })
      }
    }
  }

  /**
   * Custom feature: Navigate to the previous highlighted match in the current result.
   * Cycles to the last match when going before the first.
   * Smoothly scrolls the excerpt to center the highlighted match.
   */
  function prevMatch(index: number) {
    if (selectedIndex.value !== index) {
      selectedIndex.value = index
    }
    const marks = resultMarks.value.get(index)
    let curr = currentMarkIndex.value.get(index) ?? 0
    if (!marks) return

    // Remove 'current' class from previous group of marks
    marks[curr]?.forEach((m) => m.classList.remove('current'))

    curr = (curr - 1 + marks.length) % marks.length
    currentMarkIndex.value.set(index, curr)
    triggerRef(currentMarkIndex)

    // Add 'current' class to new group of marks
    const newGroup = marks[curr]
    if (newGroup && newGroup.length > 0) {
      newGroup.forEach((m) => m.classList.add('current'))
      const newMark = newGroup[0]
      const excerpt = newMark.closest<HTMLElement>('.excerpt')
      if (excerpt) {
        const markRelTop = getRelativeOffsetTop(newMark, excerpt)
        excerpt.scrollTo({
          top: markRelTop - excerpt.clientHeight / 2 + newMark.offsetHeight / 2,
          behavior: 'smooth'
        })
      }
    }
  }

  /* Search input focus */

  const searchInput = ref<HTMLInputElement>()
  const disableReset = computed(() => {
    return !filterText.value
  })
  function focusSearchInput(select = true) {
    searchInput.value?.focus()
    if (select) {
      searchInput.value?.select()
    }
  }

  function applySuggestion(s: string) {
    filterText.value = s
    focusSearchInput(false)
  }

  function onSearchBarClick(event: PointerEvent) {
    if (event.pointerType === 'mouse') {
      focusSearchInput(false)
    }
  }

  /* Search keyboard selection */

  const selectedIndex = ref(-1)
  const disableMouseOver = ref(true)
  // Flag to track whether the selection was driven by keyboard navigation.
  // Used to limit excerpt smooth-scrolling strictly to keyboard events to prevent scroll/hover performance lag.
  const isKeyboardAction = ref(false)

  watch(results, (newR, oldR) => {
    // Show-more expansion: first result is unchanged and list grew — keep current position
    if (
      oldR.length > 0 &&
      newR.length > oldR.length &&
      newR[0]?.id === oldR[0]?.id
    )
      return

    // Default to -1 (no selection) so first result is not pre-selected while typing
    let newIdx = -1
    if (
      oldR.length > 0 &&
      selectedIndex.value >= 0 &&
      selectedIndex.value < oldR.length
    ) {
      const prevSelectedId = oldR[selectedIndex.value]?.id
      const foundIdx = newR.findIndex((r) => r.id === prevSelectedId)
      if (foundIdx !== -1) {
        newIdx = foundIdx
      }
    }
    selectedIndex.value = newIdx
    scrollToSelectedResult()
  })

  function scrollToSelectedResult() {
    nextTick(() => {
      // Avoid querying transitioning/leaving items to prevent scroll-into-view selector collisions.
      const selectedEl = resultsEl.value?.querySelector(
        '.result-item:not(.result-list-leave-active) .result.selected'
      )
      selectedEl?.scrollIntoView({ block: 'nearest' })
    })
  }

  watch(selectedIndex, (newIdx, oldIdx) => {
    if (oldIdx !== undefined && oldIdx >= 0) {
      const marks = resultMarks.value.get(oldIdx)
      const curr = currentMarkIndex.value.get(oldIdx) ?? 0
      marks?.[curr]?.forEach((m) => m.classList.remove('current'))
    }

    if (newIdx !== undefined && newIdx >= 0) {
      // Add current class and scroll active match into view
      const isKb = isKeyboardAction.value
      isKeyboardAction.value = false

      nextTick(() => {
        const updatedMarks = resultMarks.value.get(newIdx)
        const updatedCurr = currentMarkIndex.value.get(newIdx) ?? 0
        updatedMarks?.[updatedCurr]?.forEach((m) => m.classList.add('current'))

        const activeMark = updatedMarks?.[updatedCurr]?.[0]
        const excerpt = activeMark?.closest<HTMLElement>('.excerpt')
        // Only smooth-scroll excerpt to center match if selection was keyboard-driven (prevents layout thrashing on hover)
        if (isKb && excerpt && activeMark) {
          const markRelTop = getRelativeOffsetTop(activeMark, excerpt)
          excerpt.scrollTo({
            top:
              markRelTop -
              excerpt.clientHeight / 2 +
              activeMark.offsetHeight / 2,
            behavior: 'smooth'
          })
        }
      })
    }
  })

  onKeyStroke('ArrowUp', (event) => {
    event.preventDefault()
    isKeyboardAction.value = true

    if (
      resultsEl.value &&
      document.activeElement === resultsEl.value &&
      selectedIndex.value === 0
    ) {
      selectedIndex.value = -1
      searchInput.value?.focus()
      return
    }

    if (resultsEl.value && document.activeElement === searchInput.value) {
      resultsEl.value.focus()
      // Fall through to wrap to bottom
    }

    selectedIndex.value--
    if (selectedIndex.value < 0) {
      selectedIndex.value = results.value.length - 1
    }
    disableMouseOver.value = true
    scrollToSelectedResult()
  })

  onKeyStroke('ArrowDown', (event) => {
    event.preventDefault()
    isKeyboardAction.value = true

    if (resultsEl.value && document.activeElement === searchInput.value) {
      resultsEl.value.focus()
      // Fall through to select first item (from -1 to 0)
    }

    selectedIndex.value++
    if (selectedIndex.value >= results.value.length) {
      selectedIndex.value = 0
    }
    disableMouseOver.value = true
    scrollToSelectedResult()
  })

  const router = useRouter()
  const navigateToResult = createSearchNavigation(
    router,
    () => filterText.value,
    () => vitePressData.site.value.base || '/',
    close
  )

  onKeyStroke('Enter', (e) => {
    if (e.isComposing) return

    if (e.target instanceof HTMLButtonElement && e.target.type !== 'submit')
      return

    let selectedPackage = results.value[selectedIndex.value]
    // Fallback to first result if Enter is pressed in search input with no active selection
    if (
      !selectedPackage &&
      selectedIndex.value === -1 &&
      results.value.length > 0
    ) {
      selectedPackage = results.value[0]
    }

    if (e.target instanceof HTMLInputElement && !selectedPackage) {
      e.preventDefault()
      return
    }

    if (selectedPackage) {
      addRecentSearch(filterText.value)
      const idx = results.value.indexOf(selectedPackage)
      const matchCtx = idx >= 0 ? getMatchContext(idx) : null
      navigateToResult(selectedPackage.id, matchCtx)
    }
  })

  onKeyStroke('Escape', () => {
    close()
  })

  /**
   * Custom feature: Keyboard navigation for cycling through highlights.
   * Left/Right arrow keys navigate prev/next match within the selected result.
   * Only active when detailed view is enabled and matches exist.
   */
  onKeyStroke('ArrowLeft', (event) => {
    if (event.repeat) return
    const targetIndex = selectedIndex.value === -1 ? 0 : selectedIndex.value

    if (document.activeElement === searchInput.value) {
      if (event.altKey || event.ctrlKey) {
        // modifier always forces nav
      } else {
        // mirror ArrowRight: hijack only when caret is at start of input
        const { selectionStart, selectionEnd } = searchInput.value!
        if (selectionStart !== 0 || selectionEnd !== 0) return
        isKeyboardAction.value = true
        if (selectedIndex.value === -1) selectedIndex.value = 0
        resultsEl.value?.focus()
        event.preventDefault()
        return
      }
    }

    // Navigate to previous match - only when viewing detailed excerpts with highlights
    if (
      showDetailedList.value &&
      (resultMarks.value.get(targetIndex)?.length ?? 0) > 0
    ) {
      event.preventDefault()
      prevMatch(targetIndex)
    }
  })

  onKeyStroke('ArrowRight', (event) => {
    if (event.repeat) return
    const targetIndex = selectedIndex.value === -1 ? 0 : selectedIndex.value

    if (document.activeElement === searchInput.value) {
      if (event.shiftKey) return
      if (event.altKey || event.ctrlKey) {
        // Allow modifier to force nav
      } else {
        // Shortcut: If at end of input, go down to results list without cycling matches
        const { selectionStart, selectionEnd, value } = searchInput.value!
        if (selectionStart !== value.length || selectionEnd !== value.length)
          return

        // Use the target index (0) if we were at -1
        isKeyboardAction.value = true
        if (selectedIndex.value === -1) selectedIndex.value = 0
        resultsEl.value?.focus()
        event.preventDefault()
        return
      }
    }

    // Navigate to next match - only when viewing detailed excerpts with highlights
    if (
      showDetailedList.value &&
      (resultMarks.value.get(targetIndex)?.length ?? 0) > 0
    ) {
      event.preventDefault()
      nextMatch(targetIndex)
    }
  })

  // Translations
  const defaultTranslations: { modal: ModalTranslations } = {
    modal: {
      displayDetails: 'Display detailed list',
      resetButtonTitle: 'Reset search',
      backButtonTitle: 'Close search',
      noResultsText: 'No results for',
      footer: {
        selectText: 'to select',
        selectKeyAriaLabel: 'enter',
        navigateText: 'to navigate',
        navigateUpKeyAriaLabel: 'up arrow',
        navigateDownKeyAriaLabel: 'down arrow',
        closeText: 'to close',
        closeKeyAriaLabel: 'escape'
      }
    }
  }

  const translate = createSearchTranslate(defaultTranslations)

  const customTitles = {
    prevMatch: 'Previous match',
    nextMatch: 'Next match',
    fuzzyOn: 'Switch to Exact Search',
    fuzzyOff: 'Switch to Fuzzy Search',
    urlOn: 'Only search names and text',
    urlOff: 'Search link URLs too',
    urlAuto: 'URL detected — searching link URLs. Click to keep this on.',
    searching: 'Searching...',
    cycleMatches: 'to cycle matches',
    detailedViewOn: 'Detailed view',
    detailedViewOff: 'Compact view'
  }

  // Back

  useEventListener('popstate', () => {
    close()
  })

  /** Lock body */
  const isLocked = useScrollLock(inBrowser ? document.body : null)

  onMounted(() => {
    focusSearchInput()
    window.history.pushState ? window.history.pushState(null, '', null) : null
    nextTick(() => {
      isLocked.value = true
      nextTick().then(() => activate())
    })
  })

  onBeforeUnmount(() => {
    isLocked.value = false
    resultMarks.value = new Map()
    currentMarkIndex.value = new Map()
    globalResultMarks.value = new Map()
    globalCurrentMarkIndex.value = new Map()
  })

  function addRecentSearch(query: string) {
    const q = query.trim()
    if (!q) return
    recentSearches.value = [
      q,
      ...recentSearches.value.filter((s) => s !== q)
    ].slice(0, MAX_RECENT_SEARCHES)
  }

  function removeRecentSearch(query: string) {
    recentSearches.value = recentSearches.value.filter((s) => s !== query)
    nextTick().then(() => focusSearchInput(false))
  }

  function clearAllRecentSearches() {
    recentSearches.value = []
    nextTick().then(() => focusSearchInput(false))
  }

  /**
   * Extract the text content of the element containing the currently active
   * match highlight in the search excerpt. This identifies the SPECIFIC item
   * the user was looking at (e.g., "SpotifyPublic" vs "EeveeSpotifyRevived")
   * so we scroll to the right one on the page.
   */
  function getMatchContext(resultIndex: number): string | null {
    const marks = resultMarks.value.get(resultIndex)
    const curr = currentMarkIndex.value.get(resultIndex) ?? 0
    if (!marks || !marks[curr] || marks[curr].length === 0) return null

    const mark = marks[curr][0]
    // Find the closest content container (same selectors used on the actual page)
    const container = mark.closest('li, p, td, dd, blockquote')
    if (!container) return null

    return container.textContent?.trim() || null
  }

  function handleResultClick(e: MouseEvent, id: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) {
      return
    }
    e.preventDefault()
    addRecentSearch(filterText.value)

    // Find which result index was clicked to get the match context
    const index = results.value.findIndex((r) => r.id === id)
    const matchContext = index >= 0 ? getMatchContext(index) : null
    navigateToResult(id, matchContext)
  }

  function resetSearch() {
    filterText.value = ''
    nextTick().then(() => focusSearchInput(false))
  }

  function toggleDetailedList() {
    showDetailedList.value = !showDetailedList.value
  }

  function handleInput(e: Event) {
    filterText.value = (e.target as HTMLInputElement).value
  }

  function toggleFuzzySearch() {
    isFuzzySearch.value = !isFuzzySearch.value
  }

  function toggleUrlSearch() {
    isUrlSearch.value = !isUrlSearch.value
  }

  let lastMouseX = 0
  let lastMouseY = 0

  function onMouseMove(e: MouseEvent) {
    if (e.clientX === lastMouseX && e.clientY === lastMouseY) {
      return
    }
    lastMouseX = e.clientX
    lastMouseY = e.clientY

    if (disableMouseOver.value) {
      disableMouseOver.value = false
      return
    }

    const el = (e.target as HTMLElement)?.closest<HTMLElement>('.result-item')
    const index = el?.dataset?.index ? Number.parseInt(el.dataset.index) : -1
    if (index >= 0 && index !== selectedIndex.value) {
      selectedIndex.value = index
    }
  }

  // When the results list (or an item within it) holds focus — e.g. after arrow
  // navigation — a printable keystroke would otherwise be lost. Redirect it back
  // to the search input so the user can keep typing; focusing synchronously in
  // keydown lets the character land in the input.
  function onResultsKeydown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key.length !== 1) return // ignore non-printable keys (arrows, Enter, …)
    if (document.activeElement === searchInput.value) return
    focusSearchInput(false)
  }

  return {
    RESULTS_PAGE_SIZE,
    show,
    close,
    el,
    resultsEl,
    isFuzzySearch,
    isUrlSearch,
    activeCategory,
    categoryCounts,
    totalCategoryCount,
    visibleCategories,
    activeCategoryLabel,
    selectCategory,
    onCategoryWheel,
    filterText,
    urlSearchAuto,
    showDetailedList,
    disableDetailedView,
    buttonText,
    results,
    totalResultsCount,
    resultMarks,
    currentMarkIndex,
    enableNoResults,
    isSearching,
    resultLimit,
    mayHaveMore,
    recentSearches,
    autoSuggestions,
    nextMatch,
    prevMatch,
    searchInput,
    disableReset,
    applySuggestion,
    onSearchBarClick,
    selectedIndex,
    disableMouseOver,
    translate,
    customTitles,
    removeRecentSearch,
    clearAllRecentSearches,
    handleResultClick,
    resetSearch,
    toggleDetailedList,
    handleInput,
    toggleFuzzySearch,
    toggleUrlSearch,
    onMouseMove,
    onResultsKeydown,
    sanitizeRichHtml,
    sanitizeSearchHtml
  }
}
