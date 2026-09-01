import { formatBar, formatResetSuffix } from "./shared"
import { readKey } from "./provider"

export interface UsageResult {
  ok: boolean
  error?: string
  credits?: {
    monthlyCredits?: number
    purchasedCredits?: number
    freeCredits?: number
    belowThreshold?: boolean
  }
  windowLimits?: {
    limited?: boolean
    fiveHour?: { used?: number; cap?: number; exceeded?: boolean; resetAt?: number }
    weekly?: { used?: number; cap?: number; exceeded?: boolean; resetAt?: number }
  }
  plan?: { planId?: string; status?: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean }
  proxy?: { healthy?: boolean; models?: number }
}

interface CreditsResponse {
  credits?: {
    belowThreshold?: boolean
    monthlyCredits?: number
    purchasedCredits?: number
    freeCredits?: number
  }
  windowLimits?: {
    limited?: boolean
    exceeded?: boolean | null
    fiveHour?: { used?: number; cap?: number; exceeded?: boolean; resetAt?: number }
    weekly?: { used?: number; cap?: number; exceeded?: boolean; resetAt?: number }
  }
}

interface SubscriptionsResponse {
  data?: { planId?: string; status?: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean }
}

const API_BASE = "https://api.commandcode.ai"
const PROXY_URL = process.env.COMMANDCODE_PROXY_URL ?? "http://127.0.0.1:1234"

async function apiGet<T>(path: string, key: string, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    let res: Response
    try {
      res = await fetch(`${API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${key}`,
          "x-command-code-version": "1.32.1",
        },
      })
    } catch (e) {
      lastError = new Error(
        `CommandCode ${path} connect failed (${API_BASE}${path}): ${e instanceof Error ? e.message : String(e)}`,
      )
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
      continue
    }
    if (!res.ok) throw new Error(`CommandCode ${path} failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as T
  }
  throw lastError
}

export async function fetchUsage(): Promise<UsageResult> {
  const key = await readKey()
  if (!key) throw new Error("COMMANDCODE_API_KEY is not set")

  const credits = await apiGet<CreditsResponse>("/alpha/billing/credits", key).catch((e) => {
    throw e
  })
  const subs = await apiGet<SubscriptionsResponse>("/alpha/billing/subscriptions", key).catch(() => null)

  const proxyHealth = await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false)
  const proxyModels = proxyHealth
    ? await fetch(`${PROXY_URL}/v1/models`, { signal: AbortSignal.timeout(2000) })
        .then((r) => (r.ok ? (r.json() as Promise<{ data?: { id: string }[] }>) : null))
        .then((j) => j?.data?.length ?? null)
        .catch(() => null)
    : null

  return {
    ok: true,
    credits: credits.credits,
    windowLimits: credits.windowLimits,
    plan: subs?.data
      ? {
          planId: subs.data.planId,
          status: subs.data.status,
          currentPeriodEnd: subs.data.currentPeriodEnd,
          cancelAtPeriodEnd: subs.data.cancelAtPeriodEnd,
        }
      : undefined,
    proxy: { healthy: proxyHealth, models: proxyModels ?? undefined },
  }
}

export function renderUsage(result: UsageResult): { stdout: string[]; stderr: string[] } {
  if (!result.ok) {
    return { stdout: ["→ [COMMANDCODE] - Failed To Fetch Usage"], stderr: [`Reason: ${result.error}`] }
  }

  const lines = ["→ [COMMANDCODE]"]

  if (result.plan?.planId) {
    const note = result.plan.cancelAtPeriodEnd ? " (Cancels At Period End)" : ""
    lines.push(`  ${"Plan:".padEnd(13)} ${result.plan.planId}${note}`)
  }

  const c = result.credits
  if (c) {
    const total = (c.monthlyCredits ?? 0) + (c.purchasedCredits ?? 0) + (c.freeCredits ?? 0)
    lines.push(`  ${"Credits:".padEnd(13)} $${total.toFixed(2)} (Monthly $${(c.monthlyCredits ?? 0).toFixed(2)}${c.purchasedCredits ? ` + Purchased $${c.purchasedCredits.toFixed(2)}` : ""}${c.freeCredits ? ` + Free $${c.freeCredits.toFixed(2)}` : ""})`)
  }

  const w = result.windowLimits
  if (w?.fiveHour) {
    const leftPct = w.fiveHour.cap ? Math.max(0, 100 - (w.fiveHour.used ?? 0) / w.fiveHour.cap * 100) : 100
    lines.push(`  ${"5h Window:".padEnd(13)} ${formatBar(leftPct)} ${leftPct.toFixed(0)}% Left`)
    lines.push(`  ${"".padEnd(13)} ${(w.fiveHour.used ?? 0).toFixed(2)} / ${w.fiveHour.cap ?? "?"} Credits${formatResetSuffix(w.fiveHour.resetAt)}`)
  }

  if (w?.weekly) {
    const leftPct = w.weekly.cap ? Math.max(0, 100 - (w.weekly.used ?? 0) / w.weekly.cap * 100) : 100
    lines.push(`  ${"Weekly:".padEnd(13)} ${formatBar(leftPct)} ${leftPct.toFixed(0)}% Left`)
    lines.push(`  ${"".padEnd(13)} ${(w.weekly.used ?? 0).toFixed(2)} / ${w.weekly.cap ?? "?"} Credits${formatResetSuffix(w.weekly.resetAt)}`)
  }

  if (result.proxy) {
    const state = result.proxy.healthy
      ? `Healthy${result.proxy.models !== undefined ? `, ${result.proxy.models} Models` : ""}`
      : "Unreachable"
    lines.push(`  ${"Local Proxy:".padEnd(13)} ${PROXY_URL} (${state})`)
  }

  return { stdout: lines, stderr: [] }
}

