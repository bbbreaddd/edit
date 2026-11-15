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
  normalizeSearchUrl,
  parseSearchQuery,
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
  for (const key in customMetadata) {
    const item = customMetadata[key]
    if (item.s) {
      for (const phrase of item.s) {
        for (const w of tokenizeIndexLike(phrase, true)) {
          globalStarredLinks.add(w)
        }
      }
    }
    if (item.l) {
      for (const phrase of item.l) {
        for (const w of tokenizeIndexLike(phrase, true)) {
          globalLinks.add(w)
        }
      }
    }
  }
  return { globalStarredLinks, globalLinks }
}

function fuzzyTolerance(term: string) {
  if (term.length < 5) return false
  return term.length < 9 ? 1 : 2
}

function runSearch(
  index: MiniSearch<Result>,
  metadata: SearchMetadata,
  cachedTermKeys: string[],
  filterTextValue: string,
  options: { fuzzy: boolean; urls: boolean },
  sidebar: SidebarItem[],
  phraseTokens: Map<string, Set<string>>,
  getUrlIndex: () => UrlRecord[]
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
          getUrlIndex
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
        if (previous) previous.searchBranches!.push(branches[i])
        else merged.set(result.id, { ...result, searchBranches: [branches[i]] })
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
  const urlFilters = urls.map((url) => normalizeSearchUrl(url.toLowerCase()))
  const fuzzy = options.fuzzy && !isPhrase
  let substringTerms: Set<string> | undefined
  let query: Query = filterTextValue

  if (fuzzy) {
    const parts = filterTextValue.split(/\s+/).filter((p) => p)
    if (parts.length > 0) {
      const dashed = parts.join('-')
      query = {
        combineWith: 'OR',
        queries: [
          {
            queries: parts,
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
  const q = filterTextValue.replace(INVISIBLE_CHARS_RE, '').trim().toLowerCase()
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
  const wordKey = (word: string) =>
    fuzzy
      ? word.normalize('NFD').replace(/\p{M}/gu, '').replace(/[-'’]/g, '')
      : word
  const singleKey =
    singleTerms.length === 1 ? wordKey(singleTerms[0]) : undefined
  const directMatches =
    singleKey !== undefined
      ? new Set<string>(
          currentResults
            .filter(
              (result) =>
                Object.keys(result.match).length > 0 &&
                result.terms.some((term) => wordKey(term) === singleKey)
            )
            .map((result) => result.id)
        )
      : undefined

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
      hasStarredExact,
      hasExact,
      hasStarredPrefix,
      hasPrefix,
      hasStarredWord,
      hasStarredUrl,
      hasLinkWord,
      hasLinkUrl
    }
  })

  const tierKeys: (keyof BoostFlags)[] = [
    'hasStarredExact',
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
    for (const key of tierKeys) {
      const av = a[key] ? 1 : 0
      const bv = b[key] ? 1 : 0
      if (av !== bv) return bv - av
    }
    const urlRankDifference = (b.urlMatchRank ?? 0) - (a.urlMatchRank ?? 0)
    if (urlRankDifference) return urlRankDifference
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

function suggestSearch(
  index: MiniSearch<Result>,
  text: string,
  links: ReturnType<typeof collectLinkTerms>,
  indexedTerms: Set<string>
): string[] {
  const { text: query, isPhrase, sites } = parseSearchQuery(text)
  const parsed = parseSearchQuery(text)
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
    const words = query.split(/\s+/)
    if (words.length > 1) {
      const suggestions = new Set<string>()
      for (const [i, word] of words.entries()) {
        if (tokenizeIndexLike(word).every((term) => indexedTerms.has(term)))
          continue
        for (const replacement of suggestSearch(
          index,
          word,
          links,
          indexedTerms
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
    const sortedSuggestions = [...rawSuggestions].sort((a, b) => {
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

      return (b.score || 0) - (a.score || 0)
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
  let indexedTerms: Set<string> | undefined
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
        () => (urlIndex ??= buildUrlIndex(metadata))
      )
    },
    suggest(query: string) {
      return suggestSearch(
        index,
        query,
        (links ??= collectLinkTerms(metadata)),
        (indexedTerms ??= new Set(terms))
      )
    }
  }
}
