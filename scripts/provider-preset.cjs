'use strict'

/**
 * Generic build-time provider presets for DeepSeek Harness.
 *
 * Reads a JSON preset, optionally discovers models from OpenAI-compatible,
 * Anthropic, or Gemini endpoints, and emits a Cordis patch that declares the
 * providers through @deepseek-ai/dsh-llm-pi-ai. No provider-specific code and
 * no secrets: every API key stays an environment reference.
 */

const fs = require('node:fs')
const path = require('node:path')

const ALLOWED_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
])
const MODEL_FIELDS = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'])
const INTERNAL_PROVIDER_FIELDS = new Set(['discover', 'enabled', 'apiKey', 'apiKeyValue'])
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function positiveInteger(value, field) {
  if (value === undefined) return undefined
  assert(Number.isInteger(value) && value > 0, `${field} must be a positive integer`)
  return value
}

function modelId(value, field) {
  assert(typeof value === 'string', `${field} must be a string`)
  const id = value.trim()
  assert(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id), `${field} is not a safe model id: ${JSON.stringify(value)}`)
  return id
}

function normalizeInput(value, field) {
  if (value === undefined) return undefined
  assert(Array.isArray(value), `${field} must be an array`)
  const input = value.filter(item => item === 'text' || item === 'image')
  assert(input.length === value.length, `${field} entries must be "text" or "image"`)
  return [...new Set(input)]
}

function normalizeStaticModel(raw, field) {
  if (typeof raw === 'string') return { id: modelId(raw, field) }
  assert(isObject(raw), `${field} must be a model id or object`)
  const model = { ...raw, id: modelId(raw.id, `${field}.id`) }
  if (model.name !== undefined) assert(typeof model.name === 'string' && model.name !== '', `${field}.name must be a non-empty string`)
  if (model.displayName !== undefined) {
    assert(typeof model.displayName === 'string' && model.displayName !== '', `${field}.displayName must be a non-empty string`)
    model.name ??= model.displayName
    delete model.displayName
  }
  for (const key of Object.keys(model)) {
    if (!MODEL_FIELDS.has(key)) throw new Error(`${field}.${key} is not a supported model field`)
  }
  positiveInteger(model.contextWindow, `${field}.contextWindow`)
  positiveInteger(model.maxTokens, `${field}.maxTokens`)
  if (model.input !== undefined) model.input = normalizeInput(model.input, `${field}.input`)
  if (model.reasoningEfforts !== undefined) assert(isObject(model.reasoningEfforts), `${field}.reasoningEfforts must be an object`)
  if (model.compat !== undefined) assert(isObject(model.compat), `${field}.compat must be an object`)
  return model
}

function validateHeaders(raw, field) {
  if (raw === undefined) return undefined
  assert(isObject(raw), `${field} must be an object`)
  for (const [name, value] of Object.entries(raw)) {
    assert(/^[A-Za-z0-9-]+$/.test(name), `${field} contains an invalid header name`)
    assert(typeof value === 'string' && !/[\r\n]/.test(value), `${field}.${name} must be a single-line string`)
  }
  return { ...raw }
}

