import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as sdk from '../dist/chat.js'

const epoch = '01234567-89ab-4cde-8fab-0123456789ab'
const event = { kind: 'message', id: 'event-1', chat: { id: 'private:1', kind: 'private' },
  user: { id: '1', label: 'User' }, messageId: '2', at: 1, text: 'help', addressed: true }

test('ordered acceptance preserves a no-op checkpoint and rejects unsafe successor arithmetic', () => {
  assert.deepEqual(sdk.chatDeliverySchema.parse({ kind: 'ordered', epoch, sequence: 0 }), { kind: 'ordered', epoch, sequence: 0 })
  for (const sequence of [-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity]) {
    assert.equal(sdk.chatDeliverySchema.safeParse({ kind: 'ordered', epoch, sequence }).success, false)
  }
})

test('opaque events cannot claim a platform cursor or another epoch', () => {
  assert.deepEqual(sdk.chatDeliverySchema.parse({ kind: 'event', event }), { kind: 'event', event })
  assert.equal(sdk.chatDeliverySchema.safeParse({ kind: 'event', event, epoch, sequence: 1 }).success, false)
})

test('accepted responses require a host checkpoint and a known disposition', () => {
  assert.deepEqual(sdk.chatAcceptedSchema.parse({ disposition: 'duplicate', checkpoint: { epoch, nextSequence: null } }),
    { disposition: 'duplicate', checkpoint: { epoch, nextSequence: null } })
  for (const checkpoint of [{ epoch: 'worker', nextSequence: 1 }, { epoch, nextSequence: -1 }, { epoch }]) {
    assert.equal(sdk.chatAcceptedSchema.safeParse({ disposition: 'accepted', checkpoint }).success, false)
  }
  assert.equal(sdk.chatAcceptedSchema.safeParse({ disposition: 'failed', checkpoint: { epoch, nextSequence: 1 } }).success, false)
})

test('native interactions carry actor identity but cannot choose a project or send wire tokens', () => {
  const input = { kind: 'task-autocomplete', eventId: 'interaction-1', chat: event.chat, user: event.user, at: 1 }
  assert.deepEqual(sdk.chatInteractionInputSchema.parse(input), input)
  for (const extra of [{ projectId: 'other' }, { token: 'wire-secret' }, { at: -1 }]) {
    assert.equal(sdk.chatInteractionInputSchema.safeParse({ ...input, ...extra }).success, false)
  }
})

test('native results have platform-sized bounded fields and count', () => {
  const choice = { name: 'Task', value: 'task-id' }
  assert.deepEqual(sdk.chatTaskChoicesSchema.parse([choice]), [choice])
  assert.equal(sdk.chatTaskChoicesSchema.safeParse(Array(26).fill(choice)).success, false)
  assert.equal(sdk.chatTaskChoicesSchema.safeParse([{ ...choice, name: 'x'.repeat(101) }]).success, false)
  assert.equal(sdk.chatTaskChoicesSchema.safeParse([{ ...choice, value: '' }]).success, false)
})
