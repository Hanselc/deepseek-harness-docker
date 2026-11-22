'use strict'

/**
 * Multi-user supervisor for the one-container DSH deployment.
 *
 * One `dsh web` child runs per configured user, each with its own DSH_HOME,
 * workspaces, caches and loopback port. The gateway maps the Authelia
 * `Remote-User` header to the child and brokers its launch token. The container
 * remains a single process tree and a single image; no per-user container is
 * created.
 */

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { MultiUserGateway, gatewayConfigFromEnv, publicConfig, selectAddress } = require('./dsh-multiuser-gateway.cjs')
const { generateProviderPatch } = require('./provider-preset.cjs')

const DSH_BIN = '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const WORKSPACE_MODULE = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-workspace/lib/index.js'
const PICKER_MODULE = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-directory-picker/lib/index.js'
const DEFAULT_HIDDEN = ['.dsh', '.cache', '.config', '.local', '.npm', 'tmp']

function logger(message) {
  console.log(`[multiuser] ${message}`)
}

function sanitizeLogLine(line) {
  return String(line).replace(/([?&]token=)[^&\s]+/g, '$1REDACTED')
}

function parseTokenLine(line) {
  const match = /[?&]token=([^&\s]+)/.exec(String(line))
  if (match === null) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return undefined
  }
}

function moduleUrl(value, fallback) {
  const candidate = value === undefined || value === '' ? fallback : value
  if (typeof candidate !== 'string' || candidate === '') throw new Error('module URL is required')
  return candidate.startsWith('file:') ? candidate : pathToFileURL(candidate).href
}

function jsonArray(value, name) {
  if (value === undefined || value === '') return []
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`${name} must be a JSON array: ${error.message}`)
  }
  if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== 'string')) {
    throw new Error(`${name} must be a JSON array of strings`)
  }
  return parsed
}

