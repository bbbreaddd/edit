import assert from 'node:assert/strict'
import test from 'node:test'
import {
  characterCount,
  prepareMarkdown,
  validatePages,
  waitForProduction
} from './sync-rentry.js'

test('prepareMarkdown normalizes generated markdown', () => {
  assert.equal(prepareMarkdown('\ufeffOne\r\nTwo\r\n\r\n'), 'One\nTwo')
})

test('characterCount counts Unicode code points rather than UTF-16 units', () => {
  assert.equal(characterCount('a😀b'), 3)
})

test('validatePages rejects duplicate slugs regardless of case', () => {
  assert.throws(
    () =>
      validatePages([
        { slug: 'FMHY', source: 'one.md', text: 'one' },
        { slug: 'fmhy', source: 'two.md', text: 'two' }
      ]),
    /Duplicate Rentry slug/
  )
})

test('validatePages rejects pages over Rentry limit', () => {
  assert.throws(
    () =>
      validatePages([
        { slug: 'FMHY', source: 'large.md', text: 'x'.repeat(200_001) }
      ]),
    /Rentry allows 200000/
  )
})

test('waitForProduction accepts the expected deployed commit', async () => {
  const commit = 'a'.repeat(40)
  await waitForProduction(commit, {
    attempts: 1,
    delay: 0,
    request: async () => ({
      ok: true,
      json: async () => ({ commit })
    })
  })
})

test('waitForProduction refuses a different deployed commit', async () => {
  await assert.rejects(
    waitForProduction('a'.repeat(40), {
      attempts: 1,
      delay: 0,
      request: async () => ({
        ok: true,
        json: async () => ({ commit: 'b'.repeat(40) })
      })
    }),
    /Rentry was not changed/
  )
})
