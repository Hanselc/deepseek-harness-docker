import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertCreateAllowed,
  canonicalPath,
  isDefaultWorkspace,
  isPathWithin,
  resolvePolicy,
  wrapWorkspace,
} from './policy.js'

test('isPathWithin accepts the root and descendants but not siblings', () => {
  assert.equal(isPathWithin('/srv/users/alice', '/srv/users/alice'), true)
  assert.equal(isPathWithin('/srv/users/alice', '/srv/users/alice/work'), true)
  assert.equal(isPathWithin('/srv/users/alice', '/srv/users/bob'), false)
  assert.equal(isPathWithin('/srv/users/alice', '/srv/users/alice-evil'), false)
})

test('restricted policy includes the default root and allows only configured roots', () => {
  const policy = resolvePolicy({
    DSH_WORKSPACE_POLICY: 'restricted',
    DSH_WORKSPACE_POLICY_DEFAULT: '/srv/users/alice/default',
    DSH_WORKSPACE_POLICY_ALLOWED_ROOTS: JSON.stringify(['/srv/users/alice/workspaces']),
  })
  assert.deepEqual(policy.allowedRoots, ['/srv/users/alice/workspaces', '/srv/users/alice/default'])
  assert.equal(isDefaultWorkspace(policy, '/srv/users/alice/default'), true)
  assert.equal(isDefaultWorkspace(policy, '/srv/users/alice/default/sub'), false)
  assert.doesNotThrow(() => assertCreateAllowed(policy, '/srv/users/alice/default/sub'))
  assert.doesNotThrow(() => assertCreateAllowed(policy, '/srv/users/alice/workspaces/child'))
  assert.throws(() => assertCreateAllowed(policy, '/srv/users/bob'), /restricted/)
})

test('symlink escapes are rejected after canonicalization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-policy-'))
  try {
    const allowed = join(root, 'allowed')
    const outside = join(root, 'outside')
    await mkdir(allowed)
    await mkdir(outside)
    const link = join(allowed, 'escape')
    await symlink(outside, link)
    const canonical = await canonicalPath(link)
    assert.equal(isPathWithin(allowed, canonical), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('default workspace wrapper locks setTitle but binds other methods', async () => {
  const calls = []
  const entity = {
    path: '/srv/users/alice/default',
    title: 'default-workspace',
    async setTitle(value) { calls.push(value) },
    async attachSession(id) { calls.push(id) },
  }
  const wrapped = wrapWorkspace(entity, { lockTitle: true })
  await assert.rejects(wrapped.setTitle('renamed'), /cannot be renamed/)
  await wrapped.attachSession('session-1')
  assert.deepEqual(calls, ['session-1'])
})