function readConfig(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`)
  }
  return data
}

function validateConfig(data, env) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('config must be a JSON object')
  if (data.version !== 1) throw new Error('config.version must be 1')
  if (!Array.isArray(data.users) || data.users.length === 0) throw new Error('config.users must contain at least one user')

  const usersRoot = env.DSH_MULTIUSER_USERS_ROOT || '/workspace'
  if (!path.isAbsolute(usersRoot) || usersRoot === '/' || usersRoot === path.parse(usersRoot).root) {
    throw new Error('DSH_MULTIUSER_USERS_ROOT must be an absolute non-root directory')
  }
  const pickerEnabled = (env.DSH_MULTIUSER_WORKSPACE_PICKER ?? '1') !== '0'
  const policyMode = env.DSH_MULTIUSER_WORKSPACE_POLICY ?? 'restricted'
  if (policyMode !== 'restricted' && policyMode !== 'open') {
    throw new Error('DSH_MULTIUSER_WORKSPACE_POLICY must be restricted or open')
  }
  const lockDefault = (env.DSH_MULTIUSER_WORKSPACE_POLICY_LOCK_DEFAULT ?? '1') !== '0'
  const lockOrder = (env.DSH_MULTIUSER_WORKSPACE_POLICY_LOCK_ORDER ?? '1') !== '0'
  const hidden = env.DSH_MULTIUSER_PICKER_HIDDEN === undefined
    ? DEFAULT_HIDDEN
    : jsonArray(env.DSH_MULTIUSER_PICKER_HIDDEN, 'DSH_MULTIUSER_PICKER_HIDDEN')
  const defaultHeap = data.defaults?.heapMb ?? Number(env.DSH_MULTIUSER_HEAP_MB ?? 256)
  if (!Number.isInteger(defaultHeap) || defaultHeap < 128 || defaultHeap > 2048) {
    throw new Error('defaults.heapMb must be an integer between 128 and 2048')
  }

  const seenNames = new Set()
  const seenAuthUsers = new Set()
  const seenPorts = new Set()
  const users = data.users.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`users[${index}] must be an object`)
    const name = entry.name
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(name)) {
      throw new Error(`users[${index}].name must match ^[a-z][a-z0-9-]{0,30}$`)
    }
    if (seenNames.has(name)) throw new Error(`duplicate user name: ${name}`)
    seenNames.add(name)
    const authUser = entry.authUser ?? name
    if (typeof authUser !== 'string' || authUser.trim() === '' || authUser.includes(',')) {
      throw new Error(`users[${index}].authUser must be a non-empty value without commas`)
    }
    if (seenAuthUsers.has(authUser)) throw new Error(`duplicate authUser: ${authUser}`)
    seenAuthUsers.add(authUser)

    const internalPort = entry.internalPort ?? 3080 + index
    if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535 || internalPort === 8080 || internalPort === 8081) {
      throw new Error(`users[${index}].internalPort must be a valid non-gateway port`)
    }
    if (seenPorts.has(internalPort)) throw new Error(`duplicate internalPort: ${internalPort}`)
    seenPorts.add(internalPort)

    const heapMb = entry.heapMb ?? defaultHeap
    if (!Number.isInteger(heapMb) || heapMb < 128 || heapMb > 2048) {
      throw new Error(`users[${index}].heapMb must be an integer between 128 and 2048`)
    }
    const allowedGroups = entry.allowedGroups ?? []
    if (!Array.isArray(allowedGroups) || allowedGroups.some(group => typeof group !== 'string' || group === '')) {
      throw new Error(`users[${index}].allowedGroups must be an array of non-empty strings`)
    }

    const userRoot = path.join(usersRoot, name)
    const dshHome = path.join(userRoot, '.dsh')
    const workspaces = path.join(userRoot, 'workspaces')
    const documents = path.join(userRoot, 'documents')
    const defaultWorkspace = path.join(documents, 'deepseek-harness', 'default-workspace')
    return {
      name,
      authUser,
      internalPort,
      heapMb,
      allowedGroups,
      userRoot,
      dshHome,
      workspaces,
      documents,
      defaultWorkspace,
      tmp: path.join(userRoot, 'tmp'),
      cache: path.join(userRoot, '.cache'),
      config: path.join(userRoot, '.config'),
      data: path.join(userRoot, '.local', 'share'),
      npmCache: path.join(dshHome, 'npm-cache'),
      token: undefined,
      ready: false,
      error: undefined,
      attempts: 0,
      child: undefined,
      restartTimer: undefined,
      stopping: false,
      pickerEnabled,
      policyMode,
      lockDefault,
      lockOrder,
      hidden,
    }
  })
  return { users, usersRoot, pickerEnabled, policyMode, lockDefault, lockOrder, hidden }
}

function ensureDir(directory, mode = 0o700) {
  fs.mkdirSync(directory, { recursive: true, mode })
}

function prepareProfile(user, pluginRoot, pickerEnabled) {
  const scope = path.join(user.dshHome, 'profiles', 'web', 'node_modules', '@codeorbita')
  ensureDir(scope, 0o700)
  for (const name of ['dsh-workspace-policy', ...(pickerEnabled ? ['dsh-directory-picker-policy'] : [])]) {
    const source = path.join(pluginRoot, name)
    if (!fs.existsSync(path.join(source, 'package.json'))) {
      throw new Error(`multiuser plugin is missing: ${source}`)
    }
    const target = path.join(scope, name)
    try {
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink()) fs.unlinkSync(target)
      else throw new Error(`plugin target already exists and is not a symlink: ${target}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    fs.symlinkSync(source, target, 'dir')
  }
}

function prepareUser(user, env) {
  const usersRoot = env.DSH_MULTIUSER_USERS_ROOT || '/workspace'
  ensureDir(usersRoot, 0o755)
  for (const directory of [
    user.userRoot,
    user.dshHome,
    user.workspaces,
    user.documents,
    path.dirname(user.defaultWorkspace),
    user.defaultWorkspace,
    user.tmp,
    user.cache,
    user.config,
    user.data,
    user.npmCache,
  ]) {
    ensureDir(directory, directory === user.userRoot ? 0o750 : 0o700)
  }
  const pluginRoot = env.DSH_MULTIUSER_PLUGIN_ROOT || '/opt/deepseek-harness/plugins'
  prepareProfile(user, pluginRoot, user.pickerEnabled)
}

