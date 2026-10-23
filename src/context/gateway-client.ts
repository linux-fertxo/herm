// Stdio JSON-RPC 2.0 client for tui_gateway. Spawns the gateway as a child
// process and speaks newline-delimited JSON on stdin/stdout.

import { EventEmitter } from "events"
import { homedir } from "os"
import { resolve, delimiter } from "path"
import { existsSync } from "fs"
import { knownGatewayEvent, type GatewayEvent } from "./wire"
import { backend } from "./backend-contract"
import { loadContract } from "./gateway-contract"
import { encode } from "../utils/unicode"

const LOG_MAX = 200
const LOG_PREVIEW = 240
const STARTUP_MS = 15_000
const REQUEST_MS = 120_000
const WS_CONNECTING = 0
const WS_OPEN = 1
const WS_CLOSING = 2
const WS_CLOSED = 3
const decoder = new TextDecoder()

// JSON-RPC error for a question this client has no surface to render.
const NO_HANDLER = -32601

// Server→client request methods the transcript renders. Everything else (tour,
// vault prompts, preview reads, window reads) has no surface here, and a
// backend that never gets an answer waits out its full deadline — clarify's is
// 3600s — so the rest are declined immediately instead of left hanging.
const RENDERED = new Set(["clarify", "approval", "sudo", "secret", "terminal.read"])

const EVENT_OF: Record<string, string> = {
  clarify: "clarify.request",
  approval: "approval.request",
  sudo: "sudo.request",
  secret: "secret.request",
  "terminal.read": "terminal.read.request",
}

/** Hermes sends a blocking question as a server→client request; the transcript
 *  renders the `*.request` event that used to carry it, keeping the frame id as
 *  `request_id` because that — not a follow-up RPC — is what routes the answer
 *  back to the backend that asked. It goes last: `approval` params declare a
 *  `request_id` of their own, and letting it win made every answer miss the open
 *  frame ("this request is no longer open"). The backend settles responses by
 *  the frame id (`server_requests.resolve_response`). */
function ask(id: string, method: string, params: Record<string, unknown>): GatewayEvent | null {
  const type = EVENT_OF[method]
  if (!type) return null
  return { type, payload: { ...params, request_id: id } } as GatewayEvent
}

export type GatewayEventSource = "stdio" | "websocket" | "control" | "internal"

type Diag = {
  count: number
  index: number
  line: (count: number) => string
}

/** Locate the hermes-agent source tree (gateway + hermes_cli live here).
 *  Default: ~/.hermes/hermes-agent (where `hermes update` installs it).
 *  Fallback: /usr/local/lib/hermes-agent (FHS layout for root Linux installs).
 *  Override with HERMES_AGENT_ROOT for dev clones / exotic layouts. */
export function hermesAgentRoot(): string {
  if (process.env.HERMES_AGENT_ROOT) return process.env.HERMES_AGENT_ROOT
  const home = process.env.HOME || homedir()
  const homePath = `${home}/.hermes/hermes-agent`
  if (existsSync(homePath)) return homePath
  const fhs = "/usr/local/lib/hermes-agent"
  if (existsSync(fhs)) return fhs
  return homePath
}

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export function gatewayUrl(): string | null {
  return process.env.HERM_GATEWAY_URL?.trim()
    || process.env.HERMES_TUI_GATEWAY_URL?.trim()
    || null
}

/** Grant from the install's own `gateway_bootstrap.py`: the profile's live gateway endpoint
 *  and the subprotocols that carry the single-use session ticket. It is the same helper the
 *  official Ink TUI dials, so an upgraded Hermes keeps working without a copy here. */
export interface GatewayGrant {
  url: string
  protocols: string[]
  profile_id: string
  instance_id: string
}

const BOOTSTRAP_MS = 40_000

/** The install ships the bootstrap; we never fork it. An older install has no gateway to attach
 *  to (its TUI owned the profile itself), which is the one case where the stdio backend is right. */
export function bootstrapScript(root: string): string {
  return resolve(root, "ui-tui", "scripts", "gateway_bootstrap.py")
}

function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text().catch(() => "")
}

/** Ask the install for an attach ticket. `start` may bring up a gateway that is not running;
 *  `recover` re-ensures one whose recorded state claims it is live after a crash. */
