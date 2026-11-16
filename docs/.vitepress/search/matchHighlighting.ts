import type { LocalSearchResult } from './types'
import Mark from 'mark.js/src/vanilla.js'
import { escapeRegExp } from 'vitepress/dist/client/shared'
import {
  createPhraseRegex,
  normalizeSearchText as normalizeExcerptText,
  parseSearchQuery,
  stripSchemeAndWww,
  tokenizeSearchText
} from './normalization'
import {
  buildUrlQuery,
  isExplicitUrlQuery,
  normalizeUrlSearchValue,
  urlMatchesNormalizedUrl
} from './urlMatching'

const MARK_MERGE_DISTANCE_PX = 20
const MARK_SAME_LINE_THRESHOLD_PX = 5

export function getRelativeOffsetTop(
  element: HTMLElement,
  ancestor: HTMLElement
): number {
  let offsetTop = 0
  let curr: HTMLElement | null = element
  while (curr && curr !== ancestor) {
    offsetTop += curr.offsetTop
    curr = curr.offsetParent as HTMLElement | null
  }
  return offsetTop
}

export function mergeNearbyMarks(resultsEl: HTMLElement | undefined) {
  const excerpts = Array.from(
    resultsEl?.querySelectorAll(
      '.result-item:not(.result-list-leave-active) .result .excerpt'
    ) ?? []
  )

  for (const excerpt of excerpts) {
    const marks = Array.from(
      excerpt.querySelectorAll('mark[data-markjs="true"]')
    ) as HTMLElement[]
    if (marks.length <= 1) continue

    // Snapshot all rects in one pass before any mutations to avoid layout thrash
    type Rect = { left: number; right: number; top: number }
    const rects: Rect[] = marks.map((m) => {
      const r = m.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top }
    })

    let i = 0
    while (i < marks.length - 1) {
      if (marks[i].parentNode !== marks[i + 1].parentNode) {
        i++
        continue
      }

      const distance = rects[i + 1].left - rects[i].right
      const onSameLine =
        Math.abs(rects[i].top - rects[i + 1].top) < MARK_SAME_LINE_THRESHOLD_PX

      if (distance >= 0 && distance < MARK_MERGE_DISTANCE_PX && onSameLine) {
        let node = marks[i].nextSibling
        while (node && node !== marks[i + 1]) {
          const next = node.nextSibling
          marks[i].appendChild(node as Node)
          node = next
        }
        // Also move all children of marks[i + 1] into marks[i]
        while (marks[i + 1].firstChild) {
          marks[i].appendChild(marks[i + 1].firstChild as Node)
        }
        marks[i + 1].remove()
        marks.splice(i + 1, 1)
        // Update rect to the merged right edge so chained merges use correct distance
        rects[i].right = rects[i + 1].right
        rects.splice(i + 1, 1)
      } else {
        i++
      }
    }
  }
}

export function groupMarks(marks: HTMLElement[]): HTMLElement[][] {
  const groups: HTMLElement[][] = []
  if (marks.length === 0) return groups
  if (typeof document === 'undefined') return [marks]

  let currentGroup = [marks[0]]
  for (let i = 1; i < marks.length; i++) {
    const prev = marks[i - 1]
    const curr = marks[i]
    if (prev.parentNode !== curr.parentNode) {
      groups.push(currentGroup)
      currentGroup = [curr]
      continue
    }
    try {
      const range = document.createRange()
      range.setStartAfter(prev)
      range.setEndBefore(curr)
      const textBetween = range.toString()
      if (/^[\s\W]{0,20}$/.test(textBetween)) {
        currentGroup.push(curr)
      } else {
        groups.push(currentGroup)
        currentGroup = [curr]
      }
    } catch {
      groups.push(currentGroup)
      currentGroup = [curr]
    }
  }
  groups.push(currentGroup)
  return groups
}

export function formMarkRegex(
  terms: Set<string>,
  rawQuery: string,
  fuzzy: boolean
): RegExp {
  const {
    text: query,
    isPhrase,
    branches,
    titles,
    phrases,
    unquotedText
  } = parseSearchQuery(rawQuery)
  if (branches.length > 1) {
    return new RegExp(
      branches
        .map((branch) => `(?:${formMarkRegex(terms, branch, fuzzy).source})`)
        .join('|'),
      'giu'
    )
  }
  if (isPhrase) return createPhraseRegex(query, true)
  const quotedWords = new Set(
    phrases.flatMap(tokenizeSearchText).map((word) => word.toLowerCase())
  )
  const allTerms = new Set(
    [...terms].filter(
      (term) => term !== rawQuery && !quotedWords.has(term.toLowerCase())
    )
  )
  for (const title of titles) allTerms.add(title)
  if (fuzzy && !isExplicitUrlQuery(query)) {
    const words = tokenizeSearchText(
      phrases.length ? unquotedText : query
    ).filter(Boolean)
    for (const word of words) {
      allTerms.add(word)
    }
  } else {
    const trimmed = phrases.length ? unquotedText : query
    allTerms.add(trimmed)
    if (isExplicitUrlQuery(query)) {
      const stripped = stripSchemeAndWww(normalizeUrlSearchValue(trimmed))
      if (stripped && stripped !== trimmed.toLowerCase()) {
        allTerms.add(stripped)
      }
    }
  }
  if (!phrases.length && ![...allTerms].some(Boolean)) return /(?!)/g
  return new RegExp(
    [
      ...phrases.map((phrase) => `(?:${createPhraseRegex(phrase).source})`),
      ...[...allTerms]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .map((term) => `(${escapeRegExp(term)})`)
    ].join('|'),
    'giu'
  )
}

