import type { DefaultTheme } from 'vitepress'
import type { ModalTranslations } from 'vitepress/types/local-search'
import type { LocalSearchResult, SidebarItem } from './types'
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
  getRelativeOffsetTop,
  getSearchEntryText,
  groupMarks,
  highlightSearchResults,
  mergeNearbyMarks,
  preferredEntryTarget,
  SEARCH_ENTRY_SELECTOR
} from './matchHighlighting'
import { INVISIBLE_CHARS_RE, parseSearchQuery } from './normalization'
import { createSearchNavigation } from './resultNavigation'
import {
  createEntrySearch,
  excerptCache,
  filterResults,
  filterSearchExclusions,
  loadExcerpts,
  lookupExcerptText,
  usesEntrySearch
} from './resultPreviews'
import { createSearchEngine, loadSearchIndex } from './searchEngine'
import { isExplicitUrlQuery, looksLikeUrlQuery } from './urlMatching'

const RESULTS_PAGE_SIZE = 16
const MAX_RECENT_SEARCHES = 20
const SEARCH_DEBOUNCE_MS = 350

// Keep the latest loaders alive while the modal is closed.
const searchIndexSource = shallowRef(localSearchIndex)
if (import.meta.hot) {
  import.meta.hot.accept('/@localSearchIndex', (module) => {
    if (module)
      searchIndexSource.value = module.default as typeof localSearchIndex
  })
}

type SearchSnapshot = {
  source: typeof searchIndexSource.value
  locale: string
  options: DefaultTheme.LocalSearchOptions['miniSearch']
  entryEngine: ReturnType<typeof createEntrySearch>
  engine: ReturnType<typeof createSearchEngine>
}

// Reuse parsed indexes and previews until their source, locale, or options change.
let cachedSnapshot: SearchSnapshot | null = null
let previewSnapshot: SearchSnapshot | null = null

// Persisted results state across mount/unmount of the modal
let globalLastIndex: SearchSnapshot | null = null

const globalLastQuery = ref('')
const globalLastFuzzy = ref(false)
const globalLastUrlSearch = ref(false)
const globalLastDetailed = ref(false)
const globalResults = ref<LocalSearchResult[]>([])
const globalAllResults = ref<LocalSearchResult[]>([])
const globalTotalResultsCount = ref(0)
const globalResultLimit = ref(RESULTS_PAGE_SIZE)
const globalMayHaveMore = ref(false)

