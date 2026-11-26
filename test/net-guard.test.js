import test from 'node:test'
import assert from 'node:assert/strict'
import { addressMatches, isTailnetAddress, normalizeAddress, peerAllowed } from '../lib/net-guard.js'

test('normalizeAddress strips mapped prefixes and zones', () => {
  assert.equal(normalizeAddress('::ffff:100.100.10.20'), '100.100.10.20')
  assert.equal(normalizeAddress('fe80::1%eth0'), 'fe80::1')
  assert.equal(normalizeAddress(undefined), '')
})

test('isTailnetAddress only accepts 100.64.0.0/10 and fd7a:115c:a1e0::/48', () => {
  assert.equal(isTailnetAddress('100.100.10.20'), true)
  assert.equal(isTailnetAddress('100.64.0.1'), true)
  assert.equal(isTailnetAddress('100.127.255.254'), true)
  assert.equal(isTailnetAddress('100.128.0.1'), false)
  assert.equal(isTailnetAddress('192.168.1.5'), false)
  assert.equal(isTailnetAddress('0.0.0.0'), false)
  assert.equal(isTailnetAddress('8.8.8.8'), false)
  assert.equal(isTailnetAddress('fd7a:115c:a1e0::a73b:6222'), true)
  assert.equal(isTailnetAddress('fd7a:115c:a1e1::1'), false)
  assert.equal(isTailnetAddress('::1'), false)
})

test('addressMatches supports exact addresses and CIDR', () => {
  assert.equal(addressMatches('100.100.10.30', '100.100.10.30'), true)
  assert.equal(addressMatches('100.100.10.30', '100.100.10.0/24'), true)
  assert.equal(addressMatches('100.100.11.30', '100.100.10.0/24'), false)
  assert.equal(addressMatches('fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::/48'), true)
  assert.equal(addressMatches('fd7a:115c:a1e1::1', 'fd7a:115c:a1e0::/48'), false)
  assert.equal(addressMatches('100.100.10.30', 'not-an-address'), false)
})

test('peerAllowed: empty list allows, malformed rules never widen access', () => {
  assert.equal(peerAllowed('8.8.8.8', []), true)
  assert.equal(peerAllowed('8.8.8.8', undefined), true)
  assert.equal(peerAllowed('100.100.10.30', ['100.100.10.0/24']), true)
  assert.equal(peerAllowed('100.100.10.30', ['garbage', '100.1.1.1']), false)
})
