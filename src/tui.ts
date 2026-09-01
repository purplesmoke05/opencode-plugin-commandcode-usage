import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"

const POLL_MS = 60_000
const API_BASE = "https://api.commandcode.ai"

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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
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
      res = await fetchWithTimeout(`${API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${key}`,
          "x-command-code-version": "1.32.1",
        },
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

function pct(used: number, cap: number): string {
  if (cap <= 0) return "?"
  return `${Math.min(100, (used / cap) * 100).toFixed(0)}%`
}

function bar(used: number, cap: number): string {
  const usedPct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0
  const size = 13
  const filled = Math.max(0, Math.min(size, Math.round((usedPct / 100) * size)))
  return `${"█".repeat(filled)}${"░".repeat(size - filled)}`
}

const plugin: TuiPlugin = async (api) => {
  // Use the TUI process's own solid runtime so reactive effects integrate
  // with the host renderer (same approach as built-in sidebar sections).
  const solid = await import("@opentui/solid").catch(() => null)
  if (!solid) return
  const solidjs = await import("solid-js").catch(() => null)
  if (!solidjs || typeof solidjs.createSignal !== "function") return

  const [snap, setSnap] = solidjs.createSignal<Snapshot | null>(null)
  const [err, setErr] = solidjs.createSignal<string | null>(null)
  let disposed = false
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | null = null

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content() {
        return buildSidebar(solid, api, snap, err)
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
      const key = await readKey()
      if (!key) {
        setErr("CommandCode credentials not found (checked COMMANDCODE_API_KEY and auth.json)")
      } else {
        setSnap(await fetchSnapshot(key))
        setErr(null)
      }
      api.renderer.requestRender()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      api.renderer.requestRender()
    } finally {
      inFlight = false
      if (!disposed) schedule()
    }
  }

  const schedule = () => {
    const delay = snap() === null ? (err() ? 10_000 : 5_000) : POLL_MS
    timer = setTimeout(tick, delay)
  }

  void tick()

  api.lifecycle.onDispose(() => {
    disposed = true
    if (timer) clearTimeout(timer)
  })
}

/**
 * Builds a reactive sidebar element: the child list is passed to
 * `solid.insert` as an accessor, so it re-evaluates whenever the underlying
 * signals change — updating the on-screen text even while the TUI is idle.
 */
function buildSidebar(solid: any, api: TuiPluginApi, snap: () => Snapshot | null, err: () => string | null) {
  const box = solid.createElement("box")
  solid.setProp(box, "flexDirection", "column")

  const children = () => {
    const s = snap()
    const e = err()
    const theme = api.theme.current
    const out: any[] = []

    const title = solid.createElement("text")
    solid.setProp(title, "fg", theme.text)
    const titleBox = solid.createElement("b")
    solid.insert(titleBox, "CommandCode")
    solid.insert(title, titleBox)
    out.push(title)

    if (e) {
      const t = solid.createElement("text")
      solid.setProp(t, "fg", theme.textMuted)
      solid.insert(t, e)
      out.push(t)
    } else if (!s) {
      const t = solid.createElement("text")
      solid.setProp(t, "fg", theme.textMuted)
      solid.insert(t, "Loading...")
      out.push(t)
    } else {
      const w5 = s.fiveHour
      if (w5) {
        const reset = fmtReset(w5.resetAt)
        const t = solid.createElement("text")
        solid.setProp(t, "fg", theme.textMuted)
        solid.insert(t, `5h ${bar(w5.used, w5.cap)} ${pct(w5.used, w5.cap)}${reset ? ` · Resets In ${reset}` : ""}`)
        out.push(t)
      }
      const wk = s.weekly
      if (wk) {
        const reset = fmtReset(wk.resetAt)
        const t = solid.createElement("text")
        solid.setProp(t, "fg", theme.textMuted)
        solid.insert(t, `Weekly ${bar(wk.used, wk.cap)} ${pct(wk.used, wk.cap)}${reset ? ` · Resets In ${reset}` : ""}`)
        out.push(t)
      }
      if (s.credits !== undefined) {
        const t = solid.createElement("text")
        solid.setProp(t, "fg", theme.textMuted)
        solid.insert(t, `$${s.credits.toFixed(2)} Credits`)
        out.push(t)
      }
      if (!w5 && !wk && s.credits === undefined) {
        const t = solid.createElement("text")
        solid.setProp(t, "fg", theme.textMuted)
        solid.insert(t, "No Usage Data")
        out.push(t)
      }
    }
    return out
  }

  // Pass an accessor: solid's insert tracks the signals read inside and
  // re-runs it on change, replacing the rendered children.
  solid.insert(box, () => children())
  return box
}

export default {
  id: "commandcode-usage-tui",
  tui: plugin,
} as const