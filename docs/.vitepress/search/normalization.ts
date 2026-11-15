export const INVISIBLE_CHARS_RE = /\u2060|\u200B|\u200C|\u200D|\uFEFF/g

export function parseSearchQuery(value: string) {
  const tokens = value.match(/[^\s"“]*(?:"[^"\n]*"|“[^”\n]*”)|\S+/g) ?? []
  const sites: string[] = []
  const excludedTerms: string[] = []
  const excludedSites: string[] = []
  const titles: string[] = []
  const urls: string[] = []
  const text: string[] = []
  const branches: string[] = []
  let branch: string[] = []
  for (const token of tokens) {
    if (token === 'OR' && branch.length) {
      branches.push(branch.join(' '))
      branch = []
    } else branch.push(token)
  }
  if (branches.length && branch.length) branches.push(branch.join(' '))
  else branches.length = 0

  const unquote = (text: string) =>
    /^".*"$|^“.*”$/.test(text) ? text.slice(1, -1) : text
  for (const token of tokens) {
    if (branches.length && token === 'OR') continue
    const operator = token.match(/^(-site:|site:|intitle:|inurl:|-)(.+)$/i)
    if (!operator) {
      text.push(token)
      continue
    }
    const targets: Record<string, string[]> = {
      'site:': sites,
      '-site:': excludedSites,
      '-': excludedTerms,
      'intitle:': titles,
      'inurl:': urls
    }
    targets[operator[1].toLowerCase()].push(unquote(operator[2]))
  }
  const trimmed = text.join(' ')
  const isPhrase = text.length === 1 && /^".*"$|^“.*”$/.test(trimmed)
  return {
    text: (isPhrase ? unquote(trimmed) : trimmed).replace(/\s+/g, ' ').trim(),
    isPhrase,
    sites,
    excludedTerms,
    excludedSites,
    titles,
    urls,
    branches
  }
}

export function createPhraseRegex(text: string, global = false) {
  if (!text) return /(?!)/g
  const characters = Array.from(text)
  const word = /[\p{L}\p{N}_]/u
  const start = word.test(characters[0]) ? '(?<![\\p{L}\\p{N}_])' : ''
  const end = word.test(characters[characters.length - 1])
    ? '(?![\\p{L}\\p{N}_])'
    : ''
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(start + escaped + end, global ? 'giu' : 'iu')
}

export function tokenizeIndexLike(
  text: string,
  splitDottedParts = false
): string[] {
  return tokenizeSearchText(text).flatMap((piece) => {
    const processed = processSearchTerm(
      piece,
      splitDottedParts ? 'text' : undefined
    )
    return processed === false ? [] : processed
  })
}

export function tokenizeSearchText(text: string): string[] {
  // VitePress serializes this function into site data, so it must be self-contained.
  return text
    .replace(/\u2060|\u200B|\u200C|\u200D|\uFEFF/g, '')
    .split(/[\n\r #%*,=/:;?[\]{}()&]+/u)
}

export function processSearchTerm(
  term: string,
  fieldName?: string
): string | string[] | false {
  // This function also crosses VitePress' function serialization boundary.
  const stopWords = [
    'frontmatter',
    '$frontmatter.synopsis',
    'and',
    'about',
    'but',
    'now',
    'the',
    'with',
    'you'
  ]
  term = term.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
  if (term.length < 2 || stopWords.includes(term)) return false
  if (fieldName === 'text' && term.includes('.')) {
    return [term, ...term.split('.')].filter(
      (part) => part.length >= 2 && !stopWords.includes(part)
    )
  }
  return term
}

// Strip the URL scheme and a leading "www." so "https://www.pi-hole.net/x" and
// "pi-hole.net/x" compare the same way. Shared by the build-time index
// (constants.ts) and the client search box so they normalize identically.
export const stripSchemeAndWww = (value: string) =>
  value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '')

const TRACKING_QUERY_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'mc_cid',
  'mc_eid',
  'wbraid'
])

export function normalizeSearchUrl(value: string) {
  const stripped = stripSchemeAndWww(value)
  const hashIndex = stripped.indexOf('#')
  const withoutHash = hashIndex === -1 ? stripped : stripped.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : stripped.slice(hashIndex + 1)
  const queryIndex = withoutHash.indexOf('?')

  if (queryIndex === -1) return hash ? `${withoutHash}#${hash}` : withoutHash

  const hostPath = withoutHash.slice(0, queryIndex)
  const params = new URLSearchParams(withoutHash.slice(queryIndex + 1))
  for (const key of [...params.keys()]) {
    if (key.startsWith('utm_') || TRACKING_QUERY_PARAMS.has(key)) {
      params.delete(key)
    }
  }

  const query = params.toString()
  return `${hostPath}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`
}