function normalizeBaseURL(value, field) {
  assert(typeof value === 'string' && value !== '', `${field} is required`)
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${field} must be an absolute HTTP or HTTPS URL`)
  }
  assert(url.protocol === 'http:' || url.protocol === 'https:', `${field} must use http or https`)
  assert(url.username === '' && url.password === '', `${field} must not embed credentials`)
  assert(url.hash === '', `${field} must not contain a fragment`)
  assert(url.search === '', `${field} must not contain a query`)
  return url
}

function validateProvider(id, raw) {
  assert(/^[a-z][a-z0-9-]{0,63}$/.test(id), `provider id must match ^[a-z][a-z0-9-]{0,63}$: ${JSON.stringify(id)}`)
  assert(isObject(raw), `providers.${id} must be an object`)
  assert(raw.apiKey === undefined && raw.apiKeyValue === undefined,
    `providers.${id} must not contain an API key value; use apiKeyEnv`)
  const enabled = raw.enabled !== false
  const discover = raw.discover === true
  if (raw.discover !== undefined) assert(typeof raw.discover === 'boolean', `providers.${id}.discover must be boolean`)
  assert(ALLOWED_APIS.has(raw.api), `providers.${id}.api must be one of ${[...ALLOWED_APIS].join(', ')}`)
  const baseURL = normalizeBaseURL(raw.baseURL, `providers.${id}.baseURL`)
  let apiKeyEnv
  if (raw.apiKeyEnv !== undefined) {
    assert(typeof raw.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.apiKeyEnv),
      `providers.${id}.apiKeyEnv must be an environment variable name`)
    apiKeyEnv = raw.apiKeyEnv
  }
  const headers = validateHeaders(raw.headers, `providers.${id}.headers`)
  assert(raw.models === undefined || Array.isArray(raw.models), `providers.${id}.models must be an array`)
  const models = (raw.models ?? []).map((model, index) => normalizeStaticModel(model, `providers.${id}.models[${index}]`))
  if (enabled && !discover) {
    assert(models.length > 0, `providers.${id} needs models or discover: true`)
  }

  const profile = {}
  for (const [key, value] of Object.entries(raw)) {
    if (INTERNAL_PROVIDER_FIELDS.has(key) || key === 'models' || key === 'headers') continue
    profile[key] = value
  }
  profile.displayName = raw.displayName ?? id
  assert(typeof profile.displayName === 'string' && profile.displayName !== '', `providers.${id}.displayName must be a non-empty string`)
  profile.api = raw.api
  profile.baseURL = baseURL.href.replace(/\/$/, '')
  profile.models = models
  if (apiKeyEnv !== undefined) profile.apiKeyEnv = apiKeyEnv
  if (headers !== undefined) profile.headers = headers

  return { id, enabled, discover, api: raw.api, baseURL: baseURL.href.replace(/\/$/, ''), apiKeyEnv, models, profile }
}

function validateConfig(data) {
  assert(isObject(data), 'providers config must be a JSON object')
  assert(data.version === 1, 'providers config version must be 1')
  assert(isObject(data.providers), 'providers config must contain a providers object')
  const providers = Object.entries(data.providers).map(([id, provider]) => validateProvider(id, provider))
  let defaultModel
  if (data.defaultModel !== undefined) {
    assert(isObject(data.defaultModel), 'defaultModel must be an object')
    assert(typeof data.defaultModel.provider === 'string' && data.defaultModel.provider !== '', 'defaultModel.provider is required')
    assert(typeof data.defaultModel.model === 'string' && data.defaultModel.model !== '', 'defaultModel.model is required')
    defaultModel = { provider: data.defaultModel.provider, model: data.defaultModel.model.trim() }
  }
  return { version: 1, providers, defaultModel }
}

function loadConfig(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read providers config ${file}: ${error.message}`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON in providers config ${file}: ${error.message}`)
  }
  return validateConfig(data)
}

function listingURL(provider) {
  const url = new URL(provider.baseURL)
  if (provider.api === 'anthropic-messages') {
    let pathname = url.pathname.replace(/\/+$/, '')
    if (pathname.endsWith('/v1')) pathname = pathname.slice(0, -3)
    url.pathname = `${pathname}/v1/models`
    url.search = new URLSearchParams({ limit: '1000' }).toString()
    return url
  }
  const suffix = provider.api === 'google-generative-ai' ? 'models' : 'models'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix}`
  if (provider.api === 'google-generative-ai') {
    url.search = new URLSearchParams({ pageSize: '1000' }).toString()
  }
  return url
}

