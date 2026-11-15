import type { SearchResult } from 'minisearch'

export interface Result {
  title: string
  titles: string[]
  text?: string
  urlMatched?: boolean
  urlMatchedStarred?: boolean
  urlMatchRank?: number
  substringMatched?: boolean
  searchBranches?: string[]
}

export interface SidebarItem {
  text?: string
  link?: string
  items?: SidebarItem[]
}

export interface LinkMetadata {
  l?: string[]
  s?: string[]
  u?: string[]
  su?: string[]
  a?: string[]
}
export type SearchMetadata = Record<string, LinkMetadata>
export interface SearchEntryMatch {
  heading?: boolean
  context: string
  phrases: string[]
  rank: number
}

export type LocalSearchResult = SearchResult &
  Result & {
    matchesWithoutTerms?: (
      terms: ReadonlySet<string>,
      includeHeadings?: boolean
    ) => boolean
    entryMatch?: {
      groups: string[][]
      withHeadingContext?: boolean
      headings?: string[]
      auxiliary: string[]
      entries?: SearchEntryMatch[]
    }
    branchMatches?: Record<string, LocalSearchResult>
  }
