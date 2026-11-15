import type { AsPlainObject, Options, Query, SearchOptions } from 'minisearch'
import type {
  LocalSearchResult,
  Result,
  SearchMetadata,
  SidebarItem
} from './types'
import type { UrlRecord } from './urlMatching'
import MiniSearch from 'minisearch'
import {
  createPhraseRegex,
  INVISIBLE_CHARS_RE,
  normalizeFuzzyTerm,
  normalizeUrlFilters,
  parseSearchQuery,
  processSearchTerm,
  tokenizeIndexLike,
  tokenizeSearchText
} from './normalization'
import {
  buildUrlIndex,
  findSiteMatches,
  findUrlMatches,
  isExplicitUrlQuery,
  looksLikeUrlQuery
} from './urlMatching'

const MAX_RESULTS_IN_MEMORY = 200
const MAX_SUBSTRING_TERMS = 100
const MAX_SUGGESTIONS = 3

interface BoostFlags {
  hasStarredExact: boolean
  hasExact: boolean
  hasStarredPrefix: boolean
  hasPrefix: boolean
  hasStarredWord: boolean
  hasStarredUrl: boolean
  hasLinkWord: boolean
  hasLinkUrl: boolean
}

function findPageTitle(items: SidebarItem[], path: string): string | null {
  for (const item of items) {
    if (item.link === path) return item.text ?? null
    if (item.items) {
      const found = findPageTitle(item.items, path)
      if (found) return found
    }
  }
  return null
}

function collectLinkTerms(customMetadata: SearchMetadata) {
  const globalStarredLinks = new Set<string>()
  const globalLinks = new Set<string>()
  const globalLinkPhrases = new Set<string>()
  for (const key in customMetadata) {
    const item = customMetadata[key]
    if (item.s) {
      for (const phrase of item.s) {
        globalLinkPhrases.add(phrase)
        for (const w of tokenizeIndexLike(phrase, true)) {
          globalStarredLinks.add(w)
        }
      }
    }
    if (item.l) {
      for (const phrase of item.l) {
        globalLinkPhrases.add(phrase)
        for (const w of tokenizeIndexLike(phrase, true)) {
          globalLinks.add(w)
        }
      }
    }
  }
  return { globalStarredLinks, globalLinks, globalLinkPhrases }
}

function fuzzyTolerance(term: string) {
  if (term.length < 5) return false
  return term.length < 9 ? 1 : 2
}

function createTermLookup(terms: string[]) {
  const indexedTerms = new Set(terms)
  const aliases = new Map<string, string[]>()
  for (const term of terms) {
    const key = normalizeFuzzyTerm(term)
    if (!key || key === term) continue
    const group = aliases.get(key)
    if (group) group.push(term)
    else aliases.set(key, indexedTerms.has(key) ? [key, term] : [term])
  }
  return {
    indexedTerms,
    aliases,
    alternatives(word: string) {
      const tokens = tokenizeIndexLike(word)
      if (tokens.length !== 1) return []
      const term = tokens[0]
      const key = normalizeFuzzyTerm(term)
      const group = aliases.get(key)
      if (group) return group.filter((alias) => alias !== term)
      if (indexedTerms.has(key)) return key === term ? [] : [key]
      const characters = Array.from(term)
      if (characters.length < 5) return []
      const matches = new Set<string>()
      for (let i = 0; i < characters.length - 1; i++) {
        if (
          characters[i] === characters[i + 1] ||
          !/^[\p{L}\p{N}]{2}$/u.test(characters[i] + characters[i + 1])
        )
          continue
        const swapped = [...characters]
        swapped[i] = characters[i + 1]
        swapped[i + 1] = characters[i]
        const swappedKey = normalizeFuzzyTerm(swapped.join(''))
        for (const candidate of aliases.get(swappedKey) ??
          (indexedTerms.has(swappedKey) ? [swappedKey] : []))
          matches.add(candidate)
      }
      return [...matches]
    }
  }
}