export async function fetchGrant(
  root: string,
  opts: { start?: boolean; recover?: boolean } = {},
): Promise<GatewayGrant> {
  const script = bootstrapScript(root)
  if (!existsSync(script)) throw new Error(`gateway bootstrap missing: ${script}`)
  const args = [script, ...(opts.start ? ["--start"] : opts.recover ? ["--recover"] : [])]
  const proc = Bun.spawn([python(root), ...args], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: root, HERMES_PYTHON_SRC_ROOT: root } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => { try { proc.kill() } catch {} }, BOOTSTRAP_MS)
  try {
    const [out, err, code] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr), proc.exited])
    if (code !== 0) {
      // The helper prints a verdict line ("gateway unavailable: …" / "gateway stopped: …") on
      // stderr; it is meant for the user, so it is passed through as-is.
      const verdict = err.trim() || `gateway bootstrap failed (${code})`
      throw new Error(verdict)
    }
    const grant = JSON.parse(out.trim()) as GatewayGrant
    if (!grant?.url || !Array.isArray(grant.protocols)) throw new Error("gateway bootstrap returned no grant")
    return grant
  } finally {
    clearTimeout(timer)
  }
}

export function websocketUrl(raw: string): string {
  const url = new URL(raw)
  if (url.protocol === "http:") url.protocol = "ws:"
  else if (url.protocol === "https:") url.protocol = "wss:"
  else if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error(`unsupported gateway URL protocol: ${url.protocol}`)
  const prefix = url.pathname.replace(/\/+$/, "")
  if (!prefix.endsWith("/api/ws")) url.pathname = `${prefix}/api/ws`
  return url.toString()
}

function redact(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.username || url.password) {
      url.username = "***"
      url.password = ""
    }
    if (url.search) url.search = "?***"
    return url.toString()
  } catch { return "invalid gateway URL" }
}

export function python(root: string, platform: NodeJS.Platform = process.platform): string {
  const env = process.env.HERMES_PYTHON?.trim()
  if (env) return env

  const venv = process.env.VIRTUAL_ENV?.trim()
  const paths = platform === "win32"
    ? [
        venv && resolve(venv, "Scripts", "python.exe"),
        resolve(root, "venv", "Scripts", "python.exe"),
        resolve(root, ".venv", "Scripts", "python.exe"),
      ]
    : [
        venv && resolve(venv, "bin", "python"),
        venv && resolve(venv, "bin", "python3"),
        resolve(root, "venv", "bin", "python"),
        resolve(root, "venv", "bin", "python3"),
        resolve(root, ".venv", "bin", "python"),
        resolve(root, ".venv", "bin", "python3"),
      ]
  return paths.find(p => p && existsSync(p)) || (platform === "win32" ? "python" : "python3")
}

function asEvent(v: unknown): GatewayEvent | null {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string")
    return v as GatewayEvent
  return null
}

function text(raw: unknown): string | null {
  if (typeof raw === "string") return raw
  if (raw instanceof ArrayBuffer) return decoder.decode(raw)
  if (ArrayBuffer.isView(raw)) return decoder.decode(raw)
  return null
}

function rec(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
  return null
}

function crop(s: string): string {
  return s.length > LOG_PREVIEW ? `${s.slice(0, LOG_PREVIEW)}…` : s
}

function clean(v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v
  if (typeof v === "string") return crop(v)
  if (v === undefined) return "[undefined]"
  if (typeof v !== "object") return `[${typeof v}]`
  if (seen.has(v)) return "[circular]"
  if (depth >= 3) return "[depth]"
  seen.add(v)
  if (Array.isArray(v)) {
    const vals = v.slice(0, 6).map(x => clean(x, depth + 1, seen))
    return v.length > vals.length ? [...vals, `…+${v.length - vals.length}`] : vals
  }
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(v).slice(0, 12)) {
    out[key] = /token|secret|password|credential|authorization|api[_-]?key|cookie|private[_-]?key/i.test(key)
      ? "[redacted]"
      : clean(val, depth + 1, seen)
  }
  const extra = Object.keys(v).length - Object.keys(out).length
  if (extra > 0) out["…"] = `+${extra}`
  return out
}

function payload(ev: GatewayEvent): string {
  const obj = rec(ev)
  if (!obj || !("payload" in obj)) return "(none)"
  try { return crop(JSON.stringify(clean(obj.payload, 0, new WeakSet()))) }
  catch { return "[unserializable]" }
}

function contract(ev: GatewayEvent): string {
  const obj = rec(ev)
  const body = rec(obj?.payload)
  const raw = obj?.contract_version
    ?? obj?.contractVersion
    ?? body?.contract_version
    ?? body?.contractVersion
    ?? rec(body?.contract)?.version
  return raw === undefined || raw === null ? "unknown" : crop(String(raw))
}

