import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

const commit =
  process.env.CF_PAGES_COMMIT_SHA ||
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

fs.writeFileSync(
  'docs/public/deployment.json',
  `${JSON.stringify({ commit })}\n`
)
console.log(`Generated deployment marker for ${commit}`)