export function mergeSearchMatches(
  a: LocalSearchResult,
  b: LocalSearchResult
): LocalSearchResult {
  const match = { ...a.match }
  for (const [term, fields] of Object.entries(b.match)) {
    match[term] = [...new Set([...(match[term] ?? []), ...fields])]
  }
  return {
    ...a,
    terms: [...new Set([...a.terms, ...b.terms])],
    queryTerms: [...new Set([...a.queryTerms, ...b.queryTerms])],
    match,
    urlMatched: a.urlMatched || b.urlMatched,
    urlMatchedStarred: a.urlMatchedStarred || b.urlMatchedStarred,
    urlMatchRank: Math.max(a.urlMatchRank ?? 0, b.urlMatchRank ?? 0),
    substringMatched: a.substringMatched || b.substringMatched
  }
}

function createRemainingMatcher(query: Query, options: SearchOptions) {
  let validator: MiniSearch<{ id: number; text: string }> | undefined
  return (
    result: LocalSearchResult,
    removed: ReadonlySet<string>,
    includeHeadings = true
  ) => {
    const terms = result.terms.filter(
      (term) =>
        !removed.has(term) ||
        (includeHeadings &&
          result.match[term]?.some((field) => field !== 'text'))
    )
    if (terms.length === result.terms.length) return true
    if (!terms.length) return false
    // Recheck only the surviving indexed matches, using the original query tree.
    validator ??= new MiniSearch({
      fields: ['text'],
      tokenize: (text) => text.split(' '),
      processTerm: (term) => term,
      searchOptions: { prefix: true }
    })
    validator.removeAll()
    validator.add({ id: 0, text: terms.join(' ') })
    return (
      validator.search(query, {
        ...options,
        tokenize: tokenizeSearchText,
        processTerm: processSearchTerm
      }).length > 0
    )
  }
}