// Read lines from a ReadableStream (Bun subprocess stdout/stderr)
async function lines(stream: ReadableStream<Uint8Array>, cb: (line: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split("\n")
      buf = parts.pop() || ""
      for (const line of parts) {
        if (line) cb(line)
      }
    }
    // Flush remaining
    if (buf.trim()) cb(buf)
  } catch {
    // Stream closed
  }
}

function responseValue(result: Record<string, unknown>): string {
  // The transcript answers with `answer` (clarify), `choice` (approval), `value` (secret/sudo)
  // or `answers` (multi-select). The canonical RPC takes one string; declining sends "".
  for (const key of ["answer", "choice", "value"]) {
    const v = result[key]
    if (typeof v === "string") return v
  }
  const many = result.answers
  if (Array.isArray(many)) return many.filter(x => typeof x === "string").join(", ")
  return ""
}

export class GatewayClient extends EventEmitter {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private ws: WebSocket | null = null
  private link: Promise<void> | null = null
  private target: string | null = null
  /** Ticket grant for the profile's gateway; its presence means requests travel over the socket. */
  private grant: GatewayGrant | null = null
  /** Which transport this client is on: the profile's gateway ("ws") or its own child ("stdio"). */
  private mode: "ws" | "stdio" | null = null
  /** In-flight attach, so a request issued during startup waits for the ticket instead of racing it. */
  private attaching: Promise<void> | null = null
  private id = 0
  private logs: string[] = []
  private unknown = new Map<string, Diag>()
  private pending = new Map<string, Pending>()
  /** Frame ids of server→client requests rendered but not yet answered. */
  private open = new Set<string>()
  /** Prompts announced as events on the canonical socket: answered by RPC, not by a frame reply. */
  private prompts = new Map<string, { kind: "clarify" | "approval"; generation: number; session: string }>()
  /** Execution generation of the live session: canonical controls require it as an integer. */
  private generation: number | null = null
  private buf: GatewayEvent[] = []
  private contract = backend.backendContract(null)
  private declared = loadContract(hermesAgentRoot())
  private exit: number | null | undefined
  private ok = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private sub = false

  private root(): string { return hermesAgentRoot() }

  constructor() {
    super()
    // Readiness can arrive before a surface subscribes (attach is a ~300 ms subprocess, React
    // mounts when it mounts). A listener that shows up after the fact must not sit at "not
    // connected" while every RPC works, so the buffered events are flushed to the first one and
    // the current readiness is replayed.
    this.on("newListener", name => {
      if (name !== "event") return
      queueMicrotask(() => {
        if (!this.sub) {
          this.sub = true
          for (const ev of this.buf.splice(0)) this.emit("event", ev)
        }
        if (this.ok) this.emit("event", { type: "gateway.ready", payload: { source: "replay" } } as GatewayEvent)
      })
    })
  }

  private push(ev: GatewayEvent, source: GatewayEventSource = "internal") {
    this.diagnose(ev, source)
    this.trackPrompt(ev)
    // A session opened from the list can deliver its history inside an event payload instead of
    // the RPC reply; those rows need the same translation or the transcript stays blank.
    const payload = rec((ev as { payload?: unknown }).payload)
    if (payload && payload.messages !== undefined) payload.messages = this.history(payload.messages)
    if (ev.type === "gateway.ready") {
      this.ok = true
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
      this.advertise()
    }
    if (this.sub) return void this.emit("event", ev)
    this.buf.push(ev)
  }

  /** Declare that this client answers server→client requests. Without it the
   *  backend refuses to write the frame at all (`server_requests.send` returns
   *  None for an unadvertised transport), so clarify and approval self-skip
   *  silently and the agent answers its own questions. */
  private advertise() {
    void this.request("client.capabilities", { server_requests: true }).catch(() => {})
  }

  private log(line: string): number {
    if (this.logs.push(line) > LOG_MAX) {
      const cut = this.logs.length - LOG_MAX
      this.logs.splice(0, cut)
      for (const d of this.unknown.values()) d.index -= cut
    }
    return this.logs.length - 1
  }

  diagnose(ev: GatewayEvent, source: GatewayEventSource = "control") {
    try {
      if (knownGatewayEvent(ev.type)) return
      const version = contract(ev)
      const key = `${source}\u0000${version}\u0000${ev.type}`
      const old = this.unknown.get(key)
      if (old && old.index >= 0 && old.index < this.logs.length) {
        old.count++
        this.logs[old.index] = old.line(old.count)
        return
      }
      const summary = payload(ev)
      const line = (count: number) => `[event unknown] type=${ev.type} source=${source} contract=${version} count=${count} payload=${summary}`
      this.unknown.set(key, { count: 1, index: this.log(line(1)), line })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      this.log(`[event diagnostic_failed] source=${source} error=${crop(text)}`)
    }
  }

