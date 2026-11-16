import type { useData } from 'vitepress/dist/client/theme-default/composables/data'
import type { Component, Slots } from 'vue'
import type {
  LocalSearchResult,
  Result,
  SearchEntryMatch,
  SearchMetadata,
  SidebarItem
} from './types'
import MiniSearch from 'minisearch'
import { dataSymbol } from 'vitepress'
import { pathToFile } from 'vitepress/dist/client/app/utils'
import { createApp, h } from 'vue'
import CriticalBadge from '../theme/components/CriticalBadge.vue'
import Tooltip from '../theme/components/Tooltip.vue'
import { SEARCH_ENTRY_SELECTOR } from './matchHighlighting'
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
import { createSearchEngine, mergeSearchMatches } from './searchEngine'
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

// Search individual authored entries, then group them back into navigable sections.
export function refineSearchEntries(
  sections: LocalSearchResult[],
  query: string,
  options: { fuzzy: boolean; urls: boolean },
  metadata: SearchMetadata,
  sidebar: SidebarItem[],
  wordForms: (word: string) => string[]
): LocalSearchResult[] {
  const parsed = parseSearchQuery(query)
  // Literal and operator branches already have their own entry qualification/order.
  if (
    !options.fuzzy ||
    parsed.phrases.length ||
    parsed.branches.length ||
    !parsed.text ||
    looksLikeUrlQuery(parsed.text)
  )
    return filterResults(sections, query, true, options.fuzzy)

  if (parsed.excludedTerms.length || parsed.excludedSites.length) {
    sections = filterQueryResults(
      sections.map((section) => ({ ...section, entryMatch: undefined })),
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
    ).results
  }

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
      own
        .querySelectorAll('.critical-badge-hidden-body a, .tooltip-source-link')
        .forEach((link) => link.replaceWith(link.textContent ?? ''))
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
      let description = body.slice(descriptionStart)
      for (const link of [...links].reverse())
        if (!link.primary && link.start >= descriptionStart)
          description =
            description.slice(0, link.start - descriptionStart) +
            ' '.repeat(link.end - link.start) +
            description.slice(link.end - descriptionStart)
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
  if (!entries.length) return []
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
  const candidates = engine.search(query, options).results.map((result) => {
    const entry = byId.get(result.id)!
    return {
      ...result,
      text: entry.html,
      entryMatch: result.entryMatch
        ? {
            ...result.entryMatch,
            headings: [...(result.entryMatch.headings ?? []), ...entry.aliases]
          }
        : undefined
    }
  })
  let matches = filterResults(candidates, query, true, true)
  const words = tokenizeIndexLike(parsed.text)
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
  const lookup =
    single &&
    matches.some(
      (result) =>
        !byId.get(result.id)!.reference &&
        entryMetadata[result.id].s?.some(
          (name) =>
            normalize(name) === normalizedQuery ||
            (words[0].length <= 4 &&
              tokenizeIndexLike(name, true).some(
                (word) => normalize(word) === normalizedQuery
              ))
        )
    )
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
  const topicStrength = (section: LocalSearchResult) => {
    if (!single) return 0
    const page = section.id.split('#')[0].split('/').at(-1)!
    const subject = tokenizeIndexLike(
      (section.pageTitle ?? '').replace(/<[^>]*>/g, '').split('/')[0]
    )[0]
    const forms = topicForms(words[0])
    if (
      pageAlias(section) === words[0] ||
      (!page.includes('-') &&
        topicForms(page).some((form) => forms.includes(form)))
    )
      return 2
    return subject && topicForms(subject).some((form) => forms.includes(form))
      ? 1
      : 0
  }
  const topic = matches.some(
    (result) => topicStrength(byId.get(result.id)!.section) > 0
  )
  const headingCoverage = (entry: ResourceEntry) => {
    const own = tokenizeIndexLike(entry.section.title)
    const context = [
      ...own,
      ...tokenizeIndexLike((entry.section.indexedTitles ?? []).join(' ')),
      ...entry.aliases
    ]
    const covered =
      words.length > 1 &&
      words.every((word) => context.some((term) => term.startsWith(word)))
    const roles = words.filter((word) => /(?:ors?|ers?)$/.test(word))
    const ownRole = roles.some((word) =>
      [...own, ...own.flatMap(wordForms)].some((term) => term.startsWith(word))
    )
    return {
      role: covered && roles.length > 0,
      rank: covered ? (ownRole ? 2 : 1) : 0
    }
  }
  const task = matches.some(
    (result) => headingCoverage(byId.get(result.id)!).role
  )
  const quality = new Map<string, number[]>()
  for (const result of matches) {
    const entry = byId.get(result.id)!
    const names = entry.names.map(normalize)
    const forms = [
      normalizedQuery,
      ...(result.entryMatch?.groups ?? []).flat().map(normalize)
    ]
    const statusName = /^\/(?:unsafe|recently-removed)#/.test(entry.section.id)
      ? normalize(entry.body.split(/\s[-–—]\s/)[0])
      : ''
    const exact =
      names.some((name) => forms.includes(name)) ||
      !!(statusName && forms.includes(statusName))
    const nameMatch = names.some((name) =>
      forms.some((form) => createPhraseRegex(form).test(name))
    )
      ? 2
      : names.some((name) => name.startsWith(normalizedQuery))
        ? 1
        : 0
    const evidence = result.entryMatch?.entries ?? []
    const auxiliary =
      evidence.length > 0 &&
      evidence.every((match) => !match.heading && match.rank === 0)
    const curated = entry.starred && !auxiliary
    const reference = entry.reference
    const active = !/^\/recently-removed(?:\.html)?#/.test(entry.section.id)
    const headingRank = headingCoverage(entry).rank
    const direct =
      result.terms.some((term) => forms.includes(normalize(term))) && !auxiliary
    const unsafe =
      entry.section.id.startsWith('/unsafe#') && statusName === normalizedQuery
    const referenceMaterial =
      !words.some((word) =>
        /^(?:guides?|tutorials?|forums?|subreddit|wiki|documentation)$/.test(
          word
        )
      ) &&
      /\b(?:guides?|tutorials?|forums?|subreddit|wiki|documentation)\b/i.test(
        entry.description.split('/')[0]
      )
    let rank = single
      ? [
          unsafe,
          direct,
          exact && !reference,
          active,
          !reference,
          nameMatch,
          curated
        ]
      : [
          unsafe,
          exact && !reference,
          active,
          !reference,
          headingRank,
          curated,
          nameMatch
        ]
    if (task)
      rank = [
        unsafe,
        active,
        !reference,
        !referenceMaterial,
        headingRank,
        curated,
        exact && !reference,
        nameMatch
      ]
    if (topic || (single && !lookup))
      rank = [unsafe, active, !reference, curated]
    quality.set(result.id, rank.map(Number))
  }
  const sectionOrder = new Map(
    sections.map((section, ordinal) => [section.id, ordinal])
  )
  matches.sort((a, b) => {
    const left = quality.get(a.id)!,
      right = quality.get(b.id)!
    for (let i = 0; i < left.length; i++)
      if (left[i] !== right[i]) return right[i] - left[i]
    const x = byId.get(a.id)!,
      y = byId.get(b.id)!
    return (
      sectionOrder.get(x.section.id)! - sectionOrder.get(y.section.id)! ||
      x.order - y.order
    )
  })
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
  if (topic)
    results.sort(
      (a, b) =>
        topicStrength(b) - topicStrength(a) ||
        (topicStrength(a) > 0
          ? Number(!a.entryMatch?.entries?.some((entry) => !entry.heading)) -
              Number(!b.entryMatch?.entries?.some((entry) => !entry.heading)) ||
            (a.sectionOrder ?? 0) - (b.sectionOrder ?? 0)
          : sectionOrder.get(a.id)! - sectionOrder.get(b.id)!)
    )
  else if (single && !lookup)
    results.sort((a, b) => sectionOrder.get(a.id)! - sectionOrder.get(b.id)!)
  return results
}