function runSearch(
  index: MiniSearch<Result>,
  metadata: SearchMetadata,
  cachedTermKeys: string[],
  filterTextValue: string,
  options: { fuzzy: boolean; urls: boolean },
  sidebar: SidebarItem[],
  phraseTokens: Map<string, Set<string>>,
  getUrlIndex: () => UrlRecord[],
  getTermLookup: () => ReturnType<typeof createTermLookup>
) {
  const parsed = parseSearchQuery(filterTextValue)
  const { text, isPhrase, sites, titles, urls, branches } = parsed
  if (branches.length > 1) {
    const alternatives = branches.map(
      (branch) =>
        runSearch(
          index,
          metadata,
          cachedTermKeys,
          branch,
          options,
          sidebar,
          phraseTokens,
          getUrlIndex,
          getTermLookup
        ).results
    )
    const merged = new Map<string, LocalSearchResult>()
    for (
      let rank = 0;
      rank < Math.max(...alternatives.map((results) => results.length));
      rank++
    ) {
      for (const [i, results] of alternatives.entries()) {
        const result = results[rank]
        if (!result) continue
        const previous = merged.get(result.id)
        if (previous) {
          const combined = mergeSearchMatches(previous, result)
          combined.searchBranches = [...previous.searchBranches!, branches[i]]
          combined.branchMatches = {
            ...previous.branchMatches,
            [branches[i]]: result
          }
          merged.set(result.id, combined)
        } else {
          merged.set(result.id, {
            ...result,
            searchBranches: [branches[i]],
            branchMatches: { [branches[i]]: result }
          })
        }
      }
    }
    return { results: [...merged.values()].slice(0, MAX_RESULTS_IN_MEMORY) }
  }
  filterTextValue = text
  const siteMatches = sites.length
    ? findSiteMatches(getUrlIndex(), sites)
    : undefined
  const filtersOnly =
    !text &&
    !isPhrase &&
    !!(
      sites.length ||
      titles.length ||
      urls.length ||
      parsed.excludedTerms.length ||
      parsed.excludedSites.length
    )
  const titlePatterns = titles.map((title) => createPhraseRegex(title))
  const urlFilters = normalizeUrlFilters(urls)
  if (!urlFilters) return { results: [] }
  const fuzzy = options.fuzzy && !isPhrase
  let substringTerms: Set<string> | undefined
  let query: Query = filterTextValue

  const recoveredTerms = new Map<string, string[]>()
  const canRecoverTerms = fuzzy && !looksLikeUrlQuery(filterTextValue)
  if (fuzzy) {
    const parts = filterTextValue.split(/\s+/).filter((p) => p)
    if (parts.length > 0) {
      const dashed = parts.join('-')
      query = {
        combineWith: 'OR',
        queries: [
          {
            queries: parts.map((part): Query => {
              const alternatives =
                canRecoverTerms && !looksLikeUrlQuery(part)
                  ? getTermLookup().alternatives(part)
                  : []
              if (!alternatives.length) return part
              recoveredTerms.set(tokenizeIndexLike(part)[0], alternatives)
              return {
                combineWith: 'OR',
                queries: [
                  { queries: [part], fuzzy: fuzzyTolerance },
                  {
                    queries: alternatives,
                    combineWith: 'OR',
                    fuzzy: false,
                    prefix: false
                  }
                ]
              }
            }),
            combineWith: 'AND',
            fuzzy: fuzzyTolerance
          },
          {
            queries: [dashed],
            combineWith: 'AND',
            fuzzy: fuzzyTolerance
          }
        ]
      }
    }
  }

  /**
   * Suffix Search / Substring Matching:
   * For exact mode, find index terms containing the query as a substring
   * (e.g. "abolic" → "parabolic") using the pre-cached term key list.
   */
  if (
    !fuzzy &&
    !isPhrase &&
    !/\s/.test(filterTextValue) &&
    filterTextValue.length > 2
  ) {
    const candidateTerms: string[] = []
    const match = filterTextValue.toLowerCase()
    for (const term of cachedTermKeys) {
      if (term.includes(match) && term !== match) {
        candidateTerms.push(term)
      }
    }
    if (candidateTerms.length > 0) {
      // Sort by length ascending so shorter words win the cap
      candidateTerms.sort((a, b) => a.length - b.length)
      const capped = candidateTerms.slice(0, MAX_SUBSTRING_TERMS)
      substringTerms = new Set(capped)
      query = {
        combineWith: 'OR',
        queries: [filterTextValue, ...capped]
      }
    }
  }

  // fuzzy only matters for string queries; structured queries carry their own per-clause fuzzy
  const searchOptions = {
    combineWith: 'AND' as const,
    fuzzy: fuzzy && typeof query === 'string' ? fuzzyTolerance : false,
    ...(isPhrase ? { prefix: false } : {})
  }

  const matchesWithoutTerms =
    fuzzy &&
    (parsed.excludedTerms.length ||
      parsed.excludedSites.length ||
      sites.length ||
      urls.length ||
      parsed.phrases.length)
      ? createRemainingMatcher(query, searchOptions)
      : undefined
  const queryLooksLikeUrl = !isPhrase && isExplicitUrlQuery(filterTextValue)
  // Pasted URLs should search URLs only. Running the normal text index too
  // turns URL punctuation into generic terms and leaks unrelated results.
  const rawResults = filtersOnly
    ? (index.search(MiniSearch.wildcard) as LocalSearchResult[]).map(
        (result) => ({ ...result, urlMatched: true })
      )
    : queryLooksLikeUrl
      ? []
      : (index.search(query, searchOptions) as LocalSearchResult[])
  const searchUrls =
    !isPhrase && (options.urls || looksLikeUrlQuery(filterTextValue))
  const urlResults = searchUrls
    ? findUrlMatches(index, filterTextValue, getUrlIndex())
    : []
  const mergedResultsById = new Map<string, LocalSearchResult>()
  for (const result of rawResults) {
    result.substringMatched = result.terms.some((term) =>
      substringTerms?.has(term)
    )
    mergedResultsById.set(result.id, result)
  }
  for (const result of urlResults) {
    const existing = mergedResultsById.get(result.id)
    if (existing) {
      existing.score += result.score
      existing.urlMatched = true
      existing.urlMatchRank = result.urlMatchRank
      existing.urlMatchedStarred =
        existing.urlMatchedStarred || result.urlMatchedStarred
    } else {
      mergedResultsById.set(result.id, result)
    }
  }

  const sidebarItems = Array.isArray(sidebar) ? sidebar : []
  const currentResults: LocalSearchResult[] = [...mergedResultsById.values()]
    .filter((result) => !siteMatches || siteMatches.has(result.id))
    .map((r) => {
      const [id] = r.id.split('#')
      const cleanPath = '/' + id.replace(/\.html$/, '').replace(/^\//, '')
      const pageTitle = findPageTitle(sidebarItems, cleanPath)
      const titles = [...r.titles]

      if (pageTitle && !titles.includes(pageTitle) && r.title !== pageTitle) {
        titles.unshift(pageTitle)
      }

      return { ...r, titles }
    })
    .filter(
      (result) =>
        titlePatterns.every((pattern) =>
          [result.title, ...result.titles].some((title) => pattern.test(title))
        ) &&
        urlFilters.every((filter) =>
          metadata[result.id]?.u?.some((url) => url.includes(filter))
        )
    )

  // Complete single-word matches rank before expansions; these tiers break ties.
  // Ranking model:
  //   1. starredExact  \u2013 query exactly matches a starred-bold hyperlink
  //   2. exact         \u2013 query exactly matches any hyperlink
  //   3. starredPrefix \u2013 query is a prefix of a starred-bold hyperlink
  //   4. prefix        \u2013 query is a prefix of any hyperlink
  //   5. starredWord   \u2013 a query term is a word inside a starred hyperlink
  //   6. starredUrl    \u2013 a starred entry matched only on a link's URL
  //   7. linkWord      \u2013 a query term is a word inside any hyperlink
  //   8. linkUrl       \u2013 a non-starred entry matched only on a link's URL
  //   9. raw score (title/text match, etc.)
  // Bold-without-star is treated as a regular link (no special tier).
  // "Prefix"/"exact" compare the full query against the whole hyperlink text,
  // not against individual tokens. Strip zero-width characters from the
  // query to match the build-time normalization in extractLinkMetadata.
  // Rank unambiguous recoveries using their indexed spelling.
  const rankingText = recoveredTerms.size
    ? filterTextValue
        .split(/\s+/)
        .map((part) => {
          const term = tokenizeIndexLike(part)[0]
          const alternatives = recoveredTerms.get(term)
          if (!alternatives || getTermLookup().indexedTerms.has(term))
            return part
          const key = normalizeFuzzyTerm(alternatives[0])
          if (
            !alternatives.every(
              (candidate) => normalizeFuzzyTerm(candidate) === key
            )
          )
            return part
          return alternatives.includes(key) ? key : [...alternatives].sort()[0]
        })
        .join(' ')
    : filterTextValue
  const q = rankingText.replace(INVISIBLE_CHARS_RE, '').trim().toLowerCase()
  // Multiword fuzzy queries need all query words in one link to earn a word boost.
  const requiredLinkTerms =
    fuzzy && /\s/.test(q) && !looksLikeUrlQuery(q)
      ? [...new Set(tokenizeIndexLike(q))]
      : []

  const singleTerms =
    !options.urls && !isPhrase && !/\s/.test(q) && !looksLikeUrlQuery(q)
      ? tokenizeIndexLike(q)
      : []
  // Prefer complete words over prefix/substring expansions; Fuzzy tolerates spelling punctuation.
  const wordKey = fuzzy ? normalizeFuzzyTerm : (word: string) => word
  const singleKeys =
    singleTerms.length === 1
      ? new Set(
          [singleTerms[0], ...(recoveredTerms.get(singleTerms[0]) ?? [])].map(
            wordKey
          )
        )
      : undefined
  const directMatches =
    singleKeys !== undefined
      ? new Set<string>(
          currentResults
            .filter(
              (result) =>
                Object.keys(result.match).length > 0 &&
                result.terms.some((term) => singleKeys.has(wordKey(term)))
            )
            .map((result) => result.id)
        )
      : undefined

  const headingPattern = singleTerms.length === 1 ? createPhraseRegex(q) : null
  const boostedResults = currentResults.map((r) => {
    const meta = metadata[r.id]
    let hasStarredExact = false
    let hasExact = false
    let hasStarredPrefix = false
    let hasPrefix = false
    let hasStarredWord = false
    let hasLinkWord = false

    const lowerTerms = r.terms ? r.terms.map((t) => t.toLowerCase()) : []

    const processPhrases = (
      phrases: string[] | undefined,
      isStarred: boolean
    ) => {
      if (!phrases) return
      for (const phrase of phrases) {
        if (q && phrase === q) {
          hasExact = true
          if (isStarred) hasStarredExact = true
        } else if (q && phrase.startsWith(q)) {
          hasPrefix = true
          if (isStarred) hasStarredPrefix = true
        }
        if (
          lowerTerms.length > 0 &&
          !(isStarred ? hasStarredWord : hasLinkWord)
        ) {
          let tokens = phraseTokens.get(phrase)
          if (!tokens) {
            tokens = new Set(tokenizeIndexLike(phrase, true))
            phraseTokens.set(phrase, tokens)
          }
          const words = requiredLinkTerms.length > 1 ? [...tokens] : undefined
          const matches = words
            ? requiredLinkTerms.every((term) =>
                words.some((word) => word.startsWith(term))
              )
            : lowerTerms.some((term) => tokens.has(term))
          if (matches) {
            if (isStarred) hasStarredWord = true
            else hasLinkWord = true
          }
        }
      }
    }

    processPhrases(meta?.s, true)
    processPhrases(meta?.l, false)

    // URL matches hit the href, not the visible link text, so the phrase
    // tiers above never fire for them. Give them their own tier keyed off
    // whether the entry is starred, so a starred-link URL match interleaves
    // with the other curated results instead of sinking to the bottom on raw
    // score alone.
    const hasStarredUrl = !!r.urlMatchedStarred
    const hasLinkUrl = !!r.urlMatched && !hasStarredUrl

    return {
      ...r,
      matchesWithoutTerms:
        matchesWithoutTerms && Object.keys(r.match).length
          ? (removed: ReadonlySet<string>, includeHeadings?: boolean) =>
              matchesWithoutTerms(r, removed, includeHeadings)
          : undefined,
      hasStarredExact,
      hasExact,
      hasStarredPrefix,
      hasPrefix,
      hasStarredWord,
      hasStarredUrl,
      hasLinkWord,
      hasLinkUrl,
      hasHeadingMatch:
        !!headingPattern &&
        // Sidebar labels are display context; use the indexed heading hierarchy.
        [
          r.title,
          ...((index.getStoredFields(r.id) as Result | undefined)?.titles ?? [])
        ].some((title) => headingPattern.test(title)),
      isRecentlyRemoved: /^\/recently-removed(?:\.html)?(?:#|$)/.test(r.id)
    }
  })

  const tierKeys: (keyof BoostFlags)[] = [
    'hasExact',
    'hasStarredPrefix',
    'hasPrefix',
    'hasStarredWord',
    'hasStarredUrl',
    'hasLinkWord',
    'hasLinkUrl'
  ]

  boostedResults.sort((a, b) => {
    if (directMatches) {
      const difference =
        Number(directMatches.has(b.id)) - Number(directMatches.has(a.id))
      if (difference) return difference
    }
    // Retain exact starred names, then prefer headings over ordinary cross-references.
    if (a.hasStarredExact !== b.hasStarredExact)
      return a.hasStarredExact ? -1 : 1
    if (a.hasHeadingMatch !== b.hasHeadingMatch)
      return a.hasHeadingMatch ? -1 : 1
    for (const key of tierKeys) {
      const av = a[key] ? 1 : 0
      const bv = b[key] ? 1 : 0
      if (av !== bv) return bv - av
    }
    const urlRankDifference = (b.urlMatchRank ?? 0) - (a.urlMatchRank ?? 0)
    if (urlRankDifference) return urlRankDifference
    // Within the same match tier, prefer current recommendations over removals.
    if (a.isRecentlyRemoved !== b.isRecentlyRemoved)
      return a.isRecentlyRemoved ? 1 : -1
    if (b.score !== a.score) return b.score - a.score
    // Deterministic fallback for exact score ties so equal-scored results
    // don't reshuffle between fuzzy/exact modes (or re-renders). Compare by
    // title, then id, for a stable order.
    return (
      (a.title || '').localeCompare(b.title || '') || a.id.localeCompare(b.id)
    )
  })

  return {
    results: boostedResults.slice(0, MAX_RESULTS_IN_MEMORY)
  }
}

function spellingDistance(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  let previous = right.map((_, i) => i + 1)
  previous.unshift(0)
  let beforePrevious: number[] = []
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(left[i - 1] !== right[j - 1])
      )
      if (
        i > 1 &&
        j > 1 &&
        left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        current[j] = Math.min(current[j], beforePrevious[j - 2] + 1)
      }
    }
    beforePrevious = previous
    previous = current
  }
  return previous[right.length]
}

