export const PROVIDER_ID = "commandcode"
export const PROVIDER_API = "https://api.commandcode.ai/provider/v1"
export const PROVIDER_NPM = "@ai-sdk/openai-compatible"
export const PROVIDER_NAME = "CommandCode"

export const ANTHROPIC_PROVIDER_ID = "commandcode-claude"
export const ANTHROPIC_NPM = "@ai-sdk/anthropic"
export const ANTHROPIC_NAME = "CommandCode (Claude)"

export interface ProviderModelsResponse {
  data?: { id: string; name?: string; context_length?: number }[]
}

/** Minimal fallback list used when the models endpoint is unreachable at startup. */
const FALLBACK_MODELS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "gpt-5.6-sol",
  "google/gemini-3.5-flash",
  "deepseek/deepseek-v4-flash",
  "moonshotai/Kimi-K3",
  "zai-org/GLM-5.3",
]

const REASONING_HINT = /(o1|o3|o4|gpt-5|sol|opus|sonnet|thinking|reason|r1)/i
const VISION_HINT = /(vision|gemini|gpt-5|opus|sonnet|kimi|glm|qwen)/i

export async function fetchModels(key?: string | null): Promise<{ id: string; name?: string; context_length?: number }[]> {
  const headers: Record<string, string> = {}
  if (key) headers.Authorization = `Bearer ${key}`
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${PROVIDER_API}/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      const data = (await res.json()) as ProviderModelsResponse
      const models = (data.data ?? []).filter((m) => m.id)
      if (models.length) return models
      throw new Error("empty model list")
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
  return FALLBACK_MODELS.map((id) => ({ id }))
}

export interface BuiltProvider {
  name: string
  api: string
  npm: string
  env: string[]
  models: Record<
    string,
    {
      name?: string
      limit?: { context?: number; output?: number }
      reasoning?: boolean
      attachment?: boolean
      tool_call?: boolean
      temperature?: boolean
    }
  >
}

function modelEntry(m: { id: string; name?: string; context_length?: number }) {
  return {
    name: m.name ?? m.id,
    limit: {
      context: m.context_length ?? 200_000,
      output: 64_000,
    },
    reasoning: REASONING_HINT.test(m.id),
    attachment: VISION_HINT.test(m.id),
    tool_call: true,
    temperature: true,
  }
}

export function isAnthropicModel(id: string): boolean {
  return id.startsWith("claude-")
}

export function buildProviderConfig(models: { id: string; name?: string; context_length?: number }[]): BuiltProvider {
  const out: BuiltProvider["models"] = {}
  for (const m of models) {
    if (isAnthropicModel(m.id)) continue
    out[m.id] = modelEntry(m)
  }
  return {
    name: PROVIDER_NAME,
    api: PROVIDER_API,
    npm: PROVIDER_NPM,
    env: ["COMMANDCODE_API_KEY"],
    models: out,
  }
}

export function buildAnthropicProviderConfig(
  models: { id: string; name?: string; context_length?: number }[],
): BuiltProvider {
  const out: BuiltProvider["models"] = {}
  for (const m of models) {
    if (!isAnthropicModel(m.id)) continue
    out[m.id] = modelEntry(m)
  }
  return {
    name: ANTHROPIC_NAME,
    api: PROVIDER_API,
    npm: ANTHROPIC_NPM,
    env: ["COMMANDCODE_API_KEY"],
    models: out,
  }
}

export async function readKey(): Promise<string | null> {
  const fromEnv = process.env.COMMANDCODE_API_KEY
  if (fromEnv) return fromEnv

  const home = process.env.HOME
  if (!home) return null
  try {
    const file = Bun.file(`${home}/.local/share/opencode/auth.json`)
    if (!(await file.exists())) return null
    const auth = (await file.json()) as Record<string, { key?: string }>
    return auth?.[PROVIDER_ID]?.key ?? null
  } catch {
    return null
  }
}