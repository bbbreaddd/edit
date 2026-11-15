import type { SearchResult } from 'minisearch'

export interface Result {
  title: string
  titles: string[]
  text?: string
  urlMatched?: boolean
  urlMatchedStarred?: boolean
  urlMatchRank?: number
  substringMatched?: boolean
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
}
export type SearchMetadata = Record<string, LinkMetadata>
export type LocalSearchResult = SearchResult & Result
