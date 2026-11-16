import type { SearchResult } from 'minisearch'

export interface Result {
  title: string
  titles: string[]
  indexedTitles?: string[]
  pageTitle?: string
  sectionOrder?: number
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
export type SearchRecovery =
  'literal' | 'folded' | 'compound' | 'typo' | 'heading'

export interface SearchTermMatch {
  query: string
  term: string
  recovery: SearchRecovery
  edits: number
  completeness: 'word' | 'prefix' | 'substring'
}

export interface SearchMatchEvidence {
  kind:
    | 'name'
    | 'phrase'
    | 'words'
    | 'heading'
    | 'ancestor'
    | 'auxiliary'
    | 'substring'
  name: boolean
  description: boolean
  heading: 'none' | 'own' | 'parent' | 'ancestor'
  recovery: SearchRecovery
  edits: number
  positions: number[]
  span: number
  ordered: boolean
  completeWords: number
  partial: number
  curated: boolean
  reference: boolean
  warning: boolean
  removed: boolean
  strength: number
  confidence: number
  scopeFit: number
  specificity: number
  resourceName: string
  hasDescription: boolean
  depth: number
  score: number
  order: number
  id: string
}

export interface SearchEntryFields {
  id: string
  sectionId: string
  names: string[]
  body: string
  description: string
  heading: string
  pageAlias: string
  parents: string[]
  specialized: boolean
  scope: string
  starred: boolean
  reference: boolean
  order: number
}

export interface SearchEntryMatch {
  heading?: boolean
  context: string
  phrases: string[]
  rank: number
  id?: string
  evidence?: SearchMatchEvidence
}

export type LocalSearchResult = SearchResult &
  Result & {
    rankingText?: string
    termMatches?: SearchTermMatch[]
    headingSupported?: boolean
    matchesWithoutTerms?: (
      terms: ReadonlySet<string>,
      includeHeadings?: boolean
    ) => boolean
    entryMatch?: {
      groups: string[][]
      resourceContext?: boolean
      withHeadingContext?: boolean
      headings?: string[]
      auxiliary: string[]
      entries?: SearchEntryMatch[]
    }
    branchMatches?: Record<string, LocalSearchResult>
  }
