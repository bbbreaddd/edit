import type { useData } from 'vitepress/dist/client/theme-default/composables/data'
import type { Component, Slots } from 'vue'
import type {
  LocalSearchResult,
  Result,
  SearchEntryMatch,
  SearchMatchEvidence,
  SearchMetadata,
  SidebarItem
} from './types'
import MiniSearch from 'minisearch'
import { dataSymbol } from 'vitepress'
import { pathToFile } from 'vitepress/dist/client/app/utils'
import { createApp, h } from 'vue'
import CriticalBadge from '../theme/components/CriticalBadge.vue'
import Tooltip from '../theme/components/Tooltip.vue'
import { getSearchEntryText, SEARCH_ENTRY_SELECTOR } from './matchHighlighting'
import {
  createPhraseRegex,
  normalizeSearchText as normalizeExcerptText,
  normalizeFuzzyTerm,
  normalizeSearchUrl,
  normalizeUrlFilters,
  parseSearchQuery,
  processSearchTerm,
  tokenizeIndexLike,
  tokenizeSearchText
} from './normalization'
import {
  compareEntryMatches,
  createSearchEngine,
  describeEntryMatch,
  MAX_RESULTS_IN_MEMORY,
  mergeSearchMatches
} from './searchEngine'
import {
  buildUrlQuery,
  createSiteMatcher,
  looksLikeUrlQuery,
  normalizeUrlSearchValue,
  urlMatchesNormalizedUrl
} from './urlMatching'

interface SearchExcerpt {
  html: string
  blocks?: string[]
}

export const excerptCache = new Map<string, Map<string, SearchExcerpt>>()

function lookupExcerpt(resultId: string): SearchExcerpt | undefined {
  const hashIndex = resultId.indexOf('#')
  if (hashIndex === -1) return undefined
  const pageId = resultId.slice(0, hashIndex)
  const map = excerptCache.get(pageId)
  if (!map) return undefined
  const anchor = resultId.slice(hashIndex + 1)
  const direct = map.get(anchor)
  if (direct) return direct
  // The search index (buildSearchIndex.ts) and the excerpt DOM derive heading slugs
  // from two separate render passes that can disagree: e.g. an emoji in a
  // heading is dropped from the index slug ("stars-added") but baked into the
  // mounted component's slug ("stars-added-⭐"). Recover by matching the index
  // anchor as a prefix of a DOM key — but only when exactly one key matches, so
  // an ambiguous prefix never silently returns a sibling section's excerpt.
  const prefix = anchor + '-'
  let found: SearchExcerpt | undefined
  for (const [key, excerpt] of map) {
    if (!key.startsWith(prefix)) continue
    if (found !== undefined) return undefined
    found = excerpt
  }
  return found
}

export function lookupExcerptText(resultId: string): string {
  return lookupExcerpt(resultId)?.html ?? ''
}

export async function fetchExcerpt(id: string) {
  const hashIndex = id.indexOf('#')
  const cleanId = hashIndex === -1 ? id : id.slice(0, hashIndex)
  const file = pathToFile(cleanId)
  try {
    if (!file) throw new Error(`Cannot find file for id: ${id}`)
    return { id, mod: await import(/*@vite-ignore*/ file) }
  } catch (e) {
    console.error(e)
    return { id, mod: {} }
  }
}

export async function loadExcerpts(
  results: LocalSearchResult[],
  vitePressData: ReturnType<typeof useData>,
  isCanceled: () => boolean
) {
  const pages = new Set(results.map((result) => result.id.split('#')[0]))
  const missing = [...pages].filter((page) => !excerptCache.has(page))
  if (!missing.length || isCanceled()) return
  const mods = await Promise.all(missing.map(fetchExcerpt))
  if (!isCanceled()) await processExcerpts(mods, vitePressData, isCanceled)
}

interface ComponentModule {
  default?: unknown
  render?: unknown
  setup?: unknown
}

const VDropdownStub = {
  name: 'VDropdown',
  setup(_props: unknown, { slots }: { slots: Slots }) {
    return () => h('span', { class: 'v-popper' }, slots.default?.())
  }
}

export async function processExcerpts(
  mods: { id: string; mod: ComponentModule }[],
  vitePressData: ReturnType<typeof useData>,
  isCanceled: () => boolean
) {
  for (const { id, mod } of mods) {
    if (isCanceled()) return
    const hashIndex = id.indexOf('#')
    const mapId = hashIndex === -1 ? id : id.slice(0, hashIndex)
    if (excerptCache.has(mapId)) continue
    const map = new Map<string, SearchExcerpt>()
    const comp = (mod.default ?? mod) as ComponentModule
    if (comp && typeof comp === 'object' && (comp.render || comp.setup)) {
      try {
        const app = createApp(comp as Component)
        app.component('VDropdown', VDropdownStub)
        app.component('CriticalBadge', CriticalBadge)
        app.component('Tooltip', Tooltip)
        app.config.warnHandler = () => {}
        app.provide(dataSymbol, vitePressData)
        Object.defineProperties(app.config.globalProperties, {
          $frontmatter: {
            get() {
              return vitePressData.frontmatter.value
            }
          },
          $params: {
            get() {
              return vitePressData.page.value.params
            }
          }
        })
        const div = document.createElement('div')
        app.mount(div)
        try {
          const headings = div.querySelectorAll('h1, h2, h3, h4, h5, h6')
          headings.forEach((heading) => {
            // VitePress sets the heading's id and its anchor href to the same
            // slug, so one key suffices; fall back to id if the anchor link is
            // missing for any reason.
            const href = heading.querySelector('a')?.getAttribute('href')
            const anchor = href?.startsWith('#')
              ? href.slice(1)
              : (heading.getAttribute('id') ?? undefined)
            if (!anchor) return
            let html = ''
            let next: Element | null = heading.nextElementSibling
            while (next && !/^h[1-6]$/i.test(next.tagName)) {
              // Skip note/infobox custom blocks (:::tip/:::info/:::warning/
              // :::danger) so the excerpt highlights the real curated link
              // instead of a note that merely mentions the query. Mirrors the
              // index-time strip in buildSearchIndex.ts so preview and ranking agree.
              const cls = next.classList
              const isNoteBlock =
                cls.contains('custom-block') &&
                (cls.contains('tip') ||
                  cls.contains('info') ||
                  cls.contains('warning') ||
                  cls.contains('danger'))
              if (!isNoteBlock) html += next.outerHTML
              next = next.nextElementSibling
            }
            map.set(anchor, { html })
          })
          excerptCache.set(mapId, map)
        } finally {
          app.unmount()
        }
      } catch (e) {
        console.error('Error processing excerpt for ' + id, e)
      }
    }
  }
}

