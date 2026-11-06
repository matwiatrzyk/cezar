import { expect, it } from 'vitest'
import { extensionLogger } from '../server/extensions.ts'

it('prefixes extension log lines and caps a flood at 100 per minute', () => {
  const lines: string[] = []
  let clock = 0
  const log = extensionLogger('proj', (level, line) => lines.push(`${level} ${line}`), () => clock)
  log('info', 'hello', 'acme.ext')
  expect(lines).toEqual(['info [extension acme.ext] (proj) hello'])
  for (let i = 0; i < 150; i++) log('info', 'spam', 'acme.ext')
  expect(lines.length).toBe(101)
  expect(lines.at(-1)).toMatch(/rate limit/)
  clock = 60_000
  log('error', 'after', 'acme.ext')
  expect(lines.at(-1)).toBe('error [extension acme.ext] (proj) after')
})
