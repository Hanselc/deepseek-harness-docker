'use strict'

const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const {
  generateProviderPatch,
  listingURL,
  loadConfig,
  mergeModels,
  parseListing,
  validateConfig,
} = require('./provider-preset.cjs')

const baseProvider = {
  api: 'openai-completions',
  baseURL: 'https://gateway.example/v1',
  apiKeyEnv: 'GATEWAY_API_KEY',
  models: [{ id: 'model-a', contextWindow: 131072, maxTokens: 32768 }],
}

test('validates empty and example provider configs', () => {
  assert.deepEqual(validateConfig({ version: 1, providers: {} }).providers, [])
  const example = loadConfig(join(__dirname, '..', 'providers', 'example.json'))
  assert.equal(example.providers.length, 2)
  assert.equal(example.providers[0].id, 'ollama-cloud')
  assert.equal(example.providers[0].discover, true)
  assert.equal(example.defaultModel.provider, 'ollama-cloud')
  assert.doesNotThrow(() => loadConfig(join(__dirname, '..', 'providers', 'smoke.json')))
})

test('rejects API key values, invalid fields, and model-less static providers', () => {
  assert.throws(() => validateConfig({
    version: 1,
    providers: { x: { ...baseProvider, apiKey: 'secret' } },
  }), /must not contain an API key value/)
  assert.throws(() => validateConfig({
    version: 1,
    providers: { x: { ...baseProvider, models: [{ id: 'model-a', unknown: true }] } },
  }), /not a supported model field/)
  assert.throws(() => validateConfig({
    version: 1,
    providers: { x: { ...baseProvider, models: [] } },
  }), /needs models or discover/)
  assert.throws(() => validateConfig({
    version: 1,
    providers: { x: { ...baseProvider, api: 'unsupported' } },
  }), /api must be one of/)
})

test('merges discovered models with static metadata and static-only models', () => {
  const merged = mergeModels(
    [{ id: 'model-a', name: 'Static A', contextWindow: 200000 }, { id: 'model-b' }],
    [{ id: 'model-a', contextWindow: 100000 }, { id: 'model-c', name: 'Discovered C' }],
  )
  assert.deepEqual(merged.map(model => model.id), ['model-a', 'model-c', 'model-b'])
  assert.equal(merged[0].name, 'Static A')
  assert.equal(merged[0].contextWindow, 200000)
})

test('builds listing URLs for OpenAI, Anthropic, and Gemini', () => {
  assert.equal(listingURL({ api: 'openai-completions', baseURL: 'https://gateway.example/v1' }).href, 'https://gateway.example/v1/models')
  assert.equal(listingURL({ api: 'anthropic-messages', baseURL: 'https://gateway.example/v1' }).href, 'https://gateway.example/v1/models?limit=1000')
  assert.equal(listingURL({ api: 'google-generative-ai', baseURL: 'https://gateway.example/v1beta' }).href, 'https://gateway.example/v1beta/models?pageSize=1000')
})