function collectSearchBlocks(root: DocumentFragment | Element): string[] {
  const blocks: string[] = []
  let owner: Node | undefined
  let parts: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (parent?.closest('script, style')) continue
    const block = parent?.closest('p, li, pre, tr, blockquote, div') ?? root
    if (block !== owner) {
      if (parts.length) blocks.push(normalizeExcerptText(parts.join('')))
      parts = []
      owner = block
    }
    parts.push(node.textContent ?? '')
  }
  if (parts.length) blocks.push(normalizeExcerptText(parts.join('')))
  return blocks.filter(Boolean)
}

function collectIconLabels(root: DocumentFragment | Element): string {
  return [...root.querySelectorAll('[alt]')]
    .map((icon) => icon.getAttribute('alt') ?? '')
    .join(' ')
}

function stripSearchNoteLinks(root: Element | DocumentFragment) {
  root
    .querySelectorAll(
      'criticalbadge a, .critical-badge-hidden-body a, .tooltip-source-link'
    )
    .forEach((link) => link.replaceWith(link.textContent ?? ''))
}

export function filterResults(
  results: LocalSearchResult[],
  filterTextValue: string,
  allowMissingText = true,
  fuzzy = false
) {
  const parsed = parseSearchQuery(filterTextValue)
  if (parsed.branches.length <= 1)
    return filterQueryResults(results, parsed, allowMissingText, fuzzy).results

  const matches = new Map<
    string,
    { result: LocalSearchResult; excluded: Set<number> }
  >()
  for (const branch of parsed.branches) {
    const eligible = results
      .filter((result) => result.searchBranches?.includes(branch))
      .map((result) => ({
        ...result,
        ...result.branchMatches?.[branch],
        text: result.text
      }))
    const filtered = filterQueryResults(
      eligible,
      parseSearchQuery(branch),
      allowMissingText,
      fuzzy
    )
    for (const result of filtered.results) {
      const excluded =
        filtered.excludedEntries.get(result.id) ?? new Set<number>()
      const previous = matches.get(result.id)
      if (previous) {
        const combined = mergeSearchMatches(previous.result, result)
        combined.searchBranches = [...previous.result.searchBranches!, branch]
        combined.branchMatches = {
          ...previous.result.branchMatches,
          [branch]: result
        }
        matches.set(result.id, {
          result: combined,
          excluded: new Set(
            [...previous.excluded].filter((entry) => excluded.has(entry))
          )
        })
      } else
        matches.set(result.id, {
          result: {
            ...result,
            searchBranches: [branch],
            branchMatches: { [branch]: result }
          },
          excluded
        })
    }
  }
  let template: HTMLTemplateElement | undefined
  return results.flatMap((original) => {
    const found = matches.get(original.id)
    if (!found) return []
    if (found.result.searchBranches!.length > 1) {
      const html = original.text || lookupExcerpt(original.id)?.html
      if (html) {
        // Restore source order and retain entries allowed by any qualifying branch.
        if (found.excluded.size) {
          template ??= document.createElement('template')
          template.innerHTML = html
          template.content
            .querySelectorAll(SEARCH_ENTRY_SELECTOR)
            .forEach((entry, index) => {
              if (found.excluded.has(index)) entry.remove()
            })
          found.result.text = template.innerHTML
        } else found.result.text = html
      }
    }
    return [found.result]
  })
}

