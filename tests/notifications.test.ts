import { expect, test } from 'bun:test'
import { ownedNotification } from '../experiments/notifications.ts'

const owned = new Set(['side123'])
const notification = '<task-notification>\n<task-id>side123</task-id>\n<result>hello</result></task-notification>'

test('only suppresses engine notifications belonging to the side agent', () => {
  expect(ownedNotification('task-notification', notification, owned)).toBe('side123')
  expect(ownedNotification('composer', notification, owned)).toBeUndefined()
  expect(ownedNotification('peer', notification, owned)).toBeUndefined()
  expect(ownedNotification('task-notification', notification.replace('side123', 'unrelated'), owned)).toBeUndefined()
})

test('does not match an ID inside a result or malformed envelope', () => {
  expect(ownedNotification('task-notification', 'prefix ' + notification, owned)).toBeUndefined()
  expect(ownedNotification('task-notification', '<task-notification><task-id>another</task-id><result>' + notification, owned)).toBeUndefined()
  expect(ownedNotification('task-notification', '<task-id>side123</task-id>', owned)).toBeUndefined()
})
