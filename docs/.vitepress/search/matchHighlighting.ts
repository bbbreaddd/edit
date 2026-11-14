import { escapeRegExp } from 'vitepress/dist/client/shared'
import { stripSchemeAndWww } from './normalization'
import { looksLikeUrlQuery, normalizeUrlSearchValue } from './urlMatching'

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
) {
  const allTerms = new Set<string>()
  for (const term of terms) {
    allTerms.add(term)
  }
  if (fuzzy && !looksLikeUrlQuery(rawQuery)) {
    const words = rawQuery
      .trim()
      .split(/[\s\W]+/)
      .filter(Boolean)
    for (const word of words) {
      allTerms.add(word)
    }
  } else {
    const trimmed = rawQuery.trim()
    allTerms.add(trimmed)
    if (looksLikeUrlQuery(rawQuery)) {
      const stripped = stripSchemeAndWww(normalizeUrlSearchValue(trimmed))
      if (stripped && stripped !== trimmed.toLowerCase()) {
        allTerms.add(stripped)
      }
    }
  }
  return new RegExp(
    [...allTerms]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map((term) => `(${escapeRegExp(term)})`)
      .join('|'),
    'gi'
  )
}