function filterQueryResults(
  results: LocalSearchResult[],
  parsed: ReturnType<typeof parseSearchQuery>,
  allowMissingText: boolean,
  fuzzy: boolean
) {
  const { text: query, isPhrase, excludedTerms, excludedSites } = parsed
  const excludedEntries = new Map<string, Set<number>>()
  const urlFilters = normalizeUrlFilters(parsed.urls)
  if (!urlFilters) return { results: [], excludedEntries }
  const hasExclusions = excludedTerms.length > 0 || excludedSites.length > 0
  if (hasExclusions) {
    const patterns = excludedTerms.map((term) =>
      createPhraseRegex(normalizeExcerptText(term))
    )
    const hosts = excludedSites
      .map(createSiteMatcher)
      .filter((matcher) => matcher !== null)
    const template = document.createElement('template')
    results = results.flatMap((result) => {
      const html = result.text || lookupExcerpt(result.id)?.html
      if (!html) return []
      template.innerHTML = html
      const entries = [
        ...template.content.querySelectorAll(SEARCH_ENTRY_SELECTOR)
      ]
      const removedTerms = new Set<string>()
      for (const entry of entries) {
        if (!template.content.contains(entry)) continue
        const own = entry.cloneNode(true) as Element
        own.querySelectorAll('ul, ol').forEach((list) => list.remove())
        const text = normalizeExcerptText(
          [own.textContent ?? '', collectIconLabels(own)].join(' ')
        )
        const excluded =
          patterns.some((pattern) => pattern.test(text)) ||
          [...own.querySelectorAll('a[href]')].some((link) => {
            try {
              const url = new URL(
                link.getAttribute('href')!,
                'https://fmhy.net'
              )
              return hosts.some((matchesHost) => matchesHost(url.hostname))
            } catch {
              return false
            }
          })
        if (excluded) {
          for (const term of tokenizeIndexLike(
            [entry.textContent ?? '', collectIconLabels(entry)].join(' '),
            true
          ))
            removedTerms.add(term)
          entry.remove()
        }
      }
      const blocks = collectSearchBlocks(template.content)
      if (!blocks.length) return []
      excludedEntries.set(
        result.id,
        new Set(
          entries.flatMap((entry, index) =>
            template.content.contains(entry) ? [] : [index]
          )
        )
      )
      const remainingTerms = new Set(
        tokenizeIndexLike(
          [blocks.join(' '), collectIconLabels(template.content)].join(' '),
          true
        )
      )
      const lostTerms = new Set(
        [...removedTerms].filter((term) => !remainingTerms.has(term))
      )
      const links = [...template.content.querySelectorAll('a[href]')].flatMap(
        (link) => {
          try {
            return [new URL(link.getAttribute('href')!, 'https://fmhy.net')]
          } catch {
            return []
          }
        }
      )
      const urlQuery = buildUrlQuery(query)
      const urlMatched =
        !!result.urlMatched &&
        !!urlQuery &&
        links.some((link) =>
          urlMatchesNormalizedUrl(normalizeUrlSearchValue(link.href), urlQuery)
        )
      if (
        !urlMatched &&
        fuzzy &&
        !isPhrase &&
        query &&
        !result.matchesWithoutTerms?.(lostTerms)
      )
        return []
      return [{ ...result, urlMatched, text: template.innerHTML }]
    })
  }
  const hasEntryFilters = parsed.sites.length > 0 || urlFilters.length > 0
  const phrasePatterns = parsed.phrases.map((phrase) =>
    createPhraseRegex(normalizeExcerptText(phrase))
  )
  const linksOf = (entry: Element | DocumentFragment) =>
    [...entry.querySelectorAll('a[href]')].flatMap((link) => {
      try {
        return [new URL(link.getAttribute('href')!, 'https://fmhy.net')]
      } catch {
        return []
      }
    })
  const matchesLinkFilters = (links: URL[]) =>
    parsed.sites.every((site) => {
      const matchesHost = createSiteMatcher(site)
      return matchesHost && links.some((link) => matchesHost(link.hostname))
    }) &&
    urlFilters.every((filter) =>
      links.some((link) =>
        normalizeSearchUrl(normalizeUrlSearchValue(link.href)).includes(filter)
      )
    )

  if (results.some((result) => result.entryMatch)) {
    const template = document.createElement('template')
    results = results.flatMap((result) => {
      if (!result.entryMatch) return [result]
      const html = result.text || lookupExcerpt(result.id)?.html
      if (!html) {
        if (!allowMissingText) return []
        if (
          !result.entryMatch.groups.length &&
          !result.entryMatch.withHeadingContext
        )
          return [result]
      }
      template.innerHTML = html ?? ''
      const elements = [
        ...template.content.querySelectorAll(SEARCH_ENTRY_SELECTOR)
      ]
      const entries: SearchEntryMatch[] = []
      const auxiliary = new Set(result.entryMatch.auxiliary)
      const urlQuery = result.urlMatched ? buildUrlQuery(query) : null
      for (const element of elements.length
        ? elements
        : [...template.content.children]) {
        const own = element.cloneNode(true) as Element
        own.querySelectorAll('ul, ol').forEach((list) => list.remove())
        const block = collectSearchBlocks(own).find(
          (block) =>
            (result.entryMatch!.groups.length > 0 ||
              result.entryMatch!.withHeadingContext) &&
            phrasePatterns.every((pattern) => pattern.test(block)) &&
            result.entryMatch!.groups.every((forms) =>
              forms.some((form) => block.includes(normalizeExcerptText(form)))
            )
        )
        const links = linksOf(own)
        const urlMatched =
          !!urlQuery &&
          links.some((link) =>
            urlMatchesNormalizedUrl(
              normalizeUrlSearchValue(link.href),
              urlQuery
            )
          )
        if ((!block && !urlMatched) || !matchesLinkFilters(links)) continue
        const context = own.textContent?.trim() ?? ''
        const indexedText = [context, collectIconLabels(own)].join(' ')
        const present = new Set(tokenizeIndexLike(indexedText, true))
        const ownTerms = new Set(present)
        if (result.entryMatch.withHeadingContext)
          for (const heading of result.entryMatch.headings ?? [result.title])
            for (const term of tokenizeIndexLike(heading, true))
              present.add(term)
        if (
          !urlMatched &&
          ((result.entryMatch.withHeadingContext &&
            !hasEntryFilters &&
            !result.entryMatch.resourceContext &&
            !result.terms.some((term) => ownTerms.has(term))) ||
            !result.matchesWithoutTerms?.(
              new Set(result.terms.filter((term) => !present.has(term))),
              false
            ))
        )
          continue
        const phrases = [
          ...new Set(
            result.entryMatch.withHeadingContext
              ? result.terms.filter((term) => ownTerms.has(term))
              : result.entryMatch.groups.flatMap((forms) =>
                  forms.filter((form) =>
                    block?.includes(normalizeExcerptText(form))
                  )
                )
          )
        ]
        const matchesPhrase = (text: string) =>
          phrases.some((phrase) =>
            normalizeExcerptText(text).includes(normalizeExcerptText(phrase))
          )
        const matchingLinks = [...own.querySelectorAll('a')].filter(
          (link) =>
            matchesPhrase(link.textContent ?? '') ||
            (!!urlQuery &&
              urlMatchesNormalizedUrl(
                normalizeUrlSearchValue(link.getAttribute('href') ?? ''),
                urlQuery
              ))
        )
        const primary = matchingLinks.some(
          (link) => !auxiliary.has(normalizeExcerptText(link.textContent ?? ''))
        )
        const description = own.cloneNode(true) as Element
        description.querySelectorAll('a').forEach((link) => link.remove())
        const descriptive = matchesPhrase(description.textContent ?? '')
        const starred =
          element.classList.contains('starred') ||
          element.closest('li')?.classList.contains('starred') ||
          !!own.querySelector('.starred')
        // Auxiliary link matches do not inherit the resource's star.
        const headingSupported =
          result.entryMatch.resourceContext && !phrases.length
        const rank =
          primary || descriptive || headingSupported ? (starred ? 2 : 1) : 0
        if (
          !entries.some(
            (entry) =>
              normalizeExcerptText(entry.context) ===
              normalizeExcerptText(context)
          )
        )
          entries.push({ context, phrases, rank })
      }
      if (!entries.length && !hasEntryFilters) {
        const headings = result.entryMatch.headings ?? [result.title]
        for (const heading of result.entryMatch.withHeadingContext
          ? [headings.join(' > ')]
          : headings) {
          const text = normalizeExcerptText(heading.replace(/<[^>]*>/g, ' '))
          if (
            !phrasePatterns.every((pattern) => pattern.test(text)) ||
            !result.entryMatch.groups.every((forms) =>
              forms.some((form) => text.includes(normalizeExcerptText(form)))
            )
          )
            continue
          const present = new Set(tokenizeIndexLike(text))
          if (
            !result.matchesWithoutTerms?.(
              new Set(result.terms.filter((term) => !present.has(term))),
              false
            )
          )
            continue
          entries.push({
            heading: true,
            context: heading,
            phrases: [
              ...new Set(
                result.entryMatch.withHeadingContext
                  ? result.terms.filter((term) => present.has(term))
                  : result.entryMatch.groups.flatMap((forms) =>
                      forms.filter((form) =>
                        text.includes(normalizeExcerptText(form))
                      )
                    )
              )
            ],
            rank: 1
          })
          break
        }
      }
      if (!entries.length) return []
      entries.sort((a, b) => b.rank - a.rank)
      return [{ ...result, entryMatch: { ...result.entryMatch, entries } }]
    })
    if (
      results.every(
        (result) => result.entryMatch && !result.entryMatch.withHeadingContext
      )
    )
      results.sort(
        (a, b) =>
          (b.entryMatch?.entries?.[0]?.rank ?? 0) -
          (a.entryMatch?.entries?.[0]?.rank ?? 0)
      )
  }
  if (!query && !hasEntryFilters)
    return { results: isPhrase ? [] : results, excludedEntries }
  if (fuzzy && !parsed.phrases.length && !hasEntryFilters)
    return { results, excludedEntries }

  const template = document.createElement('template')
  const matchesText = (
    text: string,
    result: LocalSearchResult,
    indexedText = text
  ) => {
    text = normalizeExcerptText(text)
    if (!phrasePatterns.every((pattern) => pattern.test(text))) return false
    if (!query || isPhrase) return true
    if (fuzzy) {
      if (!hasEntryFilters) return true
      if (
        result.entryMatch?.withHeadingContext &&
        result.entryMatch.entries?.some(
          (entry) =>
            !entry.heading && normalizeExcerptText(entry.context) === text
        )
      )
        return true
      const present = new Set(tokenizeIndexLike(indexedText, true))
      return !!result.matchesWithoutTerms?.(
        new Set(result.terms.filter((term) => !present.has(term))),
        false
      )
    }
    return parsed.phrases.length
      ? parsed.unquotedText
          .split(/\s+/)
          .every((word) => text.includes(normalizeExcerptText(word)))
      : text.includes(normalizeExcerptText(query))
  }
  const clean = (html: string) => {
    template.innerHTML = html
    return template.content.textContent ?? ''
  }

  return {
    results: results.filter((result) => {
      const cached = lookupExcerpt(result.id)
      const html = result.text || cached?.html
      if (hasEntryFilters) {
        if (!html) return false
        template.innerHTML = html
        const entries = [
          ...template.content.querySelectorAll(SEARCH_ENTRY_SELECTOR)
        ]
        const urlQuery =
          result.urlMatched && query ? buildUrlQuery(query) : null
        return (entries.length ? entries : [template.content]).some((entry) => {
          const own = entry.cloneNode(true) as Element | DocumentFragment
          own.querySelectorAll('ul, ol').forEach((list) => list.remove())
          const links = linksOf(own)
          if (!matchesLinkFilters(links)) return false
          const text = own.textContent ?? ''
          // Platform names may be rendered as icons rather than visible text.
          const indexedText = fuzzy
            ? [text, collectIconLabels(own)].join(' ')
            : text
          return (
            matchesText(text, result, indexedText) ||
            (!!urlQuery &&
              links.some((link) =>
                urlMatchesNormalizedUrl(
                  normalizeUrlSearchValue(link.href),
                  urlQuery
                )
              ))
          )
        })
      }
      if (
        !isPhrase &&
        !/\s/.test(query) &&
        (result.urlMatched || (!hasExclusions && result.substringMatched))
      )
        return true
      const headings = [result.title, ...result.titles].map(clean)
      if (headings.some((heading) => matchesText(heading, result))) return true
      if (!html) return allowMissingText

      let blocks = cached?.html === html ? cached.blocks : undefined
      if (!blocks) {
        template.innerHTML = html
        blocks = collectSearchBlocks(template.content)
        if (cached?.html === html) cached.blocks = blocks
      }
      return blocks.some((block) => matchesText(block, result))
    }),
    excludedEntries
  }
}

