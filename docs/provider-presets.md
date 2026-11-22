# Preconfigured model providers at build time

This image can bake a generic provider preset into the container. A preset declares one or more OpenAI-compatible, Anthropic, or Gemini routes, their models, and an optional default model. After the image starts, the providers are already available in the Models page and model picker; no provider setup in the UI is required.

The preset format is generic. Ollama Cloud is an example, not a hardcoded provider.

> **Secrets:** a provider preset contains no API-key values. Use `apiKeyEnv` and provide the key through the environment, or save it once from the Models page. Do not bake secrets into the image.

## Why a preset is needed

DSH's `@deepseek-ai/dsh-llm-pi-ai` adapter can serve custom routes, but a custom route needs `api`, `baseURL`, and a non-empty `models` list in Cordis configuration. DSH can interrogate an OpenAI-compatible `GET {baseURL}/models` endpoint from the Models page, but that discovery returns candidates; it does not persist or register a provider by itself.

The image therefore:

1. bakes a provider preset into `/opt/deepseek-harness/providers.json`;
2. runs a small generic generator before the Web process starts;
3. optionally discovers models from each endpoint;
4. writes a Cordis patch and passes it to `dsh web`.

## Quick start

```bash
cp providers/example.json providers/my-providers.json
# edit providers/my-providers.json
make build PROVIDERS_CONFIG=providers/my-providers.json
```

With Compose's build path:

```bash
PROVIDERS_CONFIG=providers/my-providers.json docker compose build --pull
docker compose up -d
```

Or directly:

```bash
docker build \
  --build-arg PROVIDERS_CONFIG=providers/my-providers.json \
  -t runzhliu/deepseek-harness:0.2.3-alpha.2-r1 .
```

The default build uses `providers/empty.json`. It keeps the existing DeepSeek-only behavior and makes no extra network calls.

## File format

```json
{
  "version": 1,
  "providers": {
    "ollama-cloud": {
      "displayName": "Ollama Cloud",
      "api": "openai-completions",
      "baseURL": "https://ollama.com/v1",
      "apiKeyEnv": "OLLAMA_API_KEY",
      "discover": true,
      "models": []
    },
    "my-gateway": {
      "displayName": "My Gateway",
      "api": "openai-completions",
      "baseURL": "https://gateway.example/v1",
      "apiKeyEnv": "MY_GATEWAY_API_KEY",
      "discover": false,
      "models": [
        {
          "id": "model-a",
          "name": "Model A",
          "contextWindow": 131072,
          "maxTokens": 32768
        }
      ]
    }
  },
  "defaultModel": {
    "provider": "ollama-cloud",
    "model": "gpt-oss:20b"
  }
}
```

### Provider fields

| Field | Required | Meaning |
| --- | --- | --- |
| provider key | yes | Route id matching `^[a-z][a-z0-9-]{0,63}$` |
| `displayName` | no | Label in the UI; defaults to the route id |
| `api` | yes | `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai` |
| `baseURL` | yes | Absolute HTTP(S) endpoint, without query or fragment |
| `apiKeyEnv` | no | Environment variable name resolved by DSH; never a key value |
| `discover` | no | Ask the endpoint for its model list at Web startup |
| `models` | conditional | Static models; required when `discover` is false and the provider is enabled |
| `enabled` | no | Set `false` to keep an entry in the file without configuring it |
| `headers` | no | Additional deployment headers; never put secrets here |
| other DSH profile fields | no | Passed through to `llm-pi-ai`, for example `defaultContextWindow`, `defaultMaxTokens`, `compat` |

An `apiKey` or `apiKeyValue` field is rejected at build time. The generator will not write a secret into the patch.

### Model fields

Static models accept:

- `id` (required, safe model id);
- `name`;
- `contextWindow`;
- `maxTokens`;
- `input` (`text` / `image`);
- `reasoningEfforts`;
- `compat`.

Discovered models fill `id`, display name, context window, output cap, and input modalities when the endpoint reports them. Static entries win on a per-field basis, so they can correct missing or wrong metadata.

### Default model

`defaultModel` is optional. It is applied only when the provider exists and the model appears in the final list (discovered plus static). If it does not, the generator logs a warning, omits the default override, and keeps DSH's existing default.