function childEnv(user, env, publicInfo) {
  const result = { ...env }
  for (const key of Object.keys(result)) {
    if (key === 'DSH_MULTIUSER_PROXY_SECRET') delete result[key]
  }
  const moduleUrls = {
    DSH_WORKSPACE_MODULE_URL: moduleUrl(env.DSH_WORKSPACE_MODULE_URL, WORKSPACE_MODULE),
    DSH_DIRECTORY_PICKER_MODULE_URL: moduleUrl(env.DSH_DIRECTORY_PICKER_MODULE_URL, PICKER_MODULE),
  }
  Object.assign(result, moduleUrls, {
    DSH_HOME: user.dshHome,
    HOME: user.workspaces,
    DSH_WORKSPACE_DOCUMENTS_DIR: user.documents,
    DSH_WORKSPACE_POLICY: user.policyMode,
    DSH_WORKSPACE_POLICY_DEFAULT: user.defaultWorkspace,
    DSH_WORKSPACE_POLICY_ALLOWED_ROOTS: JSON.stringify([user.defaultWorkspace, user.workspaces]),
    DSH_WORKSPACE_POLICY_LOCK_DEFAULT: user.lockDefault ? '1' : '0',
    DSH_WORKSPACE_POLICY_LOCK_ORDER: user.lockOrder ? '1' : '0',
    DSH_MULTIUSER_WORKSPACE_PICKER: user.pickerEnabled ? '1' : '0',
    DSH_PICKER_ROOT: user.userRoot,
    DSH_PICKER_HOME: user.workspaces,
    DSH_PICKER_ALLOWED_CREATE_ROOTS: JSON.stringify([user.defaultWorkspace, user.workspaces]),
    DSH_MULTIUSER_PICKER_HIDDEN: JSON.stringify(user.hidden),
    TMPDIR: user.tmp,
    NPM_CONFIG_CACHE: user.npmCache,
    XDG_CACHE_HOME: user.cache,
    XDG_CONFIG_HOME: user.config,
    XDG_DATA_HOME: user.data,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_DESKTOP_ENABLED: '0',
    DSH_BROWSER_USE_ENABLED: '0',
    NARB_DISABLE_NATIVE_CACHE: '1',
    DSH_MULTIUSER_PUBLIC_HOST: publicInfo.host,
  })
  return result
}

function childArgs(user, env, publicInfo, providerPatch) {
  const webPatch = env.DSH_MULTIUSER_WEB_PATCH || '/opt/deepseek-harness/web.cordis.patch.yml'
  const multiPatch = env.DSH_MULTIUSER_PATCH || '/opt/deepseek-harness/web.multiuser.cordis.patch.yml'
  return [
    '--expose-internals',
    `--max-old-space-size=${user.heapMb}`,
    DSH_BIN,
    'web',
    '--patch', webPatch,
    '--patch', multiPatch,
    ...(providerPatch === undefined ? [] : ['--patch', providerPatch]),
    '--no-open',
    '--port', String(user.internalPort),
    '--public-url', publicInfo.url,
    '--trusted-host', publicInfo.host,
  ]
}

class Supervisor {
  constructor(env = process.env) {
    this.env = env
    this.stopping = false
    this.children = new Set()
    this.gateway = undefined
    this.providerPatch = undefined
  }

