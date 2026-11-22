import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clampPath,
  crumbsFor,
  filterListing,
  isPathWithin,
  resolvePickerPolicy,
  wrapBrowseCapability,
} from './policy.js'

class DirectoryPickerError extends Error {
  constructor(code, path, message) {
    super(message)
    this.code = code
    this.path = path
  }
}

test('picker policy validates the root/home relationship', () => {
  const policy = resolvePickerPolicy({
    DSH_PICKER_ROOT: '/workspace/alice',
    DSH_PICKER_HOME: '/workspace/alice/workspaces',
    DSH_PICKER_ALLOWED_CREATE_ROOTS: JSON.stringify(['/workspace/alice/workspaces']),
    DSH_MULTIUSER_PICKER_HIDDEN: JSON.stringify(['.dsh', 'tmp']),
  })
  assert.equal(policy.root, '/workspace/alice')
  assert.equal(policy.home, '/workspace/alice/workspaces')
  assert.equal(policy.hidden.has('.dsh'), true)
  assert.throws(() => resolvePickerPolicy({
    DSH_PICKER_ROOT: '/workspace/alice',
    DSH_PICKER_HOME: '/workspace/bob',
  }), /inside/)
})

test('clampPath and crumbs never escape the user root', () => {
  const policy = { root: '/workspace/alice', home: '/workspace/alice/workspaces' }
  assert.equal(clampPath(policy, '/workspace/bob'), policy.home)
  assert.equal(clampPath(policy, '/workspace/alice/documents'), '/workspace/alice/documents')
  assert.deepEqual(crumbsFor(policy.root, '/workspace/alice/documents/default').map(entry => entry.path), [
    '/workspace/alice',
    '/workspace/alice/documents',
    '/workspace/alice/documents/default',
  ])
})

test('filterListing hides internal and external entries', () => {
  const policy = { root: '/workspace/alice', home: '/workspace/alice/workspaces', hidden: new Set(['.dsh']) }
  const listing = {
    path: '/workspace/alice',
    home: '/workspace/alice',
    crumbs: [{ name: '/workspace/alice', path: '/workspace/alice', hidden: false }],
    entries: [
      { name: '.dsh', path: '/workspace/alice/.dsh', hidden: true },
      { name: 'workspaces', path: '/workspace/alice/workspaces', hidden: false },
      { name: 'bob', path: '/workspace/bob', hidden: false },
    ],
    truncated: false,
  }
  const filtered = filterListing(policy, listing)
  assert.deepEqual(filtered.entries.map(entry => entry.name), ['workspaces'])
  assert.equal(filtered.home, policy.home)
  assert.deepEqual(filtered.crumbs.map(entry => entry.path), ['/workspace/alice'])
})

test('browse wrapper clamps listing and rejects creation outside allowed roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-picker-policy-'))
  try {
    const alice = join(root, 'alice')
    const bob = join(root, 'bob')
    const workspaces = join(alice, 'workspaces')
    await mkdir(workspaces, { recursive: true })
    await mkdir(bob)
    await symlink(bob, join(alice, 'escape'))
    const policy = {
      root: alice,
      home: workspaces,
      allowedCreateRoots: [workspaces],
      hidden: new Set(),
    }
    const inner = {
      kind: 'browse',
      async list(path) {
        return {
          path,
          home: '/',
          crumbs: [{ name: '/', path: '/', hidden: false }],
          entries: [{ name: 'any', path: join(path, 'any'), hidden: false }],
          truncated: false,
        }
      },
      async createDirectory(path, name) {
        return join(path, name)
      },
    }
    const wrapped = wrapBrowseCapability(inner, policy, DirectoryPickerError)
    const listing = await wrapped.list(bob)
    assert.equal(listing.path, workspaces)
    await assert.rejects(wrapped.createDirectory(bob, 'new'), /restricted/)
    await assert.rejects(wrapped.createDirectory(join(alice, 'escape'), 'new'), /restricted/)
    assert.equal(await wrapped.createDirectory(workspaces, 'new'), join(workspaces, 'new'))
    assert.equal(isPathWithin(alice, join(alice, 'workspaces')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
