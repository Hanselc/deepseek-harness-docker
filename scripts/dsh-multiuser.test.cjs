'use strict'

const assert = require('node:assert/strict')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const {
  hasToken,
  hostAllowed,
  publicConfig,
  rewriteRequestCookies,
  rewriteSetCookies,
  withToken,
} = require('./dsh-multiuser-gateway.cjs')
const {
  parseTokenLine,
  readConfig,
  sanitizeLogLine,
  validateConfig,
} = require('./dsh-multiuser-supervisor.cjs')

test('public config builds host checks for default and explicit ports', () => {
  const httpsConfig = publicConfig({ DSH_MULTIUSER_PUBLIC_HOST: 'chat.codeorbita.com' })
  assert.equal(httpsConfig.url, 'https://chat.codeorbita.com/')
  assert.equal(hostAllowed('chat.codeorbita.com', httpsConfig), true)
  assert.equal(hostAllowed('chat.codeorbita.com:443', httpsConfig), true)
  assert.equal(hostAllowed('chat.codeorbita.com:8443', httpsConfig), false)
  assert.equal(hostAllowed('evil.example', httpsConfig), false)

  const portConfig = publicConfig({
    DSH_MULTIUSER_PUBLIC_HOST: 'chat.codeorbita.com',
    DSH_MULTIUSER_PUBLIC_PORT: '8443',
  })
  assert.equal(portConfig.url, 'https://chat.codeorbita.com:8443/')
  assert.equal(hostAllowed('chat.codeorbita.com:8443', portConfig), true)
  assert.equal(hostAllowed('chat.codeorbita.com:443', portConfig), false)
})

test('per-user cookie rewrite is reversible and drops other users', () => {
  const request = rewriteRequestCookies(
    'dsh-auth-abc=one; dsh-bob-auth-def=two; authelia_session=three; other=five',
    'alice',
  )
  assert.equal(request, 'dsh-auth-abc=one; authelia_session=three; other=five')

  const setCookies = rewriteSetCookies(
    ['dsh-auth-abc=one; Path=/; HttpOnly; SameSite=Strict'],
    'alice',
    true,
  )
  assert.equal(setCookies[0], 'dsh-alice-auth-abc=one; Path=/; HttpOnly; SameSite=Strict; Secure')
  assert.equal(rewriteSetCookies(['plain=value'], 'alice', true)[0], 'plain=value')
})

test('token injection preserves other query parameters and never duplicates', () => {
  const result = withToken('/?keep=1&token=old', 'new')
  assert.equal(result, '/?keep=1&token=new')
  assert.equal(hasToken(result), true)
  assert.equal(hasToken('/'), false)
})

test('token lines are parsed and redacted', () => {
  const line = 'dsh web: https://chat.codeorbita.com/?token=abc123'
  assert.equal(parseTokenLine(line), 'abc123')
  assert.equal(sanitizeLogLine(line), 'dsh web: https://chat.codeorbita.com/?token=REDACTED')
  assert.equal(parseTokenLine('ordinary log line'), undefined)
})

test('supervisor config accepts users and rejects duplicate identities/ports', () => {
  const env = { DSH_MULTIUSER_USERS_ROOT: '/workspace', DSH_MULTIUSER_WORKSPACE_PICKER: '1' }
  const valid = validateConfig({
    version: 1,
    defaults: { heapMb: 256 },
    users: [
      { name: 'alice', authUser: 'alice', internalPort: 3080 },
      { name: 'bob', authUser: 'bob', internalPort: 3081 },
    ],
  }, env)
  assert.deepEqual(valid.users.map(user => user.defaultWorkspace), [
    '/workspace/alice/documents/deepseek-harness/default-workspace',
    '/workspace/bob/documents/deepseek-harness/default-workspace',
  ])

  assert.throws(() => validateConfig({
    version: 1,
    users: [
      { name: 'alice', authUser: 'same', internalPort: 3080 },
      { name: 'bob', authUser: 'same', internalPort: 3081 },
    ],
  }, env), /duplicate authUser/)
  assert.throws(() => validateConfig({
    version: 1,
    users: [
      { name: 'alice', internalPort: 3080 },
      { name: 'bob', internalPort: 3080 },
    ],
  }, env), /duplicate internalPort/)
  assert.throws(() => validateConfig({ version: 1, users: [{ name: 'Alice' }] }, env), /must match/)
})

test('readConfig reports malformed JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-multiuser-config-'))
  try {
    const file = join(directory, 'users.json')
    await writeFile(file, '{"version":1,"users":[]}\n')
    assert.equal(readConfig(file).version, 1)
    await writeFile(file, '{\n')
    assert.throws(() => readConfig(file), /invalid JSON/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