function discoveryHeaders(provider, env) {
  const headers = { ...(provider.profile.headers ?? {}), accept: 'application/json' }
  const key = provider.apiKeyEnv === undefined ? undefined : env[provider.apiKeyEnv]
  if (typeof key === 'string' && key !== '') {
    if (provider.api === 'anthropic-messages') {
      headers['x-api-key'] = key
    } else if (provider.api === 'google-generative-ai') {
      headers['x-goog-api-key'] = key
    } else if (!Object.keys(headers).some(name => name.toLowerCase() === 'authorization')) {
      headers.authorization = `Bearer ${key}`
    }
  }
  if (provider.api === 'anthropic-messages') headers['anthropic-version'] = ANTHROPIC_VERSION
  return headers
}

async function requestJSON(url, headers, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0, 'timeout must be a positive integer')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  assert(typeof fetchImpl === 'function', 'fetch is not available')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response
    try {
      response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${url} timed out after ${timeoutMs}ms`)
      throw new Error(`could not reach ${url}: ${error.message}`)
    }
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
    const text = await response.text()
    assert(text.length <= MAX_RESPONSE_BYTES, `${url} returned an oversized response`)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${url} did not return JSON`)
    }
  } finally {
    clearTimeout(timer)
  }
}

function discoveredModel(raw, api, fallbackId) {
  if (!isObject(raw)) return undefined
  const rawId = raw.id ?? (api === 'google-generative-ai' ? raw.name : undefined) ?? fallbackId
  if (typeof rawId !== 'string' || rawId.trim() === '') return undefined
  let id = rawId.trim()
  if (api === 'google-generative-ai' && id.startsWith('models/')) id = id.slice('models/'.length)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id)) return undefined
  const model = { id }
  const name = raw.displayName ?? raw.display_name ?? raw.name
  if (typeof name === 'string' && name !== '' && name !== id) model.name = name
  const contextWindow = raw.contextWindow ?? raw.context_window ?? raw.max_input_tokens ?? raw.inputTokenLimit
  if (Number.isInteger(contextWindow) && contextWindow > 0) model.contextWindow = contextWindow
  const maxTokens = raw.maxTokens ?? raw.max_tokens ?? raw.max_output_tokens ?? raw.outputTokenLimit
  if (Number.isInteger(maxTokens) && maxTokens > 0) model.maxTokens = maxTokens
  const input = raw.input ?? raw.inputModalities
  if (Array.isArray(input)) {
    const normalized = input.filter(item => item === 'text' || item === 'image')
    if (normalized.length > 0) model.input = [...new Set(normalized)]
  }
  return model
}

function parseListing(body, api) {
  assert(isObject(body), 'model discovery response must be a JSON object')
  if (api === 'google-generative-ai') {
    assert(Array.isArray(body.models), 'Gemini model discovery response must contain models')
    return body.models
      .filter(entry => isObject(entry) && Array.isArray(entry.supportedGenerationMethods)
        && entry.supportedGenerationMethods.includes('generateContent'))
      .map(entry => discoveredModel(entry, api))
      .filter(Boolean)
  }
  let entries
  if (Array.isArray(body.data)) entries = body.data
  else if (isObject(body.models)) entries = Object.entries(body.models).filter(([, entry]) => isObject(entry)).map(([id, entry]) => ({ ...entry, id }))
  else throw new Error('model discovery response must contain a data array or models map')
  return entries.map(entry => discoveredModel(entry, api)).filter(Boolean)
}

async function discoverProvider(provider, options = {}) {
  if (!provider.discover) return []
  const url = listingURL(provider)
  const headers = discoveryHeaders(provider, options.env ?? process.env)
  const body = await requestJSON(url, headers, options)
  return parseListing(body, provider.api)
}

function mergeModels(staticModels, discovered) {
  const merged = new Map()
  for (const model of discovered) merged.set(model.id, model)
  for (const model of staticModels) {
    const previous = merged.get(model.id)
    merged.set(model.id, previous === undefined ? model : { ...previous, ...model, id: model.id })
  }
  return [...merged.values()]
}

