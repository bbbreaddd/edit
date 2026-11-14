import type MiniSearch from 'minisearch'
import type { SearchResult } from 'minisearch'
import type { Result, SearchMetadata } from './types'
import {
  INVISIBLE_CHARS_RE,
  normalizeSearchUrl,
  stripSchemeAndWww
} from './normalization'

export function normalizeUrlSearchValue(value: string) {
  let decoded = value.trim()
  try {
    decoded = decodeURI(decoded)
  } catch {
    // Keep the raw value if it is not a valid encoded URI.
  }
  return decoded
    .replace(INVISIBLE_CHARS_RE, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

// Known multi-part public suffixes and subdomain-hosting platforms. For these
// the registrable *label* is the part left of the suffix, so "silentaperture"
// resolves silentaperture.gitlab.io and "example" resolves example.co.uk —
// while "vercel"/"itch"/"com" don't leak-match every site on the platform.
const URL_HOST_SUFFIXES = new Set([
  // multi-part TLDs
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'com.br',
  'com.mx',
  'co.jp',
  'co.in',
  'co.nz',
  'co.za',
  'co.kr',
  // subdomain-as-product hosting platforms
  'github.io',
  'gitlab.io',
  'pages.dev',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'web.app',
  'firebaseapp.com',
  'surge.sh',
  'neocities.org',
  'itch.io',
  'blogspot.com',
  'wordpress.com',
  'js.org',
  'readthedocs.io',
  'notion.site',
  'sourceforge.io',
  'glitch.me',
  'repl.co',
  'fandom.com',
  'gitbook.io',
  'substack.com',
  'ghost.io',
  'pythonanywhere.com',
  'herokuapp.com'
])

// Ubiquitous shared platforms where the *domain* is not the entry's identity
// (github.com appears ~10k times in the wiki). Domain-mode URL search skips
// these so "github"/"discord"/"reddit" don't flood; they remain reachable via
// an explicit path query ("github.com/yt-dlp") and via normal title/text search.
const URL_SHARED_DOMAINS = new Set([
  'github.com',
  'gitlab.com',
  'codeberg.org',
  'bitbucket.org',
  'sourceforge.net',
  'greasyfork.org',
  'reddit.com',
  'discord.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'facebook.com',
  'instagram.com',
  'medium.com',
  'archive.org',
  'play.google.com',
  'apps.apple.com',
  'chromewebstore.google.com',
  'addons.mozilla.org',
  'docs.google.com',
  'drive.google.com',
  'sites.google.com',
  'cse.google.com',
  'support.google.com'
])

// Per-domain and total ceilings on URL-only matches, so no single domain (or a
// broad query) can ever flood the result list regardless of the heuristics.
const MAX_URL_MATCHES_PER_DOMAIN = 8
const MAX_URL_MATCHES_TOTAL = 60

// Below this length a bare query only matches a label by prefix/exact, never a
// mid-label substring: "wco" should hit "wcofun" but not "showcode". Longer
// needles keep substring matching so intentional fragments still work.
const MIN_SUBSTRING_NEEDLE_LENGTH = 4

// Punctuation-insensitive form so "pihole" matches "pi-hole".
function compactUrlValue(value: string) {
  return value.replace(/[^a-z0-9]/g, '')
}

// Resolve a host to its registrable label (the meaningful name) and registrable
// domain, honoring the multi-part / hosting suffixes above.
function urlRegistrable(host: string): { label: string; registrable: string } {
  const labels = host.split('.')
  for (let i = 0; i < labels.length - 1; i++) {
    if (URL_HOST_SUFFIXES.has(labels.slice(i + 1).join('.'))) {
      return { label: labels[i], registrable: labels.slice(i).join('.') }
    }
  }
  return {
    label: labels[labels.length - 2] ?? labels[0],
    registrable: labels.slice(-2).join('.')
  }
}

interface UrlQuery {
  // 'path' → the user typed a "/" so we match host + path directly.
  // 'domain' → match against the domain only.
  mode: 'path' | 'domain'
  // path mode: the host+path needle (e.g. "github.com/yt-dlp").
  needle: string
  // domain mode: query forms tested against the domain (raw + compacted).
  needles: string[]
  // domain mode: match the full host (query had a TLD, e.g. "pi-hole.net")
  // rather than the registrable label.
  matchFullHost: boolean
  // The user typed a scheme ("https://") or leading "www." — a literal
  // start-of-URL signal, so anchor to the host start (prefix) instead of
  // matching the needle anywhere inside the label. Keeps "https://wco" off
  // "showcode.app" (where "wco" sits mid-label) while still hitting "wcofun".
  anchored: boolean
}

// Parse the query once so it can be tested against many stored URLs cheaply.
// Returns null when the query is too short to be a meaningful URL match.
export function buildUrlQuery(query: string): UrlQuery | null {
  const normalized = normalizeUrlSearchValue(query)
  if (normalized.length < 3) return null

  // A typed scheme or leading "www." anchors the match to the host start.
  const anchored =
    /^[a-z][a-z0-9+.-]*:\/\//.test(normalized) || normalized.startsWith('www.')
  const stripped = normalizeSearchUrl(normalized)
  // A "/" means the user typed a path, so match against host + path directly.
  if (stripped.includes('/')) {
    return {
      mode: 'path',
      needle: stripped,
      needles: [],
      matchFullHost: false,
      anchored
    }
  }
  // A "." means the user typed a domain with its TLD (pi-hole.net) → match the
  // full host. Otherwise it's a bare word → match the registrable label.
  return {
    mode: 'domain',
    needle: '',
    needles: [
      ...new Set([stripped, compactUrlValue(stripped)].filter(Boolean))
    ],
    matchFullHost: stripped.includes('.'),
    anchored
  }
}

export function looksLikeUrlQuery(query: string) {
  const normalized = normalizeUrlSearchValue(query)
  const stripped = stripSchemeAndWww(normalized)
  const isSingleToken = !/\s/.test(query.trim())
  return (
    /^[a-z][a-z0-9+.-]*:\/\//.test(normalized) ||
    normalized.startsWith('www.') ||
    (isSingleToken && stripped.includes('.')) ||
    (isSingleToken && stripped.includes('/'))
  )
}

// `normalizedUrl` may be a raw href or the stored normalized form; normalize it
// here so query params are encoded the same way as build-time URL metadata.
export function urlMatchesNormalizedUrl(
  normalizedUrl: string,
  urlQuery: UrlQuery
) {
  const hostPath = normalizeSearchUrl(normalizedUrl)
  if (urlQuery.mode === 'path') {
    return hostPath.includes(urlQuery.needle)
  }
  const host = hostPath.split(/[/?#]/)[0]
  const { label, registrable } = urlRegistrable(host)
  // Skip ubiquitous shared platforms in domain mode (see URL_SHARED_DOMAINS).
  if (URL_SHARED_DOMAINS.has(host) || URL_SHARED_DOMAINS.has(registrable)) {
    return false
  }
  const target = urlQuery.matchFullHost ? host : label
  const haystacks = [target, compactUrlValue(target)]
  return urlQuery.needles.some((needle) => {
    // Mirror recordMatchRank: anchored queries and short needles match by
    // prefix only, longer needles also match a mid-label substring.
    const prefixOnly =
      urlQuery.anchored || needle.length < MIN_SUBSTRING_NEEDLE_LENGTH
    return haystacks.some((haystack) =>
      prefixOnly ? haystack.startsWith(needle) : haystack.includes(needle)
    )
  })
}

// A stored URL with its host parts parsed once at index-build time so the hot
// search path never re-strips/-splits the same URL on every keystroke.
export interface UrlRecord {
  id: string
  hostPath: string // host + path (e.g. "github.com/yt-dlp")
  host: string // host only (e.g. "github.com")
  label: string // registrable label (e.g. "pi-hole")
  registrable: string // registrable domain (e.g. "pi-hole.net")
  compactHost: string // punctuation-stripped host
  compactLabel: string // punctuation-stripped label
  isShared: boolean // host/registrable is a suppressed shared platform
  starred: boolean // URL came from a starred list item
}

// Flatten customMetadata into one parsed record per stored URL. Recomputed only
// when the metadata changes (locale switch / HMR), not per search, so the parse
// cost is paid once instead of on every keystroke (see findUrlMatches).
export function buildUrlIndex(customMetadata: SearchMetadata): UrlRecord[] {
  const records: UrlRecord[] = []
  for (const id in customMetadata) {
    const urls = customMetadata[id].u
    if (!urls) continue
    const starredUrls = new Set(customMetadata[id].su ?? [])
    for (const url of urls) {
      // Stored URLs are already normalized + scheme/www-stripped at build time.
      const hostPath = stripSchemeAndWww(url)
      const host = hostPath.split(/[/?#]/)[0]
      const { label, registrable } = urlRegistrable(host)
      records.push({
        id,
        hostPath,
        host,
        label,
        registrable,
        compactHost: compactUrlValue(host),
        compactLabel: compactUrlValue(label),
        isShared:
          URL_SHARED_DOMAINS.has(host) || URL_SHARED_DOMAINS.has(registrable),
        starred: starredUrls.has(url)
      })
    }
  }
  return records
}

// How strongly a haystack matches a needle: 3 = exact, 2 = prefix, 1 = substring,
// 0 = no match. Lets findUrlMatches keep the most relevant matches when a cap
// forces a cut, instead of dropping by arbitrary index order.
function matchStrength(haystack: string, needle: string) {
  if (haystack === needle) return 3
  if (haystack.startsWith(needle)) return 2
  if (haystack.includes(needle)) return 1
  return 0
}

// Rank a pre-parsed record against the query (0 = no match). Mirrors
// urlMatchesNormalizedUrl's matching, but reads the precomputed host parts
// instead of re-deriving them, and returns a strength instead of a boolean.
export function recordMatchRank(rec: UrlRecord, urlQuery: UrlQuery) {
  if (urlQuery.mode === 'path') {
    return matchStrength(rec.hostPath, urlQuery.needle)
  }
  if (rec.isShared) return 0
  const haystacks = urlQuery.matchFullHost
    ? [rec.host, rec.compactHost]
    : [rec.label, rec.compactLabel]
  let best = 0
  for (const needle of urlQuery.needles) {
    // Anchored queries (typed scheme / www.) and short needles only accept
    // exact/prefix matches (strength >= 2), never a mid-label substring.
    const minStrength =
      urlQuery.anchored || needle.length < MIN_SUBSTRING_NEEDLE_LENGTH ? 2 : 1
    for (const haystack of haystacks) {
      const s = matchStrength(haystack, needle)
      if (s >= minStrength) best = Math.max(best, s)
    }
  }
  return best
}

export function findUrlMatches(
  index: MiniSearch<Result>,
  query: string,
  urlIndex: UrlRecord[]
) {
  const matches: (SearchResult & Result)[] = []
  const urlQuery = buildUrlQuery(query)
  if (!urlQuery) return matches

  // Gather one candidate per entry first, keeping the best-ranked matching URL
  // for that entry. One entry can own several URLs; mirror the old `meta.u.find`
  // by counting each entry at most once.
  const candidates = new Map<string, UrlRecord & { rank: number }>()
  for (const rec of urlIndex) {
    const rank = recordMatchRank(rec, urlQuery)
    if (rank === 0) continue
    const existing = candidates.get(rec.id)
    if (
      !existing ||
      rank > existing.rank ||
      (rank === existing.rank && rec.starred)
    ) {
      candidates.set(rec.id, { ...rec, rank })
    }
  }

  // Sort by relevance before applying the ceilings, so when a cap forces a cut
  // we drop the *least* relevant matches: curated/starred entries first, then
  // by match strength (exact > prefix > substring). Within-cap order doesn't
  // matter — the merged result set is re-sorted globally by tier/score later.
  const ranked = [...candidates.values()].sort((a, b) => {
    return Number(b.starred) - Number(a.starred) || b.rank - a.rank
  })

  // Hard ceilings (see MAX_URL_MATCHES_*) so no single domain or broad query
  // can flood the result list, even past the matching heuristics.
  const perDomain = new Map<string, number>()
  for (const rec of ranked) {
    const seen = perDomain.get(rec.registrable) ?? 0
    if (seen >= MAX_URL_MATCHES_PER_DOMAIN) continue

    const storedFields = index.getStoredFields(rec.id) as Result | undefined
    if (!storedFields) continue

    perDomain.set(rec.registrable, seen + 1)
    matches.push({
      id: rec.id,
      score: 1,
      terms: [query],
      queryTerms: [query],
      match: {},
      ...storedFields,
      urlMatched: true,
      urlMatchedStarred: rec.starred
    })
    if (matches.length >= MAX_URL_MATCHES_TOTAL) break
  }
  return matches
}