  private observe(raw: unknown) {
    const next = backend.backendContract(raw)
    this.contract = next.reason === "missing" && this.contract.supported ? this.contract : next
  }

  private dispatch(msg: Record<string, unknown>, source: GatewayEventSource = "stdio") {
    const id = msg.id as string | undefined
    const p = id ? this.pending.get(id) : undefined

    if (p) {
      this.pending.delete(id!)
      const res = msg.result
      const info = res && typeof res === "object" && !Array.isArray(res)
        ? (res as { info?: unknown }).info
        : undefined
      if (info) this.observe(info)
      if (msg.error) {
        const err = msg.error as { message?: unknown }
        p.reject(new Error(typeof err?.message === "string" ? err.message : "request failed"))
      } else {
        this.replay(res, source)
        p.resolve(this.identity(res))
      }
      return
    }

    if (msg.method === "event") {
      const ev = asEvent(msg.params)
      if (ev) {
        if (ev.type === "session.info") this.observe(ev.payload)
        this.push(ev, source)
      }
      return
    }

    // A string id plus a method is the backend asking THIS client a question.
    // A response to one of ours never carries a method, so it cannot land here.
    if (typeof id === "string" && typeof msg.method === "string")
      this.deliver(id, msg.method, rec(msg.params) ?? {}, source)
  }

  private deliver(id: string, method: string, params: Record<string, unknown>, source: GatewayEventSource) {
    if (!RENDERED.has(method)) {
      this.log(`[server request] declined ${method} (${id})`)
      return void this.reply(id, { error: { code: NO_HANDLER, message: `no handler for server request: ${method}` } })
    }
    this.open.add(id)
    const ev = ask(id, method, params)
    if (ev) this.push(ev, source)
  }

  /** A reconnect replay returns the questions still waiting for an answer, so a
   *  card survives a dropped socket instead of becoming unanswerable. */
  private replay(res: unknown, source: GatewayEventSource) {
    const items = rec(res)?.open_requests
    if (!Array.isArray(items)) return
    for (const item of items) {
      const req = rec(item)
      const id = req?.id
      const method = req?.method
      if (typeof id === "string" && typeof method === "string")
        this.deliver(id, method, rec(req?.params) ?? {}, source)
    }
  }

  /** Store rows → transcript messages. The canonical snapshot returns database rows (`role`,
   *  `content`), while the transcript renders `parts`; without this a resumed session shows the
   *  right context with a blank screen. */
  private history(rows: unknown): unknown {
    if (!Array.isArray(rows)) return rows
    return rows.map(row => {
      const o = rec(row)
      if (!o) return row
      if (Array.isArray(o.parts)) return o
      let text = ""
      if (typeof o.content === "string") text = o.content
      else if (typeof o.text === "string") text = o.text
      else if (Array.isArray(o.content))
        text = o.content
          .map(part => (typeof part === "string" ? part : (rec(part)?.text as string | undefined) ?? ""))
          .join("")
      const role = typeof o.role === "string" ? o.role : "assistant"
      return { ...o, role, parts: text ? [{ type: "text", text }] : [] }
    })
  }

  private identity(res: unknown): unknown {
    const o = rec(res)
    if (!o) return res
    if (o.messages !== undefined) o.messages = this.history(o.messages)
    if (o.id === undefined && typeof o.session_id === "string") o.id = o.session_id
    if (o.key === undefined && typeof o.stored_session_id === "string") o.key = o.stored_session_id
    // Canonical controls are generation-bound; the snapshot is where a session's generation is
    // published, so it is kept here for every later `session.steer`/`*.respond`.
    if (typeof o.execution_generation === "number") this.generation = o.execution_generation
    return o
  }

  /** Answer an open server→client request by frame id. False when nothing is
   *  open under that id: already answered, or withdrawn by the backend. */
  respond(id: string, result: Record<string, unknown>): boolean {
    const prompt = this.mode === "ws" ? this.prompts.get(id) : undefined
    if (prompt) {
      // The canonical socket does not accept a bare JSON-RPC response frame for a prompt: it
      // arrives as an event and is settled by a generation-bound `*.respond` RPC.
      this.prompts.delete(id)
      this.open.delete(id)
      const field = prompt.kind === "clarify" ? "answer" : "choice"
      const method = prompt.kind === "clarify" ? "clarify.respond" : "approval.respond"
      void this.request(method, {
        session_id: prompt.session,
        execution_generation: prompt.generation,
        prompt_id: id,
        [field]: responseValue(result),
      }).catch(err => this.log(`[respond] ${method} failed: ${crop(err instanceof Error ? err.message : String(err))}`))
      return true
    }
    if (!this.open.delete(id)) return false
    this.reply(id, { result })
    return true
  }