export const SEARCH_ENTRY_SELECTOR = 'li, p, pre, tr, blockquote'

export function getSearchEntryText(entry: Element): string {
  const own = entry.cloneNode(true) as Element
  own.querySelectorAll('ul, ol').forEach((list) => list.remove())
  return own.textContent?.trim() ?? ''
}

export function preferredEntryTarget(
  marks: HTMLElement[],
  result: LocalSearchResult,
  root?: Element | null
) {
  const preferred = result.entryMatch?.entries?.[0]
  if (!preferred || preferred.heading) return marks[0]
  const context = normalizeExcerptText(preferred.context)
  const matchesEntry = (entry: Element) =>
    normalizeExcerptText(getSearchEntryText(entry)) === context
  const marked = marks.find((mark) => {
    const entry =
      mark.closest('[data-search-entry]') ?? mark.closest(SEARCH_ENTRY_SELECTOR)
    return entry && matchesEntry(entry)
  })
  if (marked) return marked
  if (result.entryMatch?.resourceContext)
    return (
      [
        ...(root?.querySelectorAll<HTMLElement>('[data-search-entry]') ?? [])
      ].find(matchesEntry) ?? marks[0]
    )
  return marks[0]
}

export async function highlightSearchResults(
  resultsEl: HTMLElement | undefined,
  finalResults: LocalSearchResult[],
  terms: Set<string>,
  query: string,
  fuzzy: boolean,
  isCanceled: () => boolean
) {
  await new Promise<void>((resolve) => {
    if (!resultsEl) {
      resolve()
      return
    }
    const targets = resultsEl.querySelectorAll(
      '.result-item:not(.result-list-leave-active) .titles, .result-item:not(.result-list-leave-active) .excerpt'
    )
    if (targets.length === 0) {
      resolve()
      return
    }
    const m = new Mark(Array.from(targets))
    m.unmark({
      done: () => {
        if (isCanceled()) {
          resolve()
          return
        }
        const jobs = finalResults.flatMap((result) => {
          const item = resultsEl?.querySelector(
            `[data-id="${CSS.escape(result.id)}"]`
          )
          if (!item) return []
          const branches = result.searchBranches ?? [query]
          return branches.map((branch) => {
            const match = result.branchMatches?.[branch] ?? result
            const entries = match.entryMatch?.entries
            const contexts = new Set(
              entries
                ?.filter((entry) => !entry.heading)
                .map((entry) => normalizeExcerptText(entry.context))
            )
            const entryTexts = new WeakMap<Element, string>()
            const contextHeadings = match.entryMatch?.withHeadingContext
              ? (match.entryMatch.headings ?? [])
              : []
            const markTerms = entries
              ? new Set([
                  ...entries.flatMap((entry) => entry.phrases),
                  ...match.terms.filter((term) =>
                    contextHeadings.some((heading) =>
                      normalizeExcerptText(heading).includes(
                        normalizeExcerptText(term)
                      )
                    )
                  )
                ])
              : result.searchBranches
                ? new Set(Object.keys(match.match))
                : terms
            const matchesEntry = (element: Element | null) => {
              if (!entries) return true
              const title = element?.closest('.titles')
              if (title)
                return [
                  ...contextHeadings,
                  ...entries
                    .filter((entry) => entry.heading)
                    .map((entry) => entry.context)
                ].some((heading) =>
                  normalizeExcerptText(title.textContent ?? '').includes(
                    normalizeExcerptText(heading)
                  )
                )
              const entry =
                element?.closest('[data-search-entry]') ??
                element?.closest(SEARCH_ENTRY_SELECTOR)
              if (!entry) return false
              let text = entryTexts.get(entry)
              if (text === undefined) {
                text = normalizeExcerptText(getSearchEntryText(entry))
                entryTexts.set(entry, text)
              }
              return contexts.has(text)
            }
            return new Promise<void>((done) => {
              new Mark([
                ...item.querySelectorAll('.titles, .excerpt')
              ]).markRegExp(formMarkRegex(markTerms, branch, fuzzy), {
                exclude: ['.title-icon', 'mark'],
                acrossElements: false,
                filter: (node: Text) => matchesEntry(node.parentElement),
                done: () => {
                  const parsed = parseSearchQuery(branch)
                  const urlQuery =
                    !parsed.phrases.length && match.urlMatched
                      ? buildUrlQuery(parsed.text)
                      : null
                  if (!isCanceled() && urlQuery) {
                    for (const anchor of item.querySelectorAll<HTMLAnchorElement>(
                      '.excerpt a[href]'
                    )) {
                      if (
                        !matchesEntry(anchor) ||
                        anchor.querySelector('mark[data-markjs="true"]') ||
                        !urlMatchesNormalizedUrl(
                          normalizeUrlSearchValue(
                            anchor.getAttribute('href') ?? ''
                          ),
                          urlQuery
                        )
                      )
                        continue
                      const mark = document.createElement('mark')
                      mark.setAttribute('data-markjs', 'true')
                      mark.append(...anchor.childNodes)
                      anchor.appendChild(mark)
                    }
                  }
                  done()
                }
              })
            })
          })
        })
        Promise.all(jobs).then(() => resolve())
      }
    })
  })
}
