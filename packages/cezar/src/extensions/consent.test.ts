import { expect, it } from 'vitest'
import { extensionRecordSchema, type ExtensionRecord } from '@open-mercato/cezar-contract'
import { keepsConsent } from './manager.ts'

const record = (manifest: Record<string, unknown>, enabled = true): ExtensionRecord => extensionRecordSchema.parse({
  manifest: { id: 'probe', name: 'Probe', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', ...manifest },
  source: './probe', installedAt: '2026-11-06T00:00:00.000Z', enabled,
})

it('asks again when an update drops its capability list (unrestricted is wider than any list)', () => {
  const old = record({ capabilities: ['commands'], actions: [{ id: 'a', title: 'A' }] })
  const next = record({ actions: [{ id: 'a', title: 'A' }], contributes: { chatProviders: [{"id": "chat", "label": "Mattermost", "credentials": [{"name": "server", "label": "Mattermost HTTPS server URL", "secret": false}, {"name": "token", "label": "Dedicated bot access token"}], "limits": {"maxText": 4000, "buttonsPerMessage": 0, "perChatPerSecond": 1, "perBotPerSecond": 5}, "commandPrefix": "cezar ", "groupPrefix": "group:", "discoveryUrl": "https://docs.mattermost.com"}] } })
  expect(keepsConsent(old, next)).toBe(false)
})

it('asks again for an added capability or permission, keeps consent otherwise', () => {
  const old = record({ capabilities: ['commands', 'panels'] })
  expect(keepsConsent(old, record({ capabilities: ['commands'] }))).toBe(true)
  expect(keepsConsent(old, record({ capabilities: ['commands', 'taskEvents'] }))).toBe(false)
  expect(keepsConsent(old, record({ capabilities: ['commands'], permissions: ['tasks.read'] }))).toBe(false)
})

it('keeps an unrestricted approval and never resumes a disabled one', () => {
  expect(keepsConsent(record({}), record({ capabilities: ['commands'] }))).toBe(true)
  expect(keepsConsent(record({}, false), record({}))).toBe(false)
  expect(keepsConsent(undefined, record({}))).toBe(false)
})
