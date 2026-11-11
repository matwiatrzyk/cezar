// The one table for shared/adapter-support.ts, run against each plugin's built copy.
import test from 'node:test'
import assert from 'node:assert/strict'

class FakeAgent { closed = false; constructor(options) { this.options = options } async close() { this.closed = true } }
const address = last => ({ address: `8.8.8.${last}`, family: 4 })

export function adapterSupportTable(module) {
 test('a pooled agent is reused per validated address', () => {
  const agentFor = module.agentPool(FakeAgent)
  assert.equal(agentFor(address(1)), agentFor(address(1)))
  assert.notEqual(agentFor(address(1)), agentFor(address(2)))
 })
 test('a pooled agent can dial only its validated address', () => {
  const agent = module.agentPool(FakeAgent)(address(1))
  agent.options.connect.lookup('elsewhere', {}, (_error, resolved) => assert.equal(resolved, '8.8.8.1'))
 })
 test('the pool is bounded and closes what it evicts', () => {
  const agentFor = module.agentPool(FakeAgent), first = agentFor(address(1))
  for (let last = 2; last <= 5; last++) agentFor(address(last))
  assert.equal(first.closed, true)
  assert.notEqual(agentFor(address(1)), first)
 })
}