// Project qualified matches onto rendered page blocks without changing section eligibility.
export function prepareSearchPreviews(
  results: LocalSearchResult[],
  query: string,
  fuzzy: boolean
): LocalSearchResult[] {
  const template = document.createElement('template')
  return results.map((result) => {
    template.innerHTML = result.text ?? ''
    const elements = [
      ...template.content.querySelectorAll(SEARCH_ENTRY_SELECTOR)
    ].filter(
      (element) =>
        !element.closest('.critical-badge-hidden-body, .tooltip-body') &&
        (element.tagName === 'LI' ||
          !element.parentElement?.closest(SEARCH_ENTRY_SELECTOR))
    )
    const branches = result.searchBranches ?? [query]
    const selected: {
      original: Element
      element: Element
      match: SearchEntryMatch
      order: number
    }[] = []
    const seen = new Set<string>()
    const usedIds = new Set<string>()
    for (const [ordinal, element] of elements.entries()) {
      const own = element.cloneNode(true) as Element
      own.querySelectorAll('ul,ol').forEach((list) => list.remove())
      stripSearchNoteLinks(own)
      const context = getSearchEntryText(own)
      const visible = own.cloneNode(true) as Element
      visible
        .querySelectorAll(
          '.critical-badge-hidden-body, .tooltip-body, criticalbadge, tooltip'
        )
        .forEach((note) => note.remove())
      const normalized = normalizeExcerptText(getSearchEntryText(visible))
      let matched: SearchEntryMatch | undefined
      let matchOrder = Number.MAX_SAFE_INTEGER
      for (const [branchOrdinal, branch] of branches.entries()) {
        const branchResult = result.branchMatches?.[branch] ?? result
        const parsed = parseSearchQuery(branch)
        const known = branchResult.entryMatch?.entries?.find(
          (entry) =>
            !entry.heading &&
            (!entry.id || !usedIds.has(entry.id)) &&
            normalizeExcerptText(entry.context) === normalized
        )
        const urlQuery =
          branchResult.urlMatched && !parsed.phrases.length
            ? buildUrlQuery(parsed.text)
            : null
        const urlMatched =
          !!urlQuery &&
          [...own.querySelectorAll('a[href]')].some((link) =>
            urlMatchesNormalizedUrl(
              normalizeUrlSearchValue(link.getAttribute('href') ?? ''),
              urlQuery
            )
          )
        const literal =
          !!parsed.text &&
          normalized.includes(normalizeExcerptText(parsed.text))
        const hasFilters =
          parsed.sites.length ||
          parsed.titles.length ||
          parsed.urls.length ||
          parsed.excludedTerms.length ||
          parsed.excludedSites.length
        let verified: LocalSearchResult | undefined
        if (!known || hasFilters) {
          verified = filterResults(
            [
              {
                ...branchResult,
                id: result.id,
                text: visible.outerHTML,
                title: '',
                titles: [],
                searchBranches: undefined,
                branchMatches: undefined,
                urlMatched,
                substringMatched: !!branchResult.substringMatched && literal,
                entryMatch: branchResult.entryMatch
                  ? {
                      ...branchResult.entryMatch,
                      entries: undefined,
                      headings:
                        fuzzy && !parsed.phrases.length
                          ? branchResult.entryMatch.headings
                          : []
                    }
                  : undefined
              }
            ],
            branch,
            false,
            fuzzy
          )[0]
          if (!verified) continue
        }
        const ownEvidence = verified?.entryMatch?.entries?.find(
          (entry) =>
            !entry.heading && normalizeExcerptText(entry.context) === normalized
        )
        const filtersOnly = !parsed.text && !parsed.phrases.length && hasFilters
        const present = new Set(
          tokenizeIndexLike(
            [getSearchEntryText(visible), collectIconLabels(visible)].join(' '),
            true
          )
        )
        const ownTerms =
          fuzzy &&
          !parsed.phrases.length &&
          (branchResult.matchesWithoutTerms
            ? branchResult.matchesWithoutTerms(
                new Set(
                  branchResult.terms.filter((term) => !present.has(term))
                ),
                false
              )
            : tokenizeIndexLike(parsed.text).every((word) => {
                const alternatives =
                  branchResult.termMatches?.filter(
                    (match) => match.query === word
                  ) ?? []
                return (
                  alternatives.some(
                    (match) =>
                      match.recovery !== 'compound' && present.has(match.term)
                  ) ||
                  (alternatives.some(
                    (match) => match.recovery === 'compound'
                  ) &&
                    alternatives
                      .filter((match) => match.recovery === 'compound')
                      .every((match) => present.has(match.term)))
                )
              }))
        if (
          !known &&
          !ownEvidence &&
          !literal &&
          !(parsed.phrases.length && verified) &&
          !urlMatched &&
          !filtersOnly &&
          !ownTerms
        )
          continue
        const phrases =
          ownEvidence?.phrases ??
          known?.phrases ??
          (fuzzy && !parsed.phrases.length
            ? branchResult.terms.filter((term) => present.has(term))
            : [
                ...parsed.phrases,
                parsed.phrases.length ? parsed.unquotedText : parsed.text
              ].filter(Boolean))
        const rank =
          ownEvidence?.rank ??
          known?.rank ??
          (own.classList.contains('starred') ? 2 : 1)
        const record: SearchEntryMatch = {
          ...known,
          ...ownEvidence,
          context,
          phrases,
          rank,
          heading: false,
          id: known?.id ?? `${result.id}~preview-${ordinal}`
        }
        if (!matched) matched = record
        else
          matched = {
            ...matched,
            phrases: [...new Set([...matched.phrases, ...phrases])],
            rank: Math.max(matched.rank, rank)
          }
        const knownOrder =
          branchResult.entryMatch?.entries?.indexOf(known!) ?? -1
        matchOrder = Math.min(
          matchOrder,
          branchOrdinal * 100000 + (knownOrder >= 0 ? knownOrder : ordinal)
        )
      }
      if (!matched) continue
      const key = normalized + '\0' + own.outerHTML
      if (seen.has(key)) continue
      seen.add(key)
      usedIds.add(matched.id!)
      own.setAttribute('data-search-entry', matched.id!)
      selected.push({
        original: element,
        element: own,
        match: matched,
        order: matchOrder
      })
    }
    // Retrieval already orders matching entries, including the broad-topic policy.
    selected.sort((a, b) => a.order - b.order || b.match.rank - a.match.rank)
    const output = document.createElement('div')
    let sourceParent: Element | null = null
    let wrapper: Element | undefined
    for (const { original, element } of selected) {
      const parent = original.parentElement
      if (element.tagName === 'LI' || element.tagName === 'TR') {
        if (parent !== sourceParent || !wrapper) {
          sourceParent = parent
          wrapper = parent?.cloneNode(false) as Element | undefined
          wrapper ??= document.createElement(
            element.tagName === 'LI' ? 'ul' : 'tbody'
          )
          wrapper.removeAttribute('id')
          if (element.tagName === 'TR') {
            const table = original.closest('table')?.cloneNode(false) as
              Element | undefined
            const container = table ?? document.createElement('table')
            container.removeAttribute('id')
            container.append(wrapper)
            output.append(container)
          } else output.append(wrapper)
        }
        if (element.tagName === 'LI' && parent?.tagName === 'OL') {
          const list = parent as HTMLOListElement
          let value = list.hasAttribute('start')
            ? list.start
            : list.reversed
              ? list.children.length
              : 1
          for (const sibling of list.children) {
            if (sibling.hasAttribute('value'))
              value = (sibling as HTMLLIElement).value
            if (sibling === original) break
            value += list.reversed ? -1 : 1
          }
          ;(element as HTMLLIElement).value = value
        }
        wrapper.append(element)
      } else {
        sourceParent = null
        wrapper = undefined
        output.append(element)
      }
    }
    const first = selected[0]?.match
    return {
      ...result,
      text: output.innerHTML,
      headingSupported: first
        ? first.evidence?.kind === 'heading' ||
          first.evidence?.kind === 'ancestor'
        : !!result.entryMatch?.entries?.some((entry) => entry.heading) ||
          branches.some((branch) => {
            const text = normalizeExcerptText(parseSearchQuery(branch).text)
            return (
              !!text &&
              [result.title, ...result.titles].some((heading) =>
                createPhraseRegex(text).test(normalizeExcerptText(heading))
              )
            )
          }),
      entryMatch: {
        groups: result.entryMatch?.groups ?? [],
        auxiliary: result.entryMatch?.auxiliary ?? [],
        ...result.entryMatch,
        entries: selected.length
          ? selected.map((row) => row.match)
          : (result.entryMatch?.entries?.filter((entry) => entry.heading) ?? [])
      }
    }
  })
}

