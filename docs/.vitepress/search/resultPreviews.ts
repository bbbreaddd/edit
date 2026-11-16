import type { useData } from 'vitepress/dist/client/theme-default/composables/data'
import type { Component, Slots } from 'vue'
import type { LocalSearchResult, SearchEntryMatch } from './types'
import { dataSymbol } from 'vitepress'
import { pathToFile } from 'vitepress/dist/client/app/utils'
import { createApp, h } from 'vue'
import CriticalBadge from '../theme/components/CriticalBadge.vue'
import Tooltip from '../theme/components/Tooltip.vue'
import { SEARCH_ENTRY_SELECTOR } from './matchHighlighting'
import {
  createPhraseRegex,
  normalizeSearchText as normalizeExcerptText,
  normalizeSearchUrl,
  normalizeUrlFilters,
  parseSearchQuery,
  tokenizeIndexLike
} from './normalization'
import { mergeSearchMatches } from './searchEngine'
import {
  buildUrlQuery,
  createSiteMatcher,
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
        const rank = primary || descriptive ? (starred ? 2 : 1) : 0
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
