import type { TuiPlugin } from "@opencode-ai/plugin/tui"

const API_BASE = "https://api.commandcode.ai"
const POLL_MS = 60_000

interface WindowLimit {
  used?: number
  cap?: number
  resetAt?: number | string | null
}

interface SubscriptionsResponse {
  data?: { planId?: string; cancelAtPeriodEnd?: boolean }
}

interface CreditsResponse {
  credits?: {
    monthlyCredits?: number
    purchasedCredits?: number
    freeCredits?: number
  }
  windowLimits?: { fiveHour?: WindowLimit; weekly?: WindowLimit }
}

interface Snapshot {
  fiveHour?: { used: number; cap: number; resetAt?: number }
  weekly?: { used: number; cap: number; resetAt?: number }
  credits?: number
}

async function readKey(): Promise<string | null> {
  const fromEnv = process.env.COMMANDCODE_API_KEY
  if (fromEnv) return fromEnv

  const home = process.env.HOME
  if (!home) return null
  try {
    const file = Bun.file(`${home}/.local/share/opencode/auth.json`)
    if (!(await file.exists())) return null
    const auth = (await file.json()) as Record<string, { key?: string }>
    return auth?.["commandcode"]?.key ?? auth?.["commandcode-claude"]?.key ?? null
  } catch {
    return null
  }
}

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
        signal: AbortSignal.timeout(5000),
      })
    } catch (e) {
      lastError = new Error(`connect failed: ${e instanceof Error ? e.message : String(e)}`)
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
      continue
    }
    if (!res.ok) throw new Error(`${res.status}`)
    return (await res.json()) as T
  }
  throw lastError
}

async function fetchSnapshot(key: string): Promise<Snapshot> {
  const [subs, credits] = await Promise.all([
    apiGet<SubscriptionsResponse>("/alpha/billing/subscriptions", key),
    apiGet<CreditsResponse>("/alpha/billing/credits", key),
  ])
  const w = credits.windowLimits ?? {}
  const c = credits.credits ?? {}
  return {
    fiveHour: w.fiveHour
      ? { used: w.fiveHour.used ?? 0, cap: w.fiveHour.cap ?? 0, resetAt: w.fiveHour.resetAt ? Number(w.fiveHour.resetAt) : undefined }
      : undefined,
    weekly: w.weekly
      ? { used: w.weekly.used ?? 0, cap: w.weekly.cap ?? 0, resetAt: w.weekly.resetAt ? Number(w.weekly.resetAt) : undefined }
      : undefined,
    credits: (c.monthlyCredits ?? 0) + (c.purchasedCredits ?? 0) + (c.freeCredits ?? 0),
  }
}

function fmtReset(at: number | undefined): string {
  if (!at) return ""
  const diff = Math.floor(at / 1000) - Math.floor(Date.now() / 1000)
  if (diff <= 0) return ""
  const d = Math.floor(diff / 86400)
  const h = Math.floor((diff % 86400) / 3600)
  const m = Math.floor((diff % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

function bar(used: number, cap: number): string {
  const pct = cap > 0 ? used / cap : 0
  const size = 13
  const filled = Math.max(0, Math.min(size, Math.round(pct * size)))
  return `${"█".repeat(filled)}${"░".repeat(size - filled)}`
}

function pctStr(used: number, cap: number): string {
  if (cap <= 0) return "?"
  return `${Math.min(100, (used / cap) * 100).toFixed(0)}%`
}

type Node = { kind: string; props?: Record<string, unknown>; text?: string; children?: Node[] }

function buildViewNodes(snap: Snapshot | null, error: string | null, theme: { text: unknown; textMuted: unknown }): Node[] {
  const lines: Node[] = [{ kind: "text", props: { fg: theme.text }, children: [{ kind: "b", text: "CommandCode" }] }]

  if (error) {
    lines.push({ kind: "text", props: { fg: theme.textMuted }, text: error })
    return lines
  }
  if (!snap) {
    lines.push({ kind: "text", props: { fg: theme.textMuted }, text: "Loading..." })
    return lines
  }

  const w5 = snap.fiveHour
  if (w5) {
    const reset = fmtReset(w5.resetAt)
    lines.push({
      kind: "text",
      props: { fg: theme.textMuted },
      text: `5h ${bar(w5.used, w5.cap)} ${pctStr(w5.used, w5.cap)}${reset ? ` · Resets In ${reset}` : ""}`,
    })
  }

  const wk = snap.weekly
  if (wk) {
    const reset = fmtReset(wk.resetAt)
    lines.push({
      kind: "text",
      props: { fg: theme.textMuted },
      text: `Weekly ${bar(wk.used, wk.cap)} ${pctStr(wk.used, wk.cap)}${reset ? ` · Resets In ${reset}` : ""}`,
    })
  }

  if (snap.credits !== undefined) {
    lines.push({ kind: "text", props: { fg: theme.textMuted }, text: `$${snap.credits.toFixed(2)} Credits` })
  }

  return lines
}

function materialize(nodes: Node[], solid: any): any {
  const root = solid.createElement("box")
  solid.setProp(root, "flexDirection", "column")
  for (const node of nodes) solid.insert(root, materializeNode(node, solid))
  return root
}

function materializeNode(node: Node, solid: any): any {
  const element = solid.createElement(node.kind)
  for (const [name, value] of Object.entries(node.props ?? {})) {
    solid.setProp(element, name, value)
  }
  if (node.text !== undefined) solid.insert(element, node.text)
  for (const child of node.children ?? []) {
    solid.insert(element, materializeNode(child, solid))
  }
  return element
}

const plugin: TuiPlugin = async (api) => {
  const solid = await import("@opentui/solid").catch(() => null)
  if (!solid) return

  let key: string | null = null
  let keyResolved = false
  let snap: Snapshot | null = null
  let error: string | null = null
  let disposed = false
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | null = null

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content() {
        return materialize(buildViewNodes(snap, error, api.theme.current as { text: unknown; textMuted: unknown }), solid)
      },
    },
  })

  const tick = async () => {
    if (disposed || inFlight) {
      if (!disposed) schedule()
      return
    }
    inFlight = true
    try {
      if (!keyResolved) {
        key = await readKey()
        keyResolved = true
        if (!key) {
          error = "CommandCode credentials not found (checked COMMANDCODE_API_KEY and auth.json)"
          api.renderer.requestRender()
          return
        }
      }
      snap = await fetchSnapshot(key as string)
      error = null
      api.renderer.requestRender()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      api.renderer.requestRender()
    } finally {
      inFlight = false
      if (!disposed) schedule()
    }
  }

  const schedule = () => {
    // Retry quickly while the first successful fetch is still pending (or the
    // first one failed), so the sidebar does not sit on "Loading..." or an
    // error line for a full poll interval after a transient startup failure.
    const delay = snap === null ? (error ? 10_000 : 5_000) : POLL_MS
    timer = setTimeout(tick, delay)
  }

  void tick()

  api.lifecycle.onDispose(() => {
    disposed = true
    if (timer) clearTimeout(timer)
  })
}

export default {
  id: "commandcode-usage-tui",
  tui: plugin,
} as const