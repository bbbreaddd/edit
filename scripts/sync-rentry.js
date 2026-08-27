import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const RENTRY_API = 'https://rentry.co/api/edit'
const RENTRY_LIMIT = 200_000
const PRODUCTION_MARKER = 'https://fmhy.net/deployment.json'
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

export function characterCount(value) {
  return Array.from(value).length
}

export function prepareMarkdown(markdown) {
  return markdown
    .replace(/^\ufeff/, '')
    .replace(/\r\n/g, '\n')
    .trimEnd()
}

export function validatePages(pages) {
  const slugs = new Set()

  for (const page of pages) {
    if (!page.slug || !page.source) {
      throw new Error('Every Rentry page needs a slug and source file')
    }
    if (slugs.has(page.slug.toLowerCase())) {
      throw new Error(`Duplicate Rentry slug: ${page.slug}`)
    }
    slugs.add(page.slug.toLowerCase())

    const length = characterCount(page.text)
    if (length > RENTRY_LIMIT) {
      throw new Error(
        `${page.source} is ${length} characters; Rentry allows ${RENTRY_LIMIT}`
      )
    }
  }
}

export async function waitForProduction(
  expectedCommit,
  { attempts = 12, delay = 5_000, request = fetch } = {}
) {
  if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) {
    throw new Error(
      'A full production commit SHA is required when using --write'
    )
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const markerUrl = `${PRODUCTION_MARKER}?commit=${expectedCommit}`
      const response = await request(markerUrl, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(10_000)
      })
      if (response.ok) {
        const marker = await response.json()
        if (marker.commit === expectedCommit) {
          console.log(`fmhy.net is serving commit ${expectedCommit}`)
          return
        }
      }
    } catch (error) {
      if (attempt === attempts) throw error
    }

    if (attempt < attempts) {
      console.log(
        `Waiting for fmhy.net to serve ${expectedCommit} (${attempt}/${attempts})`
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw new Error(
    `fmhy.net did not report production commit ${expectedCommit}; Rentry was not changed`
  )
}

async function loadPages() {
  const manifestPath = path.join(REPOSITORY_ROOT, 'scripts/rentry-pages.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))

  return Promise.all(
    manifest.map(async (page) => ({
      ...page,
      text: prepareMarkdown(
        await fs.readFile(path.join(REPOSITORY_ROOT, page.source), 'utf8')
      )
    }))
  )
}

async function updatePage(page, modifyCode) {
  const body = new URLSearchParams({
    edit_code: modifyCode,
    text: page.text
  })
  const response = await fetch(`${RENTRY_API}/${page.slug}`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(30_000)
  })

  if (!response.ok) {
    throw new Error(`Rentry returned HTTP ${response.status} for ${page.slug}`)
  }

  const result = await response.json()
  if (String(result.status) !== '200') {
    throw new Error(
      `Rentry rejected ${page.slug}: ${result.errors || result.content}`
    )
  }
}

export async function syncPages({ write = false } = {}) {
  const pages = await loadPages()
  validatePages(pages)

  for (const page of pages) {
    console.log(
      `${write ? 'Syncing' : 'Checked'} ${page.slug} from ${page.source} (${characterCount(page.text)} characters)`
    )
  }

  if (!write) {
    console.log(`Dry run complete: ${pages.length} pages are ready to sync`)
    return
  }

  const modifyCode = process.env.RENTRY_MODIFY_CODE
  if (!modifyCode) {
    throw new Error('RENTRY_MODIFY_CODE is required when using --write')
  }

  await waitForProduction(process.env.EXPECTED_DEPLOYMENT_SHA || '')

  for (const page of pages) {
    await updatePage(page, modifyCode)
  }
  console.log(`Synced ${pages.length} Rentry pages`)
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMainModule) {
  const allowedArguments = new Set(['--write'])
  const unknownArgument = process.argv
    .slice(2)
    .find((argument) => !allowedArguments.has(argument))

  if (unknownArgument) {
    console.error(`Unknown argument: ${unknownArgument}`)
    process.exitCode = 1
  } else {
    syncPages({ write: process.argv.includes('--write') }).catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  }
}
