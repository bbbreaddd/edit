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
  INVISIBLE_CHARS_RE,
  tokenizeIndexLike,
  tokenizeSearchText
} from './normalization'
import {
  buildUrlIndex,
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
  let substringTerms: Set<string> | undefined
  let query: Query = filterTextValue

  if (options.fuzzy) {
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
  if (!options.fuzzy && filterTextValue.length > 2) {
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
    fuzzy: options.fuzzy && typeof query === 'string' ? fuzzyTolerance : false
  }

  const queryLooksLikeUrl = isExplicitUrlQuery(filterTextValue)
  // Pasted URLs should search URLs only. Running the normal text index too
  // turns URL punctuation into generic terms and leaks unrelated results.
  const rawResults = queryLooksLikeUrl
    ? []
    : (index.search(query, searchOptions) as LocalSearchResult[])
  const searchUrls = options.urls || looksLikeUrlQuery(filterTextValue)
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
  const currentResults: LocalSearchResult[] = [
    ...mergedResultsById.values()
  ].map((r) => {
    const [id] = r.id.split('#')
    const cleanPath = '/' + id.replace(/\.html$/, '').replace(/^\//, '')
    const pageTitle = findPageTitle(sidebarItems, cleanPath)
    const titles = [...r.titles]

    if (pageTitle && !titles.includes(pageTitle) && r.title !== pageTitle) {
      titles.unshift(pageTitle)
    }

    return { ...r, titles }
  })

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
          if (lowerTerms.some((t) => tokens.has(t))) {
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
  links: ReturnType<typeof collectLinkTerms>
): string[] {
  const query = text.trim()
  if (/\s/.test(query)) return []

  try {
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
      return suggestSearch(index, query, (links ??= collectLinkTerms(metadata)))
    }
  }
}