export function useSearchModal() {
  const show = ref(true)

  function close() {
    show.value = false
  }

  const el = shallowRef<HTMLElement>()
  const resultsEl = shallowRef<HTMLElement>()

  /* Search */

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

  // Wiki and Tools entries can target the same page; keep the first label.
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

  // Preserve the other categories' counts when one category is selected.
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

  const miniSearchOptions = computed(() =>
    theme.value.search?.provider === 'local'
      ? theme.value.search.options?.miniSearch
      : undefined
  )
  const indexSnapshot = computedAsync(async () => {
    const source = searchIndexSource.value
    const locale = localeIndex.value
    const options = miniSearchOptions.value
    if (
      cachedSnapshot?.source === source &&
      cachedSnapshot.locale === locale &&
      cachedSnapshot.options === options
    ) {
      return cachedSnapshot
    }
    const rawIndex = (await source[locale]?.())?.default
    if (!rawIndex) return null
    const loaded = loadSearchIndex(
      rawIndex,
      options?.options,
      options?.searchOptions
    )
    if (!loaded) return null
    const searchSidebar = Array.isArray(sidebar) ? sidebar : []
    const engine = createSearchEngine(
      loaded.index,
      loaded.metadata,
      searchSidebar
    )
    const entryEngine = createEntrySearch(
      engine.sections().map((section) => ({
        ...section,
        text: loaded.sectionHtml[section.id] ?? ''
      })),
      loaded.metadata,
      searchSidebar,
      engine
    )
    const snapshot = markRaw({ source, locale, options, engine, entryEngine })
    if (
      source === searchIndexSource.value &&
      locale === localeIndex.value &&
      options === miniSearchOptions.value
    ) {
      cachedSnapshot = snapshot
    }
    return snapshot
  })

  // A superseded async load must never supply an index or metadata to this modal.
  const activeSnapshot = computed(() => {
    const snapshot = indexSnapshot.value
    return snapshot?.source === searchIndexSource.value &&
      snapshot.locale === localeIndex.value &&
      snapshot.options === miniSearchOptions.value
      ? snapshot
      : null
  })
  let queriedSnapshot: typeof activeSnapshot.value = null

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
  const urlSearchAuto = computed(() => {
    const query = parseSearchQuery(filterText.value)
    return (
      !isUrlSearch.value && !query.isPhrase && looksLikeUrlQuery(query.text)
    )
  })

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
      globalLastIndex?.source === searchIndexSource.value &&
      globalLastIndex.locale === localeIndex.value &&
      globalLastIndex.options === miniSearchOptions.value &&
      filterText.value === globalLastQuery.value &&
      isFuzzySearch.value === globalLastFuzzy.value &&
      isUrlSearch.value === globalLastUrlSearch.value &&
      showDetailedList.value === globalLastDetailed.value
    )
  }

  const isRestoring = matchesGlobalState()

  const results = shallowRef<LocalSearchResult[]>(
    isRestoring ? globalResults.value : []
  )
  const allResults = shallowRef<LocalSearchResult[]>(
    isRestoring ? globalAllResults.value : []
  )
  const totalResultsCount = ref(isRestoring ? globalTotalResultsCount.value : 0)
  const resultMarks = shallowRef(new Map<number, HTMLElement[][]>())
  const currentMarkIndex = shallowRef(new Map<number, number>())

  const enableNoResults = ref(isRestoring)
  const isSearching = ref(!isRestoring && !!filterText.value)
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
    if (!filterText.value || results.value.length > 0 || !activeSnapshot.value)
      return []

    return activeSnapshot.value?.engine.suggest(filterText.value) ?? []
  })

  watch([filterText, isFuzzySearch, isUrlSearch], () => {
    activeCategory.value = ''
    enableNoResults.value = false
    resultLimit.value = RESULTS_PAGE_SIZE
    shouldResetScroll.value = true
  })

  watch(
    [filterText, isFuzzySearch, isUrlSearch, showDetailedList, activeSnapshot],
    () => {
      isSearching.value = !matchesGlobalState() && !!filterText.value
    },
    { immediate: true }
  )

  // Invalidate restored results immediately, even while a new locale/index loads.
  watch(
    [searchIndexSource, localeIndex, miniSearchOptions],
    () => {
      excerptCache.clear()
      allResults.value = []
      results.value = []
      resultMarks.value = new Map()
      currentMarkIndex.value = new Map()
      categoryCounts.value = new Map()
      totalResultsCount.value = 0
      mayHaveMore.value = false
      activeCategory.value = ''
      resultLimit.value = RESULTS_PAGE_SIZE
      enableNoResults.value = false
      isSearching.value = !!filterText.value
    },
    { flush: 'sync' }
  )

  watch(
    activeSnapshot,
    (snapshot) => {
      if (snapshot && snapshot !== previewSnapshot) {
        excerptCache.clear()
        previewSnapshot = snapshot
      }
    },
    { immediate: true, flush: 'sync' }
  )

  // Query the index after typing pauses; pagination and previews are handled below.
  watchDebounced(
    () =>
      [
        activeSnapshot.value,
        filterText.value,
        isFuzzySearch.value,
        isUrlSearch.value,
        showDetailedList.value
      ] as const,
    ([snapshot, filterTextValue]) => {
      if (snapshot === globalLastIndex && matchesGlobalState()) {
        queriedSnapshot = snapshot
        allResults.value = globalAllResults.value
        enableNoResults.value = true
        return
      }

      globalLastIndex = null
      queriedSnapshot = null

      if (!snapshot || !filterTextValue.trim()) {
        allResults.value = []
        totalResultsCount.value = 0
        mayHaveMore.value = false

        // Clear global cache for empty query
        globalAllResults.value = []
        globalTotalResultsCount.value = 0
        globalLastQuery.value = ''
        globalResults.value = []
        globalMayHaveMore.value = false
        return
      }

      const queryEngine = usesEntrySearch(filterTextValue, isFuzzySearch.value)
        ? snapshot.entryEngine
        : snapshot.engine
      const { results: boostedResults } = queryEngine.search(filterTextValue, {
        fuzzy: isFuzzySearch.value,
        urls: isUrlSearch.value
      })

      enableNoResults.value = true

      queriedSnapshot = snapshot
      allResults.value = boostedResults

      // Cache raw query results; the preview watcher updates the displayed count.
      globalAllResults.value = boostedResults
      globalLastQuery.value = filterTextValue
      globalLastFuzzy.value = isFuzzySearch.value
      globalLastUrlSearch.value = isUrlSearch.value
      globalLastDetailed.value = showDetailedList.value
    },
    { debounce: SEARCH_DEBOUNCE_MS, immediate: true }
  )

  // Prepare the current result page and highlights without rerunning the index query.
  watch(
    () =>
      [
        allResults.value,
        resultLimit.value,
        showDetailedList.value,
        activeCategory.value,
        activeSnapshot.value
      ] as const,
    async ([allRes, limit, showDetailedListValue], old, onCleanup) => {
      const snapshot = activeSnapshot.value
      const query = globalLastQuery.value
      const fuzzy = globalLastFuzzy.value
      const urls = globalLastUrlSearch.value
      let canceled = false
      const isCanceled = () =>
        canceled ||
        allResults.value !== allRes ||
        activeSnapshot.value !== snapshot ||
        filterText.value !== query ||
        isFuzzySearch.value !== fuzzy ||
        isUrlSearch.value !== urls
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
          isSearching.value = !!filterText.value && !snapshot
        }
        totalResultsCount.value = 0
        mayHaveMore.value = false
        if (snapshot && queriedSnapshot === snapshot) {
          globalResults.value = []
          globalTotalResultsCount.value = 0
          globalMayHaveMore.value = false
          globalLastIndex = snapshot
        }
        if (resultSetChanged) {
          categoryCounts.value = computeCategoryCounts(allRes)
        }
        return
      }

      if (isCanceled()) return

      const terms = new Set<string>()

      const searchQuery = parseSearchQuery(query)
      const hasExclusions =
        searchQuery.excludedTerms.length > 0 ||
        searchQuery.excludedSites.length > 0
      const literalQuery = searchQuery.text
        .replace(INVISIBLE_CHARS_RE, '')
        .toLowerCase()
      const useEntrySearch = usesEntrySearch(query, fuzzy)
      const needsContentFiltering =
        !useEntrySearch &&
        (hasExclusions ||
          allRes.some(
            (result) =>
              !!result.entryMatch?.groups.length ||
              result.entryMatch?.withHeadingContext
          ) ||
          searchQuery.sites.length > 0 ||
          searchQuery.urls.length > 0 ||
          searchQuery.phrases.length > 0 ||
          (!fuzzy &&
            (/\s/.test(searchQuery.text) ||
              allRes.some(
                (result) =>
                  !result.substringMatched &&
                  !result.urlMatched &&
                  !result.terms.some((term) => term.includes(literalQuery))
              ))))
      // Qualify the bounded engine result set before pagination or category counts.
      const candidates =
        useEntrySearch || needsContentFiltering ? allRes : sliced
      const needsPreviewFiltering =
        !useEntrySearch &&
        (needsContentFiltering ||
          candidates.some((result) => !!result.entryMatch))
      const includeExcerpts = needsPreviewFiltering || showDetailedListValue
      const knownMatches = new Set(
        needsPreviewFiltering
          ? filterResults(candidates, query, false, fuzzy).map(
              (result) => result.id
            )
          : []
      )
      const previewCandidates = candidates.filter(
        (result, index) =>
          (needsPreviewFiltering && !knownMatches.has(result.id)) ||
          (showDetailedListValue && index < limit)
      )
      await loadExcerpts(previewCandidates, vitePressData, isCanceled)
      if (isCanceled()) return

      const mapped = candidates.map((result) => ({
        ...result,
        text: includeExcerpts ? lookupExcerptText(result.id) : ''
      }))
      const filtered = useEntrySearch
        ? mapped
        : needsPreviewFiltering
          ? filterResults(mapped, query, true, fuzzy)
          : mapped
      const scopedMatches = category
        ? filtered.filter((result) => resultCategoryOf(result.id) === category)
        : filtered
      let finalResults = scopedMatches.slice(0, limit)
      if (showDetailedListValue) {
        await loadExcerpts(finalResults, vitePressData, isCanceled)
        if (isCanceled()) return
        if (useEntrySearch || !hasExclusions) {
          for (const result of finalResults)
            result.text = lookupExcerptText(result.id)
          if (hasExclusions)
            finalResults = filterSearchExclusions(finalResults, query)
        }
      }
      const totalCount =
        useEntrySearch || needsContentFiltering
          ? scopedMatches.length
          : mapped.length + Math.max(0, scopedResults.length - limit)
      const mayHaveMoreValue = false

      if (resultSetChanged) {
        // A category's preview filtering must not remove the other category chips.
        categoryCounts.value = computeCategoryCounts(
          useEntrySearch || needsContentFiltering ? filtered : allRes
        )
      }

      if (fuzzy) {
        for (const result of finalResults)
          for (const term of Object.keys(result.match)) terms.add(term)
      } else terms.add(searchQuery.text)

      results.value = finalResults
      totalResultsCount.value = totalCount
      mayHaveMore.value = mayHaveMoreValue

      await nextTick()
      if (isCanceled()) return

      await highlightSearchResults(
        resultsEl.value,
        finalResults,
        terms,
        query,
        fuzzy,
        isCanceled
      )
      if (isCanceled()) return

      if (fuzzy) {
        mergeNearbyMarks(resultsEl.value)
      }

      const excerpts = Array.from(
        resultsEl.value?.querySelectorAll(
          '.result-item:not(.result-list-leave-active) .result .excerpt'
        ) ?? []
      ) as HTMLElement[]
      const scrollTargets: { excerpt: HTMLElement; scrollTop: number }[] = []
      for (const excerpt of excerpts) {
        const id = excerpt.closest<HTMLElement>('.result-item')?.dataset.id
        const result = finalResults.find((result) => result.id === id)
        const marks = [
          ...excerpt.querySelectorAll<HTMLElement>('mark[data-markjs="true"]')
        ]
        const markElement = result
          ? preferredEntryTarget(marks, result, excerpt)
          : marks[0]
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
        const preferred = preferredEntryTarget(
          marks,
          r,
          item?.querySelector('.excerpt')
        )
        if (marks.length > 0 || preferred) {
          const groups = groupMarks(marks)
          // A heading-supported resource may have no literal query word to mark.
          if (preferred && !marks.includes(preferred))
            groups.unshift([preferred])
          const current = groups.findIndex(
            (group) => preferred && group.includes(preferred)
          )
          newResultMarks.set(index, groups)
          newCurrentMarkIndex.set(index, Math.max(0, current))
        }
      })
      resultMarks.value = newResultMarks
      currentMarkIndex.value = newCurrentMarkIndex

      if (resultsEl.value && shouldResetScroll.value) {
        resultsEl.value.scrollTop = 0
        shouldResetScroll.value = false
      }

      isSearching.value = false

      // Only completed results may be restored after the modal unmounts.
      if (!snapshot || queriedSnapshot !== snapshot) return
      globalLastIndex = snapshot
      globalResults.value = finalResults
      globalTotalResultsCount.value = totalCount
      globalResultLimit.value = limit
      globalMayHaveMore.value = mayHaveMoreValue
    },
    { immediate: true }
  )

  function cycleMatch(index: number, direction: 1 | -1) {
    if (selectedIndex.value !== index) selectedIndex.value = index
    const marks = resultMarks.value.get(index)
    if (!marks) return
    const current = currentMarkIndex.value.get(index) ?? 0
    marks[current]?.forEach((mark) => mark.classList.remove('current'))

    const next = (current + direction + marks.length) % marks.length
    currentMarkIndex.value.set(index, next)
    triggerRef(currentMarkIndex)

    const group = marks[next]
    if (!group?.length) return
    group.forEach((mark) => mark.classList.add('current'))
    const mark = group[0]
    const excerpt = mark.closest<HTMLElement>('.excerpt')
    if (excerpt) {
      excerpt.scrollTo({
        top:
          getRelativeOffsetTop(mark, excerpt) -
          excerpt.clientHeight / 2 +
          mark.offsetHeight / 2,
        behavior: 'smooth'
      })
    }
  }

  /* Search input focus */

  const searchInput = ref<HTMLInputElement>()
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
      navigateToResult(
        selectedPackage.id,
        matchCtx,
        getResultQuery(selectedPackage)
      )
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
      cycleMatch(targetIndex, -1)
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
      cycleMatch(targetIndex, 1)
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
    get urlAuto() {
      return isExplicitUrlQuery(parseSearchQuery(filterText.value).text)
        ? 'URL detected — searching link URLs. Click to keep this on.'
        : 'Searching names, text, and link URLs. Click to keep URL matching on.'
    },
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

  function getResultQuery(result: LocalSearchResult) {
    // A filters-only OR branch has no text to locate on the page.
    return (
      result.searchBranches?.find((branch) => parseSearchQuery(branch).text) ??
      result.searchBranches?.[0]
    )
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
    const match = results.value[resultIndex]?.entryMatch
    if (!marks || !marks[curr] || marks[curr].length === 0)
      return match?.entries?.[0]?.context ?? null

    const mark = marks[curr][0]
    // Find the closest content container (same selectors used on the actual page)
    const container = mark.closest(
      match ? SEARCH_ENTRY_SELECTOR : 'li, p, td, dd, blockquote'
    )
    if (!container) return null

    return match
      ? getSearchEntryText(container)
      : container.textContent?.trim() || null
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
    navigateToResult(
      id,
      matchContext,
      results.value[index] ? getResultQuery(results.value[index]) : undefined
    )
  }

  function resetSearch() {
    filterText.value = ''
    nextTick().then(() => focusSearchInput(false))
  }

  function handleInput(e: Event) {
    filterText.value = (e.target as HTMLInputElement).value
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
    cycleMatch,
    searchInput,
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
    handleInput,
    onMouseMove,
    onResultsKeydown
  }
}