async function generateProviderPatch(options) {
  const config = loadConfig(options.configPath)
  const env = options.env ?? process.env
  const logger = options.logger ?? (message => console.error(`[provider-preset] ${message}`))
  const providers = {}
  const warnings = []

  for (const provider of config.providers) {
    if (!provider.enabled) continue
    let discovered = []
    if (provider.discover) {
      try {
        discovered = await discoverProvider(provider, { env, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })
        logger(`${provider.id}: discovered ${discovered.length} model(s)`)
      } catch (error) {
        warnings.push(`${provider.id}: model discovery failed: ${error.message}`)
        logger(`${provider.id}: model discovery failed: ${error.message}`)
      }
    }
    const models = mergeModels(provider.models, discovered)
    if (models.length === 0) {
      warnings.push(`${provider.id}: skipped because no models were discovered or declared`)
      logger(`${provider.id}: skipped because no models were discovered or declared`)
      continue
    }
    providers[provider.id] = { ...provider.profile, models }
  }

  if (Object.keys(providers).length === 0) {
    fs.rmSync(options.outputPath, { force: true })
    return { outputPath: undefined, providers: {}, warnings }
  }

  const patch = [{ id: 'llm-pi-ai', config: { providers } }]
  if (config.defaultModel !== undefined) {
    const target = config.defaultModel
    const provider = providers[target.provider]
    if (provider !== undefined && provider.models.some(model => model.id === target.model)) {
      patch.push({ id: 'agent-default-model', config: { provider: target.provider, model: target.model } })
    } else {
      const warning = `defaultModel ${target.provider}/${target.model} is not in the resolved model list; keeping the existing default`
      warnings.push(warning)
      logger(warning)
    }
  }

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true })
  fs.writeFileSync(options.outputPath, `${JSON.stringify(patch, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(options.outputPath, 0o600)
  logger(`wrote ${Object.keys(providers).length} provider(s) to ${options.outputPath}`)
  return { outputPath: options.outputPath, providers, warnings }
}

function parseArgs(argv) {
  let configPath = process.env.DSH_PROVIDERS_CONFIG || '/opt/deepseek-harness/providers.json'
  let outputPath = process.env.DSH_PROVIDERS_PATCH || '/tmp/dsh-providers.cordis.patch.yml'
  let validate = false
  let quiet = false
  let timeoutMs
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--validate') {
      validate = true
      if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) configPath = argv[++index]
    } else if (arg === '--config') {
      if (argv[index + 1] === undefined) throw new Error('--config requires a path')
      configPath = argv[++index]
    } else if (arg === '--output') {
      if (argv[index + 1] === undefined) throw new Error('--output requires a path')
      outputPath = argv[++index]
    } else if (arg === '--timeout-ms') {
      if (argv[index + 1] === undefined) throw new Error('--timeout-ms requires a value')
      timeoutMs = Number(argv[++index])
    } else if (arg === '--quiet') {
      quiet = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return { configPath, outputPath, validate, quiet, timeoutMs }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.validate) {
    loadConfig(args.configPath)
    if (!args.quiet) console.log(`providers config is valid: ${args.configPath}`)
    return
  }
  const result = await generateProviderPatch({
    configPath: args.configPath,
    outputPath: args.outputPath,
    timeoutMs: args.timeoutMs,
    logger: args.quiet ? () => {} : undefined,
  })
  if (result.outputPath === undefined && !args.quiet && result.warnings.length > 0) {
    console.error('[provider-preset] no enabled providers with resolvable models; no patch written')
  }
}

module.exports = {
  ALLOWED_APIS,
  DEFAULT_TIMEOUT_MS,
  discoverProvider,
  generateProviderPatch,
  listingURL,
  loadConfig,
  mergeModels,
  parseListing,
  validateConfig,
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[provider-preset] ${error.message}`)
    process.exitCode = 1
  })
}