  /** Canonical prompts carry `prompt_id`; the transcript answers by `request_id`, so the id is
   *  mirrored into the payload and the generation kept for the settle RPC. */
  private trackPrompt(ev: GatewayEvent) {
    if (ev.type !== "clarify.request" && ev.type !== "approval.request") return
    const frame = rec(ev)
    const body = rec(frame?.payload)
    const id = body && typeof body.prompt_id === "string" ? body.prompt_id : undefined
    if (!body || !id) return
    if (body.request_id === undefined) body.request_id = id
    const session = typeof frame?.session_id === "string" ? frame.session_id : this.sid
    const generation = typeof body.execution_generation === "number"
      ? body.execution_generation
      : (this.generation ?? 0)
    this.prompts.set(id, {
      kind: ev.type === "clarify.request" ? "clarify" : "approval",
      generation,
      session,
    })
  }

  private reply(id: string, body: Record<string, unknown>) {
    const text = JSON.stringify({ jsonrpc: "2.0", id, ...body })
    const ws = this.ws
    if (ws?.readyState === WS_OPEN) return void ws.send(text)
    const stdin = this.proc?.stdin
    if (!stdin || typeof stdin === "number") return void this.log(`[server request] no transport to answer ${id}`)
    ;(stdin as { write(data: string): number }).write(text + "\n")
  }

  private fail(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private connect(raw: string, protocols: string[] = []) {
    const cwd = process.env.HERMES_CWD || process.cwd()
    let url: string
    try { url = websocketUrl(raw) }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[startup] websocket failed: ${message}`)
      this.push({ type: "gateway.stderr", payload: { line: message } })
      if (this.sub) this.emit("exit", null)
      else this.exit = null
      return
    }

    const safe = redact(url)
    let ws: WebSocket
    try { ws = protocols.length ? new WebSocket(url, protocols) : new WebSocket(url) }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[startup] websocket failed (${safe}): ${message}`)
      this.push({ type: "gateway.stderr", payload: { line: message } })
      if (this.sub) this.emit("exit", null)
      else this.exit = null
      return
    }