This lets a deployment switch the initial agent model to a preconfigured provider while remaining safe when a provider changes its model list.

## Model discovery

When `discover: true`, the generator uses the protocol's native listing endpoint:

| `api` | Request | Authentication |
| --- | --- | --- |
| `openai-completions` | `GET {baseURL}/models` | `Authorization: Bearer <apiKeyEnv>` |
| `openai-responses` | `GET {baseURL}/models` | `Authorization: Bearer <apiKeyEnv>` |
| `anthropic-messages` | `GET {baseURL}/v1/models?limit=1000` | `x-api-key`, `anthropic-version` |
| `google-generative-ai` | `GET {baseURL}/models?pageSize=1000` | `x-goog-api-key` |

Discovery uses the key from `apiKeyEnv` in the process environment. A key saved only in the DSH Models page is not visible to this pre-start generator; for a keyed endpoint, provide the key through the environment at startup or use a static model list.

If discovery fails:

- a non-empty static `models` list is still used;
- a provider with no models is skipped with a warning;
- the Web process still starts.

Model discovery runs when the Web process starts, not continuously. Restart the container to refresh a dynamic list.

## Ollama Cloud example

Ollama Cloud's OpenAI-compatible endpoint is `https://ollama.com/v1`; its API key is created in Ollama's settings and is normally passed as `OLLAMA_API_KEY`. The preset in `providers/example.json` uses `OLLAMA_API_KEY` as the environment reference and `discover: true`.

```bash
cp providers/example.json providers/ollama-cloud.json
# Optional: set defaultModel to a model you want selected initially.
make build PROVIDERS_CONFIG=providers/ollama-cloud.json
docker run ... -e OLLAMA_API_KEY=... <image>
```

The model list is read from `GET https://ollama.com/v1/models`. If you need deterministic startup with no network, set `discover: false` and list the model ids you use.

See [Ollama's OpenAI compatibility documentation](https://docs.ollama.com/api/openai-compatibility).

## API keys and zero-setup

- For a keyless endpoint, the baked preset and default model are enough; opening the app needs no provider setup.
- For a keyed endpoint, set the environment variable named by `apiKeyEnv` at container start. Compose reads the optional `providers.env` file (see `providers.env.example`) and passes every variable in it to the container; set `DSH_PROVIDERS_ENV_FILE` to use another filename. With plain Docker, use `-e NAME=value` or an env file. This is the only runtime value required; endpoint, providers, models, and default model are in the image.
- Alternatively, leave `apiKeyEnv` configured and save the key from Models. Discovery at the next restart will not see that saved key, so use static models or an environment key for startup discovery.
- Do not put a key in `providers.json` or in a Docker layer.

## Runtime override

The baked preset is the default. To use a different file without rebuilding:

```bash
docker run ... \
  -v "$PWD/providers/my-providers.json:/etc/dsh/providers.json:ro" \
  -e DSH_PROVIDERS_CONFIG=/etc/dsh/providers.json \
  <image>
```

`DSH_PROVIDERS_CONFIG` defaults to `/opt/deepseek-harness/providers.json`.

## Multiuser deployment

The multiuser supervisor runs the same generator once and passes the generated patch to every per-user DSH process. Endpoint, providers, and models are shared; an environment API key is shared, while keys saved in each user's Models page remain per-user. Use `DSH_PROVIDERS_CONFIG` to mount an override in `compose.multiuser.yaml`.

## Security and limits

- The preset config is not a secret store. `apiKey` values are rejected.
- `headers` is passed through; never put credentials there. Use `apiKeyEnv`.
- The generator uses the environment API key for startup discovery; it does not read the DSH credential store.
- The generated patch is a command-line overlay. The model list is deployment-managed; refresh by restarting (or use a static list). API-key editing in Models remains available.
- Enabling discovery makes the container contact the configured endpoints at Web startup.
- Provider availability still depends on the upstream endpoint; a configured model can fail at inference time.
- The preset is trusted deployment configuration; a malformed file fails build validation.

## Validation

```bash
node scripts/provider-preset.cjs --validate providers/empty.json
node scripts/provider-preset.cjs --validate providers/example.json
node --test scripts/provider-preset.test.cjs
make provider-check
```

The image also validates the baked `providers.json` during build and the smoke test validates both the default and example files.
