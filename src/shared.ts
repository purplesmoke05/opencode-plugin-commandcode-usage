export function formatBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct))
  const size = 15
  const filled = Math.round((clamped / 100) * size)
  return `${"█".repeat(filled)}${"░".repeat(size - filled)}`
}

export function formatTimeDelta(at: number): string {
  const atSeconds = at > 1e11 ? Math.floor(at / 1000) : at
  const diff = atSeconds - Math.floor(Date.now() / 1000)
  if (diff <= 0) return "Just Refreshed"

  const days = Math.floor(diff / 86400)
  const hours = Math.floor((diff % 86400) / 3600)
  const minutes = Math.floor((diff % 3600) / 60)

  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${diff}s`
}

export function formatResetSuffix(resetAt: number | string | null | undefined): string {
  if (!resetAt) return ""
  const ms = typeof resetAt === "string" ? new Date(resetAt).getTime() : resetAt
  if (!Number.isFinite(ms) || ms <= 0) return ""
  const delta = formatTimeDelta(ms)
  return delta === "Just Refreshed" ? ` (${delta})` : ` (Resets In ${delta})`
}

export async function sendStatusMessage(
  client: { session: { prompt: (args: any) => Promise<unknown> }; tui?: { showToast: (args: any) => Promise<unknown> } },
  sessionID: string,
  text: string,
): Promise<void> {
  await client.session
    .prompt({
      path: { id: sessionID },
      body: { noReply: true, parts: [{ type: "text", text, ignored: true }] },
    })
    .catch(async () => {
      await client.tui?.showToast({ body: { title: "Usage Status", message: text, variant: "info" } }).catch(() => {})
    })
}

export const HANDLED = "__USAGE_COMMAND_HANDLED__"

export function output(s: { stdout: string[]; stderr: string[] }): string {
  return [...s.stdout, ...(s.stderr.length ? ["", ...s.stderr] : [])].join("\n")
}

export interface FooterCache {
  get(): Promise<string | null>
}

const FOOTER_TTL_DEFAULT = 60_000
const FOOTER_TTL_MAX_AGE = 10 * 60_000

export function createFooterCache(fetchLine: () => Promise<string>): FooterCache {
  let cached: { text: string; at: number } | null = null
  let inflight: Promise<string | null> | null = null

  return {
    async get(): Promise<string | null> {
      if (process.env.USAGE_FOOTER === "0") return null
      const ttl = Number(process.env.USAGE_FOOTER_TTL_MS) || FOOTER_TTL_DEFAULT
      const now = Date.now()
      if (cached) {
        if (now - cached.at < ttl) return cached.text
        if (now - cached.at > FOOTER_TTL_MAX_AGE) cached = null
      }
      if (inflight) return inflight
      inflight = (async () => {
        try {
          const text = await fetchLine()
          cached = { text, at: Date.now() }
          return text
        } catch {
          return cached?.text ?? null
        } finally {
          inflight = null
        }
      })()
      return inflight
    },
  }
}

export function createMessageGuard() {
  const seen = new Map<string, number>()
  return {
    claim(id: string): boolean {
      if (seen.has(id)) return false
      seen.set(id, Date.now())
      if (seen.size > 500) {
        const cutoff = Date.now() - 30 * 60_000
        for (const [k, at] of seen) if (at < cutoff) seen.delete(k)
      }
      return true
    },
  }
}
