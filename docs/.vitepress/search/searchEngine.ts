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

interface CachedLinkPhrase {
  tokens?: Set<string>
  foldedName?: string
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

function createTermLookup(terms: string[], metadata: SearchMetadata) {
  const indexedTerms = new Set(terms)
  const recognizedPrefixes = new Map<string, boolean>()
  const recognizes = (term: string) => {
    if (indexedTerms.has(term)) return true
    const cached = recognizedPrefixes.get(term)
    if (cached !== undefined) return cached
    const found = terms.some((candidate) => candidate.startsWith(term))
    recognizedPrefixes.set(term, found)
    return found
  }
  const aliases = new Map<string, string[]>()
  for (const term of terms) {
    const key = normalizeFuzzyTerm(term)
    if (!key || key === term) continue
    const group = aliases.get(key)
    if (group) group.push(term)
    else aliases.set(key, indexedTerms.has(key) ? [key, term] : [term])
  }
  const compoundPhrases = new Map<string, Set<string>>()
  const compoundPrefixes = new Map<string, string[]>()
  const resourcePhrases = new Set<string>()
  const curatedTerms = new Set<string>()
  for (const item of Object.values(metadata)) {
    const auxiliary = new Set(item.a)
    for (const phrase of item.s ?? [])
      if (!auxiliary.has(phrase))
        for (const term of tokenizeIndexLike(phrase, true))
          curatedTerms.add(term)
    for (const phrase of [...(item.s ?? []), ...(item.l ?? [])])
      if (!auxiliary.has(phrase)) resourcePhrases.add(phrase)
  }
  for (const phrase of resourcePhrases) {
    const words = phrase.split(/\s+/).map((word) => tokenizeIndexLike(word))
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i].length !== 1 || words[i + 1].length !== 1) continue
      const pair = [words[i][0], words[i + 1][0]]
      const key = normalizeFuzzyTerm(pair.join(''))
      if (key.length < 5) continue
      const group = compoundPhrases.get(key) ?? new Set<string>()
      group.add(pair.join(' '))
      compoundPhrases.set(key, group)
    }
  }
  const curatedByLength = new Map<
    number,
    { term: string; letters: string[] }[]
  >()
  for (const term of curatedTerms) {
    const letters = Array.from(normalizeFuzzyTerm(term))
    const group = curatedByLength.get(letters.length) ?? []
    group.push({ term, letters })
    curatedByLength.set(letters.length, group)
  }
  const spellingRecoveries = new Map<string, string[]>()
  return {
    indexedTerms,
    recognizes,
    aliases,
    joinedAliases(words: string[]) {
      // Only unfamiliar splits receive a curated-name alternative.
      if (
        words.length !== 2 ||
        words.every((word) => {
          const tokens = tokenizeIndexLike(word)
          return (
            tokens.length > 0 && tokens.every((term) => indexedTerms.has(term))
          )
        })
      )
        return []
      const key = normalizeFuzzyTerm(words.join(''))
      const candidates =
        aliases.get(key) ?? (indexedTerms.has(key) ? [key] : [])
      return candidates.some((term) => curatedTerms.has(term)) ? candidates : []
    },
    compounds(word: string) {
      const tokens = tokenizeIndexLike(word)
      if (tokens.length !== 1) return []
      const key = normalizeFuzzyTerm(tokens[0])
      const exact = compoundPhrases.get(key)
      if (exact) return [...exact]
      if (key.length < 5 || indexedTerms.has(key) || aliases.has(key)) return []
      const cached = compoundPrefixes.get(key)
      if (cached) return cached
      const matches = new Set<string>()
      for (const [joined, phrases] of compoundPhrases) {
        if (!joined.startsWith(key)) continue
        for (const phrase of phrases) {
          // Keep the first word complete; only the final word may be a prefix.
          for (let end = phrase.indexOf(' ') + 4; end < phrase.length; end++) {
            const prefix = phrase.slice(0, end)
            if (normalizeFuzzyTerm(prefix.replace(' ', '')) === key) {
              matches.add(prefix)
              break
            }
          }
        }
      }
      const prefixes = [...matches]
      compoundPrefixes.set(key, prefixes)
      return prefixes
    },
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
      const cached = spellingRecoveries.get(key)
      if (cached) return cached
      // A valid literal prefix is not a misspelling.
      if (recognizes(term)) return []
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
      // Prefer a one-letter gap in a curated name over weaker fuzzy guesses.
      const normalized = Array.from(key)
      if (!matches.size && normalized.length >= 5)
        for (const length of [normalized.length - 1, normalized.length + 1])
          for (const candidate of curatedByLength.get(length) ?? []) {
            const shorter =
              length < normalized.length ? candidate.letters : normalized
            const longer =
              length < normalized.length ? normalized : candidate.letters
            let gap = 0
            while (gap < shorter.length && shorter[gap] === longer[gap]) gap++
            if (
              shorter.every(
                (letter, i) => letter === longer[i + (i >= gap ? 1 : 0)]
              )
            )
              matches.add(candidate.term)
          }
      const recovered = [...matches]
      spellingRecoveries.set(key, recovered)
      return recovered
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
    entryMatch:
      (b.entryMatch?.entries?.[0]?.rank ?? -1) >
      (a.entryMatch?.entries?.[0]?.rank ?? -1)
        ? b.entryMatch
        : (a.entryMatch ?? b.entryMatch),
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
  phraseCache: Map<string, CachedLinkPhrase>,
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
          phraseCache,
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
  let joinedTerms: string[] = []
  const entryPhraseGroups: string[][] = []
  const canRecoverTerms = fuzzy && !looksLikeUrlQuery(filterTextValue)
  const queryFuzzyTolerance = (term: string) => {
    const tolerance = fuzzyTolerance(term)
    if (!tolerance || !canRecoverTerms) return tolerance
    return recoveredTerms.has(term) || getTermLookup().recognizes(term)
      ? false
      : tolerance
  }
  if (fuzzy) {
    const parts = filterTextValue.split(/\s+/).filter((p) => p)
    if (canRecoverTerms && !parsed.phrases.length && parts.length === 2)
      joinedTerms = getTermLookup().joinedAliases(parts)
    if (parts.length > 0) {
      const dashed = parts.join('-')
      query = {
        combineWith: 'OR',
        queries: [
          {
            queries: parts.map((part): Query => {
              const lookup =
                canRecoverTerms && !looksLikeUrlQuery(part)
                  ? getTermLookup()
                  : undefined
              const alternatives = lookup?.alternatives(part) ?? []
              const compounds = lookup?.compounds(part) ?? []
              if (compounds.length) entryPhraseGroups.push([part, ...compounds])
              if (!alternatives.length && !compounds.length) return part
              const queries: Query[] = [
                { queries: [part], fuzzy: queryFuzzyTolerance }
              ]
              if (alternatives.length) {
                recoveredTerms.set(tokenizeIndexLike(part)[0], alternatives)
                queries.push({
                  queries: alternatives,
                  combineWith: 'OR',
                  fuzzy: false,
                  prefix:
                    normalizeFuzzyTerm(alternatives[0]) !==
                      normalizeFuzzyTerm(part) &&
                    alternatives.every(
                      (term) =>
                        normalizeFuzzyTerm(term) ===
                        normalizeFuzzyTerm(alternatives[0])
                    )
                })
              }
              for (const phrase of compounds)
                queries.push({
                  queries: [phrase],
                  combineWith: 'AND',
                  fuzzy: false,
                  prefix: true
                })
              return { combineWith: 'OR', queries }
            }),
            combineWith: 'AND',
            fuzzy: queryFuzzyTolerance
          },
          {
            queries: [dashed],
            combineWith: 'AND',
            fuzzy: queryFuzzyTolerance
          },
          ...(joinedTerms.length
            ? [
                {
                  queries: joinedTerms,
                  combineWith: 'OR' as const,
                  fuzzy: false,
                  prefix: true
                }
              ]
            : [])
        ]
      }
    }
  }

  /**
   * Suffix Search / Substring Matching:
   * Find index terms containing the query as a substring
   * (e.g. "abolic" → "parabolic") using the pre-cached term key list.
   */
  if (
    !isPhrase &&
    !looksLikeUrlQuery(filterTextValue) &&
    !(fuzzy && filterTextValue.length < 5 && /[#+]/.test(filterTextValue)) &&
    (!/\s/.test(filterTextValue) || joinedTerms.length > 0) &&
    filterTextValue.length > 2
  ) {
    const candidateTerms: string[] = []
    const match = joinedTerms.length
      ? normalizeFuzzyTerm(filterTextValue.replace(/\s/g, ''))
      : filterTextValue.toLowerCase()
    const recovered = [
      ...(recoveredTerms.get(tokenizeIndexLike(filterTextValue)[0]) ?? []),
      ...joinedTerms
    ]
    for (const term of cachedTermKeys) {
      if (
        (term.includes(match) && term !== match) ||
        (recovered.length > 0 &&
          recovered.some((needle) => term.includes(needle) && term !== needle))
      ) {
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
        queries: fuzzy
          ? [
              query,
              {
                queries: capped,
                combineWith: 'OR',
                fuzzy: false,
                prefix: false
              }
            ]
          : [filterTextValue, ...capped]
      }
    }
  }

  // fuzzy only matters for string queries; structured queries carry their own per-clause fuzzy
  const searchOptions = {
    combineWith: 'AND' as const,
    fuzzy: fuzzy && typeof query === 'string' ? queryFuzzyTolerance : false,
    ...(isPhrase ? { prefix: false } : {})
  }

  const withHeadingContext =
    fuzzy &&
    !entryPhraseGroups.length &&
    !looksLikeUrlQuery(filterTextValue) &&
    tokenizeIndexLike(filterTextValue).length > 1
  const matchesWithoutTerms =
    fuzzy &&
    (parsed.excludedTerms.length ||
      parsed.excludedSites.length ||
      sites.length ||
      urls.length ||
      parsed.phrases.length ||
      entryPhraseGroups.length ||
      withHeadingContext)
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
  const programmingSuffixes = fuzzy
    ? tokenizeIndexLike(filterTextValue).flatMap(
        (term) => term.match(/[#+]+$/)?.[0] ?? []
      )
    : []
  for (const result of rawResults) {
    if (
      !programmingSuffixes.every((suffix) =>
        result.terms.some((term) => term.match(/[#+]+/)?.[0] === suffix)
      )
    )
      continue
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
  const rankingText = joinedTerms.length
    ? [...joinedTerms].sort()[0]
    : recoveredTerms.size
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
            return alternatives.includes(key)
              ? key
              : [...alternatives].sort()[0]
          })
          .join(' ')
      : filterTextValue
  const q = rankingText.replace(INVISIBLE_CHARS_RE, '').trim().toLowerCase()
  const nameQuery = fuzzy ? normalizeFuzzyTerm(q) : q
  // Multiword fuzzy queries need all query words in one link to earn a word boost.
  const requiredLinkTerms =
    fuzzy && /\s/.test(q) && !looksLikeUrlQuery(q)
      ? [...new Set(tokenizeIndexLike(q))]
      : []

  const matchingPhrases =
    entryPhraseGroups.length === 1 && !/\s/.test(q)
      ? entryPhraseGroups[0]
      : undefined

  const singleTerms =
    !isPhrase && !/\s/.test(q) && !looksLikeUrlQuery(q)
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

  const headingPhrases =
    singleTerms.length === 1 ||
    (!isPhrase && /\s/.test(q) && !looksLikeUrlQuery(q)) ||
    matchingPhrases
      ? (matchingPhrases ?? [q])
      : []
  const headingPatterns = headingPhrases.map((phrase) => ({
    pattern: createPhraseRegex(phrase),
    prefix: /\s/.test(phrase) ? phrase.toLowerCase() : ''
  }))
  const boostedResults = currentResults.map((r) => {
    const meta = metadata[r.id]
    const auxiliaryLabels = new Set(meta?.a)
    let hasStarredExact = false
    let hasExact = false
    let hasStarredPrefix = false
    let hasPrefix = false
    let hasStarredWord = false
    let hasLinkWord = false
    let hasAuxiliaryWord = false

    const lowerTerms = r.terms ? r.terms.map((t) => t.toLowerCase()) : []

    const processPhrases = (
      phrases: string[] | undefined,
      isStarred: boolean
    ) => {
      if (!phrases) return
      for (const phrase of phrases) {
        const auxiliary = auxiliaryLabels.has(phrase)
        let cached = phraseCache.get(phrase)
        if (!cached) {
          cached = {}
          phraseCache.set(phrase, cached)
        }
        const name = fuzzy
          ? (cached.foldedName ??= normalizeFuzzyTerm(phrase))
          : phrase
        if (!auxiliary && nameQuery && name === nameQuery) {
          hasExact = true
          if (isStarred) hasStarredExact = true
        } else if (!auxiliary && nameQuery && name.startsWith(nameQuery)) {
          hasPrefix = true
          if (isStarred) hasStarredPrefix = true
        }
        if (
          lowerTerms.length > 0 &&
          (auxiliary || !(isStarred ? hasStarredWord : hasLinkWord))
        ) {
          const tokens = (cached.tokens ??= new Set(
            tokenizeIndexLike(phrase, true)
          ))
          const words = requiredLinkTerms.length > 1 ? [...tokens] : []
          const matches = matchingPhrases
            ? matchingPhrases.some((form) =>
                phrase.includes(form.toLowerCase())
              )
            : requiredLinkTerms.length > 1
              ? requiredLinkTerms.every((term) =>
                  words.some((word) => word.startsWith(term))
                )
              : lowerTerms.some((term) => tokens.has(term))
          if (matches) {
            if (auxiliary) hasAuxiliaryWord = true
            else if (isStarred) hasStarredWord = true
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

    const indexedTitles =
      (index.getStoredFields(r.id) as Result | undefined)?.titles ?? []
    const hasHeadingMatch =
      // Sidebar labels are display context; use the indexed heading hierarchy.
      [r.title, ...indexedTitles].some((title) =>
        headingPatterns.some(
          ({ pattern, prefix }) =>
            pattern.test(title) ||
            (!!prefix && title.toLowerCase().startsWith(prefix))
        )
      )
    const hasDirectWord =
      !!directMatches?.has(r.id) &&
      !(hasAuxiliaryWord && !hasStarredWord && !hasLinkWord && !hasHeadingMatch)

    return {
      ...r,
      entryMatch:
        entryPhraseGroups.length ||
        withHeadingContext ||
        (q && r.urlMatched && !Object.keys(r.match).length)
          ? {
              groups: entryPhraseGroups,
              withHeadingContext,
              // Language-specific subsections inherit their language heading.
              headings:
                withHeadingContext && !r.id.startsWith('/non-english#')
                  ? [r.title]
                  : [r.title, ...indexedTitles],
              auxiliary: meta?.a ?? []
            }
          : undefined,
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
      hasHeadingMatch,
      hasDirectWord,
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
        Number(b.hasDirectWord || (options.urls && b.urlMatchRank === 3)) -
        Number(a.hasDirectWord || (options.urls && a.urlMatchRank === 3))
      if (difference) return difference
    }
    // An inherited heading must not lift removals above equally direct active matches.
    if (
      a.isRecentlyRemoved !== b.isRecentlyRemoved &&
      (!directMatches || a.hasDirectWord === b.hasDirectWord)
    )
      return a.isRecentlyRemoved ? 1 : -1
    // Retain exact starred names, then prefer headings over ordinary cross-references.
    if (a.hasStarredExact !== b.hasStarredExact)
      return a.hasStarredExact ? -1 : 1
    const exactStarredUrlDifference =
      Number(b.hasStarredUrl && b.urlMatchRank === 3) -
      Number(a.hasStarredUrl && a.urlMatchRank === 3)
    if (exactStarredUrlDifference) return exactStarredUrlDifference
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
    looksLikeUrlQuery(query) ||
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
    const programmingSuffix = query.match(/[#+]+$/)?.[0]
    if (words.length === 1) {
      if (programmingSuffix && query.length - programmingSuffix.length < 3)
        return []
      const compounds = getTermLookup()
        .compounds(query)
        .filter(
          (phrase) =>
            index.search(phrase, {
              combineWith: 'AND',
              fuzzy: false,
              prefix: true
            }).length > 0
        )
      if (compounds.length) return compounds.sort().slice(0, MAX_SUGGESTIONS)
    }
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
    const recognizedQuery = getTermLookup().recognizes(cleanQuery)
    const sortedSuggestions = [...candidates.values()]
      .filter(
        (candidate) =>
          !programmingSuffix ||
          candidate.suggestion.match(/[#+]+/)?.[0] === programmingSuffix
      )
      .map((candidate) => ({
        ...candidate,
        distance: spellingDistance(
          foldedQuery,
          normalizeFuzzyTerm(candidate.suggestion)
        )
      }))
      .filter((candidate) => !recognizedQuery || candidate.distance === 0)
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

    const bestDistance = sortedSuggestions[0]?.distance
    return sortedSuggestions
      .filter((candidate) => candidate.distance === bestDistance)
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
  const phraseCache = new Map<string, CachedLinkPhrase>()
  let urlIndex: UrlRecord[] | undefined
  let links: ReturnType<typeof collectLinkTerms> | undefined
  let termLookup: ReturnType<typeof createTermLookup> | undefined
  const getTermLookup = () => (termLookup ??= createTermLookup(terms, metadata))
  return {
    search(query: string, options: { fuzzy: boolean; urls: boolean }) {
      return runSearch(
        index,
        metadata,
        terms,
        query,
        options,
        sidebar,
        phraseCache,
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