function suggestSearch(
  index: MiniSearch<Result>,
  text: string,
  links: ReturnType<typeof collectLinkTerms>,
  getTermLookup: () => ReturnType<typeof createTermLookup>
): string[] {
  const parsed = parseSearchQuery(text)
  const { text: query, isPhrase, sites } = parsed
  if (
    !query ||
    isPhrase ||
    sites.length ||
    parsed.excludedTerms.length ||
    parsed.excludedSites.length ||
    parsed.titles.length ||
    parsed.urls.length ||
    parsed.branches.length
  )
    return []

  try {
    const { indexedTerms, aliases } = getTermLookup()
    const words = query.split(/\s+/)
    if (words.length > 1) {
      const suggestions = new Set<string>()
      // Join one adjacent pair only when it identifies an indexed curated name.
      for (let i = 0; i < words.length - 1; i++) {
        const joined = normalizeFuzzyTerm(words[i] + words[i + 1])
        const compounds =
          aliases.get(joined) ?? (indexedTerms.has(joined) ? [joined] : [])
        for (const compound of compounds) {
          const corrected = [
            ...words.slice(0, i),
            compound,
            ...words.slice(i + 2)
          ].join(' ')
          if (
            !links.globalLinkPhrases.has(
              corrected.replace(INVISIBLE_CHARS_RE, '').toLowerCase()
            )
          )
            continue
          if (
            index.search(corrected, {
              combineWith: 'AND',
              fuzzy: false,
              prefix: false
            }).length
          ) {
            suggestions.add(corrected)
            if (suggestions.size === MAX_SUGGESTIONS) return [...suggestions]
          }
        }
      }
      if (suggestions.size) return [...suggestions]
      for (const [i, word] of words.entries()) {
        if (tokenizeIndexLike(word).every((term) => indexedTerms.has(term)))
          continue
        for (const replacement of suggestSearch(
          index,
          word,
          links,
          getTermLookup
        )) {
          const corrected = [...words]
          corrected[i] = replacement
          const suggestion = corrected.join(' ')
          if (
            index.search(suggestion, {
              combineWith: 'AND',
              fuzzy: false,
              prefix: false
            }).length > 0
          ) {
            suggestions.add(suggestion)
            if (suggestions.size === MAX_SUGGESTIONS) return [...suggestions]
          }
        }
      }
      return [...suggestions]
    }

    const rawSuggestions = index.autoSuggest(query, {
      fuzzy: (term) => (term.length >= 5 ? 2 : 1),
      prefix: true
    }) as { suggestion: string; terms: string[]; score: number }[]

    const { globalStarredLinks, globalLinks } = links

    const cleanQuery = query.toLowerCase()
    const candidates = new Map(
      rawSuggestions.map((suggestion) => [suggestion.suggestion, suggestion])
    )
    for (const term of getTermLookup().alternatives(query)) {
      if (!candidates.has(term))
        candidates.set(term, { suggestion: term, terms: [term], score: 0 })
    }
    const foldedQuery = normalizeFuzzyTerm(cleanQuery)
    const sortedSuggestions = [...candidates.values()]
      .map((candidate) => ({
        ...candidate,
        distance: spellingDistance(
          foldedQuery,
          normalizeFuzzyTerm(candidate.suggestion)
        )
      }))
      .sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance
        const aSug = a.suggestion.toLowerCase()
        const bSug = b.suggestion.toLowerCase()

        const aPrefix = aSug.startsWith(cleanQuery) ? 1 : 0
        const bPrefix = bSug.startsWith(cleanQuery) ? 1 : 0
        if (aPrefix !== bPrefix) return bPrefix - aPrefix

        const aStarred = globalStarredLinks.has(aSug) ? 1 : 0
        const bStarred = globalStarredLinks.has(bSug) ? 1 : 0
        if (aStarred !== bStarred) return bStarred - aStarred

        const aLink = globalLinks.has(aSug) ? 1 : 0
        const bLink = globalLinks.has(bSug) ? 1 : 0
        if (aLink !== bLink) return bLink - aLink

        return (b.score || 0) - (a.score || 0) || aSug.localeCompare(bSug)
      })

    return sortedSuggestions
      .map((s) => s.suggestion)
      .filter((s) => s && !/\s/.test(s) && s !== query.toLowerCase())
      .slice(0, MAX_SUGGESTIONS)
  } catch {
    return []
  }
}

