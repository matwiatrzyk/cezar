import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import config from '../../e2e/vitest.config'

const dir = join(import.meta.dirname, '../../e2e')
const runnerSpecs = readdirSync(dir).filter(name => name.endsWith('.e2e.ts') && readFileSync(join(dir, name), 'utf8').includes("from '@e2e-dev/web'"))

it('keeps every @e2e-dev/web spec out of the vitest e2e suite', () => {
  // Their test() throws a CollectionError under vitest; they run through their own e2e configs.
  expect(runnerSpecs.length).toBeGreaterThan(0)
  const exclude = (config as { test: { exclude: string[] } }).test.exclude
  expect(runnerSpecs.filter(name => !exclude.includes(name))).toEqual([])
  expect(exclude).not.toContain('smoke.e2e.ts')
})