test('discovers OpenAI-compatible models with bearer auth and writes the patch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-provider-preset-'))
  try {
    const configPath = join(directory, 'providers.json')
    const outputPath = join(directory, 'patch.yml')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      providers: {
        gateway: {
          displayName: 'Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.example/v1',
          apiKeyEnv: 'GATEWAY_API_KEY',
          discover: true,
          models: [{ id: 'static-model', name: 'Static' }],
        },
      },
      defaultModel: { provider: 'gateway', model: 'remote-model' },
    }))
    const calls = []
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options })
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: [
              { id: 'remote-model', display_name: 'Remote Model', context_window: 65536, max_output_tokens: 8192 },
              { id: 'remote-model-2' },
            ],
          })
        },
      }
    }
    const logs = []
    const result = await generateProviderPatch({
      configPath,
      outputPath,
      env: { GATEWAY_API_KEY: 'test-key' },
      fetchImpl,
      logger: message => logs.push(message),
    })
    assert.equal(calls[0].url, 'https://gateway.example/v1/models')
    assert.equal(calls[0].options.headers.authorization, 'Bearer test-key')
    assert.deepEqual(Object.keys(result.providers), ['gateway'])
    assert.deepEqual(result.providers.gateway.models.map(model => model.id), ['remote-model', 'remote-model-2', 'static-model'])
    const patch = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(patch[0].id, 'llm-pi-ai')
    assert.equal(patch[1].id, 'agent-default-model')
    assert.equal(patch[1].config.model, 'remote-model')
    assert.equal(JSON.stringify(patch).includes('test-key'), false)
    assert.equal(logs.some(line => line.includes('test-key')), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('discovers Anthropic and Gemini listings with protocol-specific headers', async () => {
  const anthropicCalls = []
  const anthropic = await (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-provider-anthropic-'))
    try {
      const configPath = join(directory, 'providers.json')
      const outputPath = join(directory, 'patch.yml')
      await writeFile(configPath, JSON.stringify({
        version: 1,
        providers: {
          anthropic: {
            api: 'anthropic-messages',
            baseURL: 'https://anthropic.example/v1',
            apiKeyEnv: 'ANTHROPIC_KEY',
            discover: true,
          },
        },
      }))
      const result = await generateProviderPatch({
        configPath,
        outputPath,
        env: { ANTHROPIC_KEY: 'anthropic-key' },
        fetchImpl: async (url, options) => {
          anthropicCalls.push({ url: String(url), options })
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({ data: [{ id: 'claude-test', display_name: 'Claude Test', max_input_tokens: 200000, max_tokens: 8192 }] })
            },
          }
        },
        logger: () => {},
      })
      return result
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })()
  assert.equal(anthropicCalls[0].url, 'https://anthropic.example/v1/models?limit=1000')
  assert.equal(anthropicCalls[0].options.headers['x-api-key'], 'anthropic-key')
  assert.equal(anthropicCalls[0].options.headers['anthropic-version'], '2023-06-01')
  assert.equal(anthropic.providers.anthropic.models[0].contextWindow, 200000)

  const gemini = parseListing({
    models: [
      { name: 'models/gemini-test', displayName: 'Gemini Test', inputTokenLimit: 100000, outputTokenLimit: 4096, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding-test', supportedGenerationMethods: ['embedContent'] },
    ],
  }, 'google-generative-ai')
  assert.deepEqual(gemini.map(model => model.id), ['gemini-test'])
  assert.equal(gemini[0].contextWindow, 100000)
})

test('static models survive discovery failure, and a model-less provider is skipped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-provider-fallback-'))
  try {
    const configPath = join(directory, 'providers.json')
    const outputPath = join(directory, 'patch.yml')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      providers: {
        static: { ...baseProvider, discover: true, models: [{ id: 'static-model' }] },
        empty: { ...baseProvider, baseURL: 'https://empty.example/v1', discover: true, models: [] },
      },
    }))
    const logs = []
    const result = await generateProviderPatch({
      configPath,
      outputPath,
      env: {},
      fetchImpl: async () => {
        throw new Error('network unavailable')
      },
      logger: message => logs.push(message),
    })
    assert.deepEqual(Object.keys(result.providers), ['static'])
    assert.equal(result.providers.static.models[0].id, 'static-model')
    assert.equal(logs.some(line => line.includes('empty: skipped')), true)
    assert.equal(logs.some(line => line.includes('network unavailable')), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('no enabled providers removes a stale patch and does not write one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-provider-empty-'))
  try {
    const configPath = join(directory, 'providers.json')
    const outputPath = join(directory, 'patch.yml')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      providers: { disabled: { ...baseProvider, enabled: false } },
    }))
    await writeFile(outputPath, 'stale\n')
    const result = await generateProviderPatch({ configPath, outputPath, logger: () => {} })
    assert.equal(result.outputPath, undefined)
    await assert.rejects(readFile(outputPath, 'utf8'), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an unavailable default model is omitted with a warning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-provider-default-'))
  try {
    const configPath = join(directory, 'providers.json')
    const outputPath = join(directory, 'patch.yml')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      providers: { gateway: baseProvider },
      defaultModel: { provider: 'gateway', model: 'missing-model' },
    }))
    const logs = []
    const result = await generateProviderPatch({ configPath, outputPath, logger: message => logs.push(message) })
    const patch = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(patch.length, 1)
    assert.equal(patch[0].id, 'llm-pi-ai')
    assert.equal(logs.some(line => line.includes('defaultModel gateway/missing-model')), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