  async start() {
    const configPath = this.env.DSH_MULTIUSER_CONFIG || '/etc/dsh-multiuser/users.json'
    const gatewayConfig = gatewayConfigFromEnv(this.env)
    const publicInfo = publicConfig(this.env)
    const data = readConfig(configPath)
    const config = validateConfig(data, this.env)
    this.users = config.users
    this.usersRoot = config.usersRoot
    this.publicInfo = publicInfo

    const providerConfig = this.env.DSH_PROVIDERS_CONFIG || '/opt/deepseek-harness/providers.json'
    if (fs.existsSync(providerConfig)) {
      try {
        const result = await generateProviderPatch({
          configPath: providerConfig,
          outputPath: '/tmp/dsh-providers.cordis.patch.yml',
          env: this.env,
          logger,
        })
        this.providerPatch = result.outputPath
      } catch (error) {
        logger(`provider preset failed: ${error.message}`)
      }
    }

    this.gateway = new MultiUserGateway({
      ...gatewayConfig,
      users: this.users,
      tokenFor: user => user.token,
      isReady: user => user.ready && user.token !== undefined,
      logger,
    })

    logger(`starting ${this.users.length} user process(es) for ${publicInfo.url}`)
    for (const user of this.users) {
      try {
        prepareUser(user, this.env)
        this.spawn(user)
      } catch (error) {
        user.error = error.message
        logger(`user ${user.name} is unavailable: ${error.message}`)
      }
    }
    await this.gateway.listen()
    process.once('SIGTERM', () => { void this.shutdown() })
    process.once('SIGINT', () => { void this.shutdown() })
  }

  spawn(user) {
    if (this.stopping) return
    clearTimeout(user.restartTimer)
    user.restartTimer = undefined
    user.ready = false
    user.token = undefined
    user.error = undefined
    const args = childArgs(user, this.env, this.publicInfo, this.providerPatch)
    const child = spawn(process.execPath, args, {
      cwd: user.workspaces,
      env: childEnv(user, this.env, this.publicInfo),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    user.child = child
    this.children.add(child)

    const consume = stream => {
      const lines = readline.createInterface({ input: stream })
      lines.on('line', line => {
        const clean = sanitizeLogLine(line)
        if (clean.trim() !== '') console.log(`[${user.name}] ${clean}`)
        const token = parseTokenLine(line)
        if (token !== undefined) {
          user.token = token
          user.ready = true
          user.attempts = 0
          logger(`${user.name} ready`)
        }
      })
    }
    consume(child.stdout)
    consume(child.stderr)

    child.once('error', error => {
      user.error = error.message
      user.ready = false
      user.token = undefined
      logger(`${user.name} failed to start: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      this.children.delete(child)
      if (user.child === child) user.child = undefined
      user.ready = false
      user.token = undefined
      if (this.stopping) return
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(user.attempts, 5))
      user.attempts += 1
      logger(`${user.name} exited (${code ?? signal ?? 'unknown'}); restarting in ${delay}ms`)
      user.restartTimer = setTimeout(() => this.spawn(user), delay)
    })
  }

  async shutdown(exitCode = 0) {
    if (this.stopping) {
      if (exitCode !== 0) process.exit(exitCode)
      return
    }
    this.stopping = true
    for (const user of this.users ?? []) {
      clearTimeout(user.restartTimer)
      user.stopping = true
    }
    if (this.gateway !== undefined) await this.gateway.close()
    for (const child of this.children) {
      try { child.kill('SIGTERM') } catch {}
    }
    const deadline = Date.now() + 20_000
    while (this.children.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    for (const child of this.children) {
      try { child.kill('SIGKILL') } catch {}
    }
    process.exit(exitCode)
  }
}

async function main() {
  const supervisor = new Supervisor(process.env)
  try {
    await supervisor.start()
  } catch (error) {
    console.error(`[multiuser] startup failed: ${error.message}`)
    await supervisor.shutdown(1)
  }
}

module.exports = {
  DEFAULT_HIDDEN,
  Supervisor,
  childArgs,
  childEnv,
  logger,
  moduleUrl,
  parseTokenLine,
  prepareProfile,
  prepareUser,
  readConfig,
  sanitizeLogLine,
  validateConfig,
}

if (require.main === module) main().catch(error => { console.error(`[multiuser] fatal: ${error.message}`); process.exitCode = 1 })
