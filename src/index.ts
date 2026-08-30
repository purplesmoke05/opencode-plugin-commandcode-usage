import type { Plugin } from "@opencode-ai/plugin"
import { HANDLED, createFooterCache, createMessageGuard, output, sendStatusMessage } from "./shared"
import { fetchFooterLine, fetchUsage, renderUsage, type UsageResult } from "./usage"
import { PROVIDER_ID, ANTHROPIC_PROVIDER_ID, buildAnthropicProviderConfig, buildProviderConfig, fetchModels, readKey, type BuiltProvider } from "./provider"

const OWN_COMMAND = "usage_commandcode"
const ALIASES = ["commandcode", "cmd", "cc"]
const PROVIDER_LABEL = "CommandCode"
const FOOTER_TAG = "⋯CommandCode"

const SHARED_HELP =
  "Usage quota commands: /usage ollama, /usage synthetic, /usage commandcode (or /usage_ollama, /usage_synthetic, /usage_commandcode)"

function matchesSharedUsage(command: string, args: string): boolean {
  if (command !== "usage") return false
  const first = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  return ALIASES.includes(first)
}

export const CommandcodeUsagePlugin: Plugin = async ({ client }) => {
  const footerCache = createFooterCache(fetchFooterLine)
  const { claim: claimMessage } = createMessageGuard()

  return {
    "experimental.text.complete": async (input, output) => {
      if (!claimMessage(input.messageID)) return
      if (output.text.includes(FOOTER_TAG)) return
      const line = await footerCache.get()
      if (!line) return
      output.text = `${output.text}\n\n${FOOTER_TAG}: ${line}`
    },

    config: async (input) => {
      const config = input as {
        command?: Record<string, { template: string; description: string }>
        provider?: Record<string, BuiltProvider | Record<string, unknown>>
      }
      config.command ??= {}
      config.command[OWN_COMMAND] = {
        template: `/${OWN_COMMAND}`,
        description: `Show ${PROVIDER_LABEL} usage and quotas`,
      }
      config.command["usage"] = {
        template: SHARED_HELP,
        description: "Show provider usage quotas (args: ollama | synthetic | commandcode)",
      }

      const models = await fetchModels(await readKey())
      config.provider ??= {}
      if (!config.provider[PROVIDER_ID]) {
        config.provider[PROVIDER_ID] = buildProviderConfig(models)
      }
      if (!config.provider[ANTHROPIC_PROVIDER_ID]) {
        config.provider[ANTHROPIC_PROVIDER_ID] = buildAnthropicProviderConfig(models)
      }
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "CommandCode (API Key)",
        },
      ],
    },

    "command.execute.before": async (input) => {
      const own = input.command === OWN_COMMAND
      const shared = matchesSharedUsage(input.command, input.arguments)
      if (!own && !shared) return

      let result: UsageResult
      try {
        result = await fetchUsage()
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }

      const text = output(renderUsage(result))
      await sendStatusMessage(client, input.sessionID, text)
      throw new Error(HANDLED)
    },
  }
}

export default CommandcodeUsagePlugin

export const CommandcodeClaudeAuthPlugin: Plugin = async () => {
  return {
    auth: {
      provider: ANTHROPIC_PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "CommandCode Claude (API Key)",
        },
      ],
    },
  }
}