    this.target = raw
    this.ws = ws
    let settled = false
    this.link = new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        if (settled) return
        settled = true
        if (protocols.length) this.log(`[startup] attached (subprotocol=${ws.protocol || "none"})`)
        resolve()
      }, { once: true })
      ws.addEventListener("error", () => {
        if (settled) return
        settled = true
        reject(new Error("gateway websocket connection failed"))
        try { ws.close() } catch {}
      }, { once: true })
      ws.addEventListener("close", event => {
        if (settled) return
        settled = true
        reject(new Error(`gateway websocket closed (${event.code}) during connect`))
      }, { once: true })
    })
    this.link.catch(() => {})

    this.timer = setTimeout(() => {
      if (this.ok || this.ws !== ws) return
      this.log(`[startup] timed out (websocket=${safe}, cwd=${cwd})`)
      this.push({ type: "gateway.start_timeout", payload: { cwd, python: "websocket" } })
      this.ws = null
      this.link = null
      this.fail(new Error("gateway websocket startup timeout"))
      try { ws.close() } catch {}
      if (this.sub) this.emit("exit", null)
      else this.exit = null
    }, STARTUP_MS)

    ws.addEventListener("message", event => {
      if (this.ws !== ws) return
      const raw = text(event.data)
      if (!raw) return
      try { this.dispatch(JSON.parse(raw), "websocket") }
      catch {
        const preview = raw.trim().slice(0, LOG_PREVIEW) || "(empty)"
        this.log(`[protocol] malformed websocket: ${preview}`)
        this.push({ type: "gateway.protocol_error", payload: { preview } })
      }
    })
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return
      const line = `websocket transport error (${safe})`
      this.log(`[gateway] ${line}`)
      this.push({ type: "gateway.stderr", payload: { line } })
    })
    ws.addEventListener("close", event => {
      if (this.ws !== ws) return
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
      this.ws = null
      this.link = null
      this.fail(new Error(`gateway websocket closed${event.code ? ` (${event.code})` : ""}`))
      if (this.sub) this.emit("exit", event.code)
      else this.exit = event.code
    })
  }

  private markReady() {
    // The canonical socket carries no legacy `desktop_contract` number: it is an authenticated,
    // typed session socket that advertises capabilities instead. Once the owner describes itself
    // the legacy gate is satisfied by construction — protocol drift there shows up as `-32601`
    // or a refused handshake, never as a silently misread mutating call.
    this.adoptCanonicalContract()
    this.log(`[startup] ready via runtime.describe (already=${this.ok})`)
    if (this.ok) return
    this.push({ type: "gateway.ready", payload: { source: "runtime.describe" } } as GatewayEvent)
  }

  /** Satisfy the legacy contract gate for a canonical socket. Called as soon as the grant exists
   *  (not after a round-trip): a prompt sent during startup must not hit "contract is missing". */
  private adoptCanonicalContract() {
    if (this.contract.supported && this.contract.reason === "supported") return
    this.contract = {
      ...this.contract,
      observedContract: backend.MAX_BACKEND_CONTRACT,
      supported: true,
      reason: "supported",
    }
  }

  /** Attach to the profile's gateway with a single-use ticket from the install's own bootstrap.
   *  Nothing is spawned and nothing is owned: closing the TUI just closes the socket. */
  private attach(): Promise<void> {
    this.mode = "ws"
    const run = (async () => {
      try {
        const grant = await fetchGrant(this.root(), { start: process.env.HERM_GATEWAY_START === "1" })
        if (this.mode !== "ws") return
        this.grant = grant
        // Gate satisfied before any RPC can be attempted on this transport.
        this.adoptCanonicalContract()
        this.connect(grant.url, grant.protocols)
        // The canonical socket has no `gateway.ready` frame: readiness is the owner describing
        // itself. Without this the transcript stays "not ready" while every RPC works.
        void this.link
          ?.then(() => this.request("runtime.describe"))
          .then(() => this.markReady())
          .catch(err => this.log(`[startup] runtime.describe failed: ${crop(err instanceof Error ? err.message : String(err))}`))
      } catch (err) {
        if (this.mode !== "ws") return
        this.mode = null
        const message = err instanceof Error ? err.message : String(err)
        this.log(`[startup] attach failed: ${crop(message)}`)
        // The helper's verdict is one or more lines meant for the user (a refusal's remedy, or a
        // start that died); each becomes a transcript line rather than a swallowed stack trace.
        for (const part of message.split("\n").filter(Boolean))
          this.push({ type: "gateway.stderr", payload: { line: part } })
        if (this.sub) this.emit("exit", null)
        else this.exit = null
      }
    })()
    this.attaching = run
    return run
  }

  start() {
    const raw = gatewayUrl()
    const root = this.root()
    const bin = python(root)
    const cwd = process.env.HERMES_CWD || process.cwd()
    const env = { ...process.env } as Record<string, string>
    // Ensure the gateway and agent tools resolve to the user's launch cwd.
    // TERMINAL_CWD is the canonical env var the agent reads for working dir.
    if (!env.TERMINAL_CWD) env.TERMINAL_CWD = cwd
    const pp = env.PYTHONPATH?.trim()
    env.PYTHONPATH = pp ? `${root}${delimiter}${pp}` : root
    env.HERMES_PYTHON_SRC_ROOT = root

    // Reset state
    this.ok = false
    this.buf = []
    // A canonical attach re-satisfies the gate itself; resetting to "missing" here would make a
    // retry look like an unknown backend and block every mutating call until the next describe.
    if (this.mode !== "ws") this.contract = backend.backendContract(null)
    this.exit = undefined
    this.grant = null

    let restarted = false
    const previous = this.proc
    if (previous) {
      this.proc = null
      this.fail(new Error("gateway restarted"))
      restarted = true
      try { previous.kill() } catch {}
    }

    const socket = this.ws
    if (socket) {
      this.ws = null
      this.link = null
      this.target = null
      if (!restarted) this.fail(new Error("gateway restarted"))
      try { socket.close() } catch {}
    }

    if (this.timer) clearTimeout(this.timer)
    if (raw) { this.mode = "ws"; this.connect(raw); return }
    // Hermes ≥0.22 keeps one owner per profile: a second `tui_gateway.entry` is refused with
    // "owned by a running gateway". So the TUI is a client of the profile's gateway over its
    // ticketed WebSocket — and closing the TUI no longer takes the scheduler down with it.
    // HERM_OWN_BACKEND=1 restores the old behaviour (own the profile) as an escape hatch.
    if (!process.env.HERM_OWN_BACKEND) { void this.attach(); return }
    this.mode = "stdio"
    this.timer = setTimeout(() => {
      if (this.ok) return
      this.log(`[startup] timed out (python=${bin}, cwd=${cwd})`)
      this.push({ type: "gateway.start_timeout", payload: { cwd, python: bin } })
      const proc = this.proc
      if (!proc || proc.exitCode !== null) return
      try { proc.kill() }
      catch (err) {
        this.proc = null
        const failure = new Error(`gateway startup timeout: ${err instanceof Error ? err.message : String(err)}`)
        this.fail(failure)
        if (this.sub) this.emit("exit", null)
        else this.exit = null
      }
    }, STARTUP_MS)

    const proc = (() => {
      try {
        return Bun.spawn([bin, "-u", "-m", "tui_gateway.entry"], {
          cwd,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        })
      } catch (err) {
        if (this.timer) { clearTimeout(this.timer); this.timer = null }
        this.proc = null
        const message = err instanceof Error ? err.message : String(err)
        this.log(`[startup] spawn failed: ${message}`)
        this.push({ type: "gateway.stderr", payload: { line: message } })
        if (this.sub) this.emit("exit", null)
        else this.exit = null
        return null
      }
    })()
    if (!proc) return
    this.proc = proc

    // Read stdout lines — Bun returns ReadableStream
    if (proc.stdout) {
      lines(proc.stdout as ReadableStream<Uint8Array>, raw => {
        if (this.proc !== proc) return
        try {
          this.dispatch(JSON.parse(raw), "stdio")
        } catch {
          const preview = raw.trim().slice(0, LOG_PREVIEW) || "(empty)"
          this.log(`[protocol] malformed: ${preview}`)
          this.push({ type: "gateway.protocol_error", payload: { preview } })
        }
      })
    }

    // Read stderr lines
    if (proc.stderr) {
      lines(proc.stderr as ReadableStream<Uint8Array>, raw => {
        if (this.proc !== proc) return
        const line = raw.trim()
        if (!line) return
        this.log(line)
        this.push({ type: "gateway.stderr", payload: { line } })
      })
    }

    // Handle exit — guard against a superseded proc (restart kills the
    // old one, whose exit handler must not touch the new proc's state).
    proc.exited.then(code => {
      if (this.proc !== proc) return
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
      this.fail(new Error(`gateway exited${code === null ? "" : ` (${code})`}`))
      if (this.sub) this.emit("exit", code)
      else this.exit = code
    })
  }

  drain() {
    if (this.sub) return
    this.sub = true
    for (const ev of this.buf.splice(0)) this.emit("event", ev)
    if (this.exit !== undefined) {
      const code = this.exit
      this.exit = undefined
      this.emit("exit", code)
    }
  }

  tail(n = 20): string {
    return this.logs.slice(-Math.max(1, n)).join("\n")
  }

  private sid = ""

  /** Set the active session id; auto-injected into subsequent requests. */
  setSession(sid: string) {
    this.sid = sid
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // Canonical mode has no `desktop_contract` to read, and the gate below runs before any attach
    // can happen — so it must be satisfied here, or the very first prompt is rejected as an
    // unknown backend while the transport is still being negotiated.
    if (this.mode !== "stdio" && !process.env.HERM_OWN_BACKEND) this.adoptCanonicalContract()
    const blocked = backend.contractError(method, this.contract, params)
    if (blocked) return Promise.reject(blocked)
    const raw = gatewayUrl()
    if (raw) return this.remote<T>(raw, method, params)
    // Local profile: the ticket is fetched once per start(); a request that lands during startup
    // waits for it instead of racing, so the very first session.create still finds a transport.
    if (this.mode === "ws" || (!this.proc && !process.env.HERM_OWN_BACKEND)) {
      if (!this.grant) {
        const wait = this.attaching ?? (this.start(), this.attaching)
        if (!wait) return Promise.reject(new Error("gateway not ready"))
        return wait.then(() => {
          if (!this.grant) throw new Error("gateway attach failed")
          return this.remote<T>(this.grant.url, method, params)
        })
      }
      return this.remote<T>(this.grant.url, method, params)
    }
    if (!this.proc || this.proc.exitCode !== null) this.start()

    const stdin = this.proc?.stdin
    if (!stdin || typeof stdin === "number") return Promise.reject(new Error("gateway not running"))

    const rid = `r${++this.id}`
    const writer = stdin as { write(data: string | Uint8Array): number }
    const merged = this.sid && params.session_id === undefined && this.declared.session.has(method)
      ? { session_id: this.sid, ...params }
      : params

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(rid)) reject(new Error(`timeout: ${method}`))
      }, REQUEST_MS)

      this.pending.set(rid, {
        reject: e => { clearTimeout(timeout); reject(e) },
        resolve: v => { clearTimeout(timeout); resolve(v as T) },
      })

      try {
        const frame = encode({ jsonrpc: "2.0", id: rid, method, params: merged })
        if (frame.issues.length) {
          const detail = frame.issues.map(x => `${x.path}:${x.count}`).join(", ")
          this.log(`[wire] sanitized invalid unicode for ${method}: ${detail}`)
        }
        writer.write(frame.text + "\n")
      } catch (e) {
        clearTimeout(timeout)
        this.pending.delete(rid)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** Which methods take `session_id` on the canonical socket (extra="forbid" elsewhere). */
  private static readonly CANONICAL_SESSION = new Set([
    "prompt.submit",
    "prompt.cancel",
    "session.interrupt",
    "session.mutate",
    "session.history",
    "session.steer",
    "session.redirect",
  ])

  /** Methods whose canonical contract also demands the execution generation (an integer). */
  private static readonly CANONICAL_GENERATION = new Set([
    "session.steer",
    "session.redirect",
    "session.mutate",
    "session.interrupt",
  ])

  /** Admission identity. The canonical socket refuses `prompt.submit` with `invalid_params`
   *  when `input_id` is missing, and with `permission_denied` when the session is not named.
   *  `session_id` is injected ONLY for methods whose contract accepts it: elsewhere the strict
   *  decoder answers `invalid_params` (that is what broke `session.list`). */
  private admitParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...params }
    const canonical = this.mode !== "stdio"
    const wantsSession = canonical
      ? GatewayClient.CANONICAL_SESSION.has(method)
      : this.declared.session.has(method)
    if (out.session_id === undefined && this.sid && wantsSession) out.session_id = this.sid
    if (canonical && GatewayClient.CANONICAL_GENERATION.has(method)
        && out.execution_generation === undefined && this.generation !== null)
      out.execution_generation = this.generation
    if (canonical && method === "prompt.submit"
        && out.input_id === undefined && out.submission_id === undefined)
      out.input_id = crypto.randomUUID()
    // The canonical snapshot ships an EMPTY `messages` unless the display projection is asked
    // for (measured: 0 vs 746 rows on the same session). Without this a resumed session keeps its
    // context but the transcript has nothing to draw.
    if (canonical && method === "session.resume" && out.display_projection === undefined)
      out.display_projection = true
    return out
  }

  /** The canonical socket has no `session.activate`: attaching to a session is `session.resume`
   *  (same payload, and it accepts either the runtime id or the stored key). */
  private wireMethod(method: string): string {
    if (this.mode === "stdio") return method
    return method === "session.activate" ? "session.resume" : method
  }

  private remote<T>(raw: string, method: string, params: Record<string, unknown>): Promise<T> {
    const blocked = backend.contractError(method, this.contract, params)
    if (blocked) return Promise.reject(blocked)
    try { websocketUrl(raw) }
    catch (err) { return Promise.reject(err instanceof Error ? err : new Error(String(err))) }
    if (this.target !== raw || (!this.ws && !this.attaching) || this.ws?.readyState === WS_CLOSING || this.ws?.readyState === WS_CLOSED)
      this.start()

    const wire = this.wireMethod(method)
    const rid = `r${++this.id}`
    const merged = this.admitParams(wire, params)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(rid)) reject(new Error(`timeout: ${method}`))
      }, REQUEST_MS)
      this.pending.set(rid, {
        reject: e => { clearTimeout(timeout); reject(e) },
        resolve: value => { clearTimeout(timeout); resolve(value as T) },
      })

      const send = async () => {
        try {
          // A request issued while the ticket was still being fetched waits here, not fails.
          if (this.attaching) await this.attaching
          if (this.ws?.readyState === WS_CONNECTING) await this.link
          if (!this.pending.has(rid)) return
          if (!this.ws || this.ws.readyState !== WS_OPEN) throw new Error(`gateway not connected: ${method}`)
          const frame = encode({ jsonrpc: "2.0", id: rid, method: wire, params: merged })
          if (frame.issues.length) {
            const detail = frame.issues.map(x => `${x.path}:${x.count}`).join(", ")
            this.log(`[wire] sanitized invalid unicode for ${method}: ${detail}`)
          }
          this.ws.send(frame.text)
        } catch (err) {
          clearTimeout(timeout)
          if (this.pending.delete(rid)) reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
      void send()
    })
  }

  kill() {
    this.proc?.kill()
    const ws = this.ws
    if (!ws) return
    this.ws = null
    this.link = null
    this.target = null
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.fail(new Error("gateway websocket closed"))
    try { ws.close() } catch {}
  }

  get ready(): boolean {
    return this.ok
  }

  /** The contract this client actually operates under: canonical attach satisfies the legacy
   *  gate, so the UI must read this instead of a stale value from startup events. */
  get backendContract() {
    return this.contract
  }
}