export function loadSearchIndex(
  rawIndex: string | (AsPlainObject & { customMetadata?: SearchMetadata }),
  options?: Partial<Options<Result>>,
  searchOptions?: SearchOptions
) {
  let parsed: AsPlainObject & { customMetadata?: SearchMetadata }
  try {
    parsed = typeof rawIndex === 'string' ? JSON.parse(rawIndex) : rawIndex
  } catch {
    return null
  }
  return {
    metadata: parsed?.customMetadata || {},
    index: MiniSearch.loadJS<Result>(parsed, {
      fields: ['title', 'titles', 'text'],
      storeFields: ['title', 'titles'],
      tokenize: (text: string) => tokenizeSearchText(text).filter(Boolean),
      searchOptions: {
        fuzzy: false,
        prefix: true,
        boost: { title: 4, text: 2, titles: 1 },
        ...searchOptions
      },
      ...options
    })
  }
}

export function createSearchEngine(
  index: MiniSearch<Result>,
  metadata: SearchMetadata,
  sidebar: SidebarItem[] = []
) {
  // Upgrade-sensitive MiniSearch internal: recheck substring expansion after upgrades.
  // MiniSearch has no public term iterator; keep this compatibility access local.
  const internal = index as unknown as { _index?: Map<string, unknown> }
  const terms = internal._index ? [...internal._index.keys()] : []
  const phraseTokens = new Map<string, Set<string>>()
  let urlIndex: UrlRecord[] | undefined
  let links: ReturnType<typeof collectLinkTerms> | undefined
  let termLookup: ReturnType<typeof createTermLookup> | undefined
  const getTermLookup = () => (termLookup ??= createTermLookup(terms))
  return {
    search(query: string, options: { fuzzy: boolean; urls: boolean }) {
      return runSearch(
        index,
        metadata,
        terms,
        query,
        options,
        sidebar,
        phraseTokens,
        () => (urlIndex ??= buildUrlIndex(metadata)),
        getTermLookup
      )
    },
    suggest(query: string) {
      return suggestSearch(
        index,
        query,
        (links ??= collectLinkTerms(metadata)),
        getTermLookup
      )
    }
  }
}