interface ResourceEntry {
  id: string
  section: LocalSearchResult
  html: string
  body: string
  description: string
  indexText: string
  order: number
  names: string[]
  starred: boolean
  reference: boolean
  aliases: string[]
}

export function usesEntrySearch(query: string, fuzzy: boolean) {
  const parsed = parseSearchQuery(query)
  return (
    fuzzy &&
    !parsed.phrases.length &&
    !parsed.branches.length &&
    !!parsed.text &&
    !looksLikeUrlQuery(parsed.text)
  )
}

export function filterSearchExclusions(
  results: LocalSearchResult[],
  query: string
) {
  const parsed = parseSearchQuery(query)
  if (!parsed.excludedTerms.length && !parsed.excludedSites.length)
    return results
  const matches = new Map(
    results.map((result) => [result.id, result.entryMatch])
  )
  const template = document.createElement('template')
  return filterQueryResults(
    results.map((result) => {
      template.innerHTML = result.text ?? ''
      stripSearchNoteLinks(template.content)
      return { ...result, text: template.innerHTML, entryMatch: undefined }
    }),
    {
      ...parsed,
      text: '',
      unquotedText: '',
      phrases: [],
      sites: [],
      urls: [],
      titles: [],
      branches: [],
      isPhrase: false
    },
    true,
    true
  ).results.map((result) => ({ ...result, entryMatch: matches.get(result.id) }))
}

