// Asserts the must-NOT-compile cases in `type-tests/negative.ts` still fail,
// and fail for the stated reason. Matching in both directions is the point: an
// expectation with no diagnostic means a regression made the case compile, and
// a diagnostic with no expectation means the tests are failing for the wrong
// reason.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const FILE = 'type-tests/negative.ts'
const PROJECT = 'type-tests/tsconfig.negative.json'

const expectations = readFileSync(FILE, 'utf8')
  .split('\n')
  .flatMap((line, i) => {
    const m = /^\s*\/\/\s*@expect-error\s+(TS\d+)\s+(.+?)\s*$/.exec(line)
    return m ? [{ line: i + 1, code: m[1], message: m[2] }] : []
  })

if (expectations.length === 0) {
  console.error(
    `No @expect-error markers in ${FILE}. Refusing to pass vacuously.`,
  )
  process.exit(1)
}

const tsc = spawnSync(
  'node_modules/.bin/tsc',
  ['--noEmit', '--pretty', 'false', '-p', PROJECT],
  { encoding: 'utf8' },
)

// Fold tsc's indented continuation lines into the preceding diagnostic. Once
// two or more signatures in an overload set can take a handler, a collision is
// reported as TS2769 and the useful text — the `middleware-conflict` sentinel
// included — moves into the per-overload breakdown, where a parser that reads
// only top-level lines cannot see it.
const diagnostics = []
for (const line of `${tsc.stdout ?? ''}\n${tsc.stderr ?? ''}`.split('\n')) {
  const m = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/.exec(line)
  if (m) diagnostics.push({ file: m[1], line: m[2], code: m[4], message: m[5] })
  else if (diagnostics.length && /^\s+\S/.test(line))
    diagnostics[diagnostics.length - 1].message += `\n${line}`
}

const unclaimed = [...diagnostics]
const unmet = []
for (const e of expectations) {
  const i = unclaimed.findIndex(
    (d) => d.code === e.code && d.message.includes(e.message),
  )
  if (i === -1) unmet.push(e)
  else unclaimed.splice(i, 1)
}

for (const e of unmet)
  console.error(
    `${FILE}:${e.line} compiled — expected ${e.code} containing: ${e.message}`,
  )
for (const d of unclaimed)
  console.error(`Unexpected ${d.code} at ${d.file}:${d.line}: ${d.message}`)

if (unmet.length || unclaimed.length) process.exit(1)
console.log(
  `Negative type tests OK — ${expectations.length} expected errors, all matched.`,
)
