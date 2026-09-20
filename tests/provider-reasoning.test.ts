import { describe, expect, it } from "bun:test"
import { buildAnthropicProviderConfig, buildProviderConfig } from "../src/provider"

describe("buildProviderConfig", () => {
  it("enables reasoning when the exact DeepSeek v4.1 Flash model is present", () => {
    const models = [{ id: "deepseek/deepseek-v4.1-flash" }]

    const provider = buildProviderConfig(models)

    expect(provider.models["deepseek/deepseek-v4.1-flash"]).toMatchObject({ reasoning: true })
  })

  it("exposes max wire effort when the exact DeepSeek v4.1 Flash model is present", () => {
    const models = [{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash", context_length: 1_000_000 }]

    const provider = buildProviderConfig(models)

    expect(provider.models["deepseek/deepseek-v4.1-flash"]).toEqual({
      name: "DeepSeek v4.1 Flash",
      limit: { context: 1_000_000, output: 64_000 },
      reasoning: true,
      variants: { max: { reasoningEffort: "max" } },
      attachment: false,
      tool_call: true,
      temperature: true,
    })
  })

  it.each([
    { id: "deepseek/deepseek-v4-flash", reasoning: false, attachment: false },
    { id: "deepseek/deepseek-v4.1", reasoning: false, attachment: false },
    { id: "deepseek/deepseek-v4.1-flash-preview", reasoning: false, attachment: false },
    { id: "deepseek/deepseek-r1", reasoning: true, attachment: false },
    { id: "gpt-5.6-sol", reasoning: true, attachment: true },
    { id: "google/gemini-3.5-flash", reasoning: false, attachment: true },
  ])("preserves unrelated metadata when $id is present", ({ id, reasoning, attachment }) => {
    const models = [{ id: "deepseek/deepseek-v4.1-flash" }, { id }]

    const provider = buildProviderConfig(models)

    expect(provider.models[id]).toEqual({
      name: id,
      limit: { context: 200_000, output: 64_000 },
      reasoning,
      attachment,
      tool_call: true,
      temperature: true,
    })
  })

  it("keeps Claude out of the compatible provider when both model families are present", () => {
    const models = [{ id: "deepseek/deepseek-v4.1-flash" }, { id: "claude-sonnet-5" }]

    const provider = buildProviderConfig(models)

    expect(Object.keys(provider.models)).toEqual(["deepseek/deepseek-v4.1-flash"])
  })

  it("preserves provider connection and credential fields when the target model is added", () => {
    const models = [{ id: "deepseek/deepseek-v4.1-flash" }]

    const { models: builtModels, ...connection } = buildProviderConfig(models)

    expect(connection).toEqual({
      name: "CommandCode",
      api: "https://api.commandcode.ai/provider/v1",
      npm: "@ai-sdk/openai-compatible",
      env: ["COMMANDCODE_API_KEY"],
    })
  })
})

describe("buildAnthropicProviderConfig", () => {
  it("preserves the separate Claude provider when the target DeepSeek model is present", () => {
    const models = [{ id: "deepseek/deepseek-v4.1-flash" }, { id: "claude-sonnet-5" }]

    const provider = buildAnthropicProviderConfig(models)

    expect(provider).toEqual({
      name: "CommandCode (Claude)",
      api: "https://api.commandcode.ai/provider/v1",
      npm: "@ai-sdk/anthropic",
      env: ["COMMANDCODE_API_KEY"],
      models: {
        "claude-sonnet-5": {
          name: "claude-sonnet-5",
          limit: { context: 200_000, output: 64_000 },
          reasoning: true,
          attachment: true,
          tool_call: true,
          temperature: true,
        },
      },
    })
  })
})
