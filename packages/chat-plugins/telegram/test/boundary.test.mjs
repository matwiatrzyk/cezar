import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

test('published sources and declarations depend only on the public SDK', async () => {
  const root = new URL('..', import.meta.url)
  const files = [
    ...(await readdir(new URL('src/', root))).map(name => new URL(`src/${name}`, root)),
    ...(await readdir(new URL('dist/', root))).filter(name => name.endsWith('.d.ts') || name.endsWith('.js')).map(name => new URL(`dist/${name}`, root)),
  ]
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    assert.doesNotMatch(source, /@open-mercato\/cezar(?:-contract|-api-client)?['"/]/, file.pathname)
    assert.doesNotMatch(source, /packages\/cezar|\.\.\/\.\.\//, file.pathname)
  }
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.deepEqual(Object.keys(pkg.dependencies), ['@open-mercato/cezar-extension-sdk', 'undici'])
  assert.doesNotMatch(JSON.stringify(pkg), /workspace:|file:/)
})