// Each loaded locale owns one complete entry index, independent of section candidates.
export function createEntrySearch(
  sections: LocalSearchResult[],
  metadata: SearchMetadata,
  sidebar: SidebarItem[],
  sectionEngine: ReturnType<typeof createSearchEngine>
) {
  const wordForms = sectionEngine.headingForms
  const normalize = (text: string) =>
    normalizeFuzzyTerm(normalizeExcerptText(text))
  const pageAlias = (section: LocalSearchResult) => {
    const page = section.id.split('#')[0]
    const words = tokenizeIndexLike(
      (section.pageTitle ?? '').replace(/<[^>]*>/g, ' ')
    )
    const initials = words.map((word) => word[0]).join('')
    return words.length > 1 && page.split('/').at(-1) === initials
      ? initials
      : ''
  }
  const entries: ResourceEntry[] = []
  const entryMetadata: SearchMetadata = {}
  const template = document.createElement('template')
  for (const section of sections) {
    const firstEntry = entries.length
    const aliases = [
      ...new Set(
        [section.title, ...(section.indexedTitles ?? [])]
          .flatMap((title) => tokenizeIndexLike(title).flatMap(wordForms))
          .concat(pageAlias(section))
          .filter(Boolean)
      )
    ]
    template.innerHTML = section.text ?? ''
    const elements = [
      ...template.content.querySelectorAll(SEARCH_ENTRY_SELECTOR)
    ].filter(
      (element) =>
        element.tagName === 'LI' ||
        !element.parentElement?.closest(SEARCH_ENTRY_SELECTOR)
    )
    if (!elements.length) elements.push(...template.content.children)
    for (const [ordinal, element] of elements.entries()) {
      const own = element.cloneNode(true) as Element
      own.querySelectorAll('ul, ol').forEach((list) => list.remove())
      // Warning prose is searchable; hidden source citations are not resource links.
      stripSearchNoteLinks(own)
      const body = own.textContent ?? ''
      if (!normalizeExcerptText(body)) continue
      let descriptionStart = body.length
      const walker = document.createTreeWalker(own, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('a,code,pre')) continue
        const separator = node.textContent?.match(/\s[-–—]\s/)
        if (!separator) continue
        const range = document.createRange()
        range.selectNodeContents(own)
        range.setEnd(node, separator.index!)
        descriptionStart = range.toString().length
        break
      }
      let primarySeen = false
      let previousEnd = 0
      const links = [...own.querySelectorAll('a[href]')].map((link) => {
        const range = document.createRange()
        range.selectNodeContents(own)
        range.setEndBefore(link)
        const start = range.toString().length
        const label = link.textContent ?? ''
        const bold = !!(
          link.closest('strong,b') || link.querySelector('strong,b')
        )
        const primary =
          !!normalizeExcerptText(label) &&
          start < descriptionStart &&
          (bold ||
            !primarySeen ||
            /\bor\b|,\s*$/i.test(body.slice(previousEnd, start))) &&
          (!primarySeen || !/^\d+$/.test(label.trim()))
        if (primary) primarySeen = true
        previousEnd = start + label.length
        return {
          label,
          primary,
          bold,
          start,
          end: previousEnd,
          href: link.getAttribute('href') ?? ''
        }
      })
      const starred =
        own.classList.contains('starred') ||
        !!own.querySelector('.i-twemoji-star.starred')
      const names = links
        .filter((link) => link.primary)
        .map((link) => normalizeExcerptText(link.label))
      const urls = links.flatMap((link) => {
        if (!/^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(link.href)) return []
        const url = normalizeSearchUrl(
          normalizeUrlSearchValue(link.href)
        ).slice(0, 80)
        return metadata[section.id]?.u?.includes(url)
          ? [{ url, primary: link.primary }]
          : []
      })
      const id = section.id + '~entry-' + ordinal
      entryMetadata[id] = {
        l: links
          .map((link) => normalizeExcerptText(link.label))
          .filter(Boolean),
        s: starred
          ? links
              .filter((link) => link.primary && link.bold)
              .map((link) => normalizeExcerptText(link.label))
          : [],
        a: links
          .filter((link) => !link.primary)
          .map((link) => normalizeExcerptText(link.label))
          .filter((label) => !names.includes(label)),
        u: urls.map((link) => link.url),
        su: starred
          ? urls.filter((link) => link.primary).map((link) => link.url)
          : []
      }
      const descriptive = body.split('')
      for (const link of links)
        if (!link.primary) descriptive.fill(' ', link.start, link.end)
      for (const note of own.querySelectorAll(
        'criticalbadge, .critical-badge-hidden-body, .tooltip-source-link'
      )) {
        const range = document.createRange()
        range.selectNodeContents(own)
        range.setEndBefore(note)
        const start = range.toString().length
        range.setEndAfter(note)
        descriptive.fill(' ', start, range.toString().length)
      }
      const description = descriptive.join('').slice(descriptionStart)
      entries.push({
        id,
        section,
        html: own.outerHTML,
        body,
        description,
        indexText: body + ' ' + collectIconLabels(own),
        order: entries.length,
        names,
        starred,
        reference: !!own.querySelector('.i-twemoji-repeat-button'),
        aliases
      })
    }
    if (entries.length === firstEntry) {
      const id = section.id + '~heading'
      entryMetadata[id] = {}
      entries.push({
        id,
        section,
        html: '',
        body: '',
        description: '',
        indexText: '',
        order: entries.length,
        names: [],
        starred: false,
        reference: true,
        aliases
      })
    }
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const index = new MiniSearch<Result>({
    fields: ['title', 'titles', 'text'],
    storeFields: ['title', 'titles'],
    tokenize: tokenizeSearchText,
    processTerm: processSearchTerm,
    searchOptions: {
      prefix: true,
      combineWith: 'AND',
      boostDocument: (id, term, fields) => {
        const titles = (fields?.titles ?? []) as string[]
        const level = titles.findIndex((title) =>
          title.toLowerCase().includes(term)
        )
        return (
          (level >= 0 ? 10000 - level : 1) *
          (/\/(posts|other)/.test(String(id)) ? 0.1 : 1)
        )
      }
    }
  })
  index.addAll(
    entries.map((entry) => ({
      id: entry.id,
      title: entry.section.title,
      titles: [...(entry.section.indexedTitles ?? []), ...entry.aliases],
      text: entry.indexText
    }))
  )
  const engine = createSearchEngine(index, entryMetadata, sidebar, true)
  const topicForms = (word: string) => {
    const forms = [normalize(word)]
    if (word.endsWith('s') && !word.endsWith('ss'))
      forms.push(normalize(word.slice(0, -1)))
    if (word.endsWith('ing') && word.length > 5)
      forms.push(
        normalize(word.slice(0, -3)),
        normalize(word.slice(0, -3) + 'e')
      )
    return forms
  }
  const headingTopics = new Map<string, Map<string, Set<string>>>()
  for (const section of sections) {
    if (/^\/(?:recently-removed|unsafe)(?:#|$)/.test(section.id)) continue
    const page = section.id.split('#')[0]
    for (const word of tokenizeIndexLike(section.title))
      for (const form of topicForms(word)) {
        const pages = headingTopics.get(form) ?? new Map<string, Set<string>>()
        const ids = pages.get(page) ?? new Set<string>()
        ids.add(section.id)
        pages.set(page, ids)
        headingTopics.set(form, pages)
      }
  }
  const search = (
    query: string,
    options: { fuzzy: boolean; urls: boolean }
  ) => {
    const parsed = parseSearchQuery(query)
    const words = tokenizeIndexLike(parsed.text)
    const candidates = engine.search(query, options).results.map((result) => {
      const entry = byId.get(result.id)!
      return {
        ...result,
        text: entry.html,
        entryMatch: result.entryMatch
          ? {
              ...result.entryMatch,
              // A broad ancestor's word forms alone must not classify every descendant.
              headings:
                words.length === 1
                  ? [
                      entry.section.title,
                      ...(entry.section.indexedTitles ?? []),
                      ...tokenizeIndexLike(entry.section.title).flatMap(
                        wordForms
                      ),
                      pageAlias(entry.section)
                    ]
                  : [...(result.entryMatch.headings ?? []), ...entry.aliases]
            }
          : undefined
      }
    })
    let matches = filterResults(candidates, query, true, true)
    const normalizedQuery = normalize(parsed.text)
    const single = words.length === 1
    const wholeName = matches.some((result) =>
      entryMetadata[result.id].s?.some(
        (name) => normalize(name) === normalizedQuery
      )
    )
    const canonicalForms =
      single && /^[a-z]{2,4}$/i.test(words[0]) && !wholeName
        ? [
            ...new Set(
              matches.flatMap((result) =>
                (entryMetadata[result.id].s ?? [])
                  .flatMap((name) => tokenizeIndexLike(name, true))
                  .filter((word) => normalize(word) === normalizedQuery)
              )
            )
          ]
        : []
    if (canonicalForms.length)
      matches = matches.filter((result) => {
        const entry = byId.get(result.id)!
        return (
          result.urlMatchRank === 3 ||
          pageAlias(entry.section) === normalizedQuery ||
          canonicalForms.some((form) =>
            [
              entry.body,
              entry.section.title,
              ...(entry.section.indexedTitles ?? [])
            ].some((text) => createPhraseRegex(form).test(text))
          )
        )
      })
    const canonicalWord =
      tokenizeIndexLike(
        matches.find((result) => result.rankingText)?.rankingText ?? parsed.text
      )[0] ?? ''
    const topicStrength = (section: LocalSearchResult) => {
      if (!single) return 0
      const page = section.id.split('#')[0]
      const slug = page.split('/').at(-1)!
      const queryForms = topicForms(canonicalWord)
      if (
        pageAlias(section) === canonicalWord ||
        (!slug.includes('-') &&
          topicForms(slug).some((form) => queryForms.includes(form)))
      )
        return 1002
      const facets = (section.pageTitle ?? '')
        .replace(/<[^>]*>/g, ' ')
        .split('/')
      const matchesFacet = (facet: string) =>
        tokenizeIndexLike(facet).some((word) =>
          [...topicForms(word), ...wordForms(word).map(normalize)].some(
            (form) => queryForms.includes(form)
          )
        )
      if (matchesFacet(facets[0])) return 1001
      const headings = Math.max(
        0,
        ...queryForms.map(
          (form) => headingTopics.get(form)?.get(page)?.size ?? 0
        )
      )
      return (facets.slice(1).some(matchesFacet) ? 100 : 0) + headings
    }
    const topic =
      single &&
      (matches.some(
        (result) => topicStrength(byId.get(result.id)!.section) >= 1000
      ) ||
        [...headingTopics].some(
          ([form, pages]) =>
            topicForms(canonicalWord).includes(form) &&
            [...pages.values()].reduce((sum, ids) => sum + ids.size, 0) >= 2
        ))
    const quality = new Map<string, SearchMatchEvidence>()
    for (const result of matches) {
      const entry = byId.get(result.id)!
      const page = entry.section.id
        .split('#')[0]
        .replace(/\.html$/, '')
        .split('/')
        .at(-1)
      const specialized =
        page === 'mobile' || page === 'linux-macos' || page === 'non-english'
      const scope =
        page === 'non-english'
          ? (entry.section.indexedTitles?.[0] ?? entry.section.title)
          : (entry.section.pageTitle ?? entry.section.indexedTitles?.[0] ?? '')
      const evidence = describeEntryMatch(
        {
          id: entry.id,
          sectionId: entry.section.id,
          names: entry.names,
          body: entry.body,
          description: entry.description,
          heading: entry.section.title,
          pageAlias: pageAlias(entry.section),
          parents: entry.section.indexedTitles ?? [],
          specialized,
          scope,
          starred: entry.starred,
          reference: entry.reference,
          order: entry.order
        },
        result,
        query,
        wordForms,
        topic
      )
      quality.set(result.id, evidence)
      if (result.entryMatch)
        result.entryMatch = {
          ...result.entryMatch,
          entries: result.entryMatch.entries?.map((match) => ({
            ...match,
            id: entry.id,
            evidence
          }))
        }
    }
    const namedLookup =
      single &&
      /^[a-z]{5,}$/i.test(words[0]) &&
      matches.some((result) => quality.get(result.id)!.strength === 7)
    if (namedLookup)
      matches = matches.filter((result) => {
        const evidence = quality.get(result.id)!
        return (
          evidence.kind !== 'substring' ||
          evidence.partial < 2 ||
          evidence.completeWords > 0 ||
          result.urlMatchRank === 3
        )
      })
    matches.sort((a, b) =>
      compareEntryMatches(quality.get(a.id)!, quality.get(b.id)!)
    )
    const grouped = new Map<string, LocalSearchResult>()
    for (const match of matches) {
      const entry = byId.get(match.id)!
      const previous = grouped.get(entry.section.id)
      if (previous) {
        const merged = mergeSearchMatches(previous, match)
        grouped.set(entry.section.id, {
          ...merged,
          id: entry.section.id,
          entryMatch: previous.entryMatch
            ? {
                ...previous.entryMatch,
                entries: [
                  ...(previous.entryMatch.entries ?? []),
                  ...(match.entryMatch?.entries ?? [])
                ]
              }
            : match.entryMatch
        })
      } else
        grouped.set(entry.section.id, {
          ...entry.section,
          ...match,
          id: entry.section.id,
          title: entry.section.title,
          titles: entry.section.titles,
          indexedTitles: entry.section.indexedTitles,
          pageTitle: entry.section.pageTitle,
          sectionOrder: entry.section.sectionOrder,
          text: entry.section.text
        })
    }
    const results = [...grouped.values()]
    if (topic) {
      for (const result of results)
        result.entryMatch?.entries?.sort((a, b) => {
          const x = a.evidence!,
            y = b.evidence!
          return (
            Number(y.warning) - Number(x.warning) ||
            Number(y.strength === 7 && y.curated) -
              Number(x.strength === 7 && x.curated) ||
            Number(x.removed) - Number(y.removed) ||
            Number(x.reference) - Number(y.reference) ||
            Number(y.curated) - Number(x.curated) ||
            x.order - y.order
          )
        })
      const pageOrder = new Map<string, number>()
      for (const section of sections) {
        const page = section.id.split('#')[0]
        pageOrder.set(
          page,
          Math.min(pageOrder.get(page) ?? Infinity, section.sectionOrder ?? 0)
        )
      }
      results.sort((a, b) => {
        const x = a.entryMatch?.entries?.[0]?.evidence,
          y = b.entryMatch?.entries?.[0]?.evidence
        const strengthA = topicStrength(a),
          strengthB = topicStrength(b)
        return (
          Number(!!y && (y.warning || (y.strength === 7 && y.curated))) -
            Number(!!x && (x.warning || (x.strength === 7 && x.curated))) ||
          (y?.scopeFit ?? 0) - (x?.scopeFit ?? 0) ||
          strengthB - strengthA ||
          Number(strengthB < 1000 && y?.heading === 'own') -
            Number(strengthA < 1000 && x?.heading === 'own') ||
          Number(!a.entryMatch?.entries?.some((entry) => !entry.heading)) -
            Number(!b.entryMatch?.entries?.some((entry) => !entry.heading)) ||
          (pageOrder.get(a.id.split('#')[0]) ?? 0) -
            (pageOrder.get(b.id.split('#')[0]) ?? 0) ||
          (a.sectionOrder ?? 0) - (b.sectionOrder ?? 0) ||
          (x && y ? compareEntryMatches(x, y) : a.id.localeCompare(b.id))
        )
      })
    }
    for (const result of results) {
      const first = result.entryMatch?.entries?.[0]?.evidence
      result.headingSupported =
        first?.kind === 'heading' || first?.kind === 'ancestor'
    }
    return { results: results.slice(0, MAX_RESULTS_IN_MEMORY) }
  }
  return {
    search,
    suggest(query: string) {
      return engine
        .suggest(query)
        .filter(
          (suggestion) =>
            search(suggestion, { fuzzy: true, urls: false }).results.length > 0
        )
    }
  }
}
