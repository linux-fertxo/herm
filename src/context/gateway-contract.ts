import { existsSync, readFileSync } from "fs"
import { join } from "path"

/**
 * Hermes declares every gateway method in `tui_gateway/contracts/` and renders the
 * declarations to `apps/shared/src/gateway-contract.openrpc.json`. Reading that
 * artifact is what keeps this client honest about which methods accept `session_id`:
 * a hand-maintained list drifts the moment Hermes adds a method, and every params
 * model is `extra="forbid"`, so an injected key on a method that never declared it
 * is answered with `4000 invalid params` instead of being ignored.
 *
 * The artifact ships only with a git install, hence the embedded fallback set —
 * the last-known-good session-scoped names for layouts that never generate it.
 * `source` says which one answered, so a mismatch is diagnosable instead of silent.
 */

const ARTIFACT = join("apps", "shared", "src", "gateway-contract.openrpc.json")

// Methods whose declared params carry `session_id`, as of hermes-agent 2026.9.24
// (contract 8). Regenerate from the artifact whenever it reports a different set.
const EMBEDDED = new Set([
  "approval.pending",
  "approval.received",
  "approval.respond",
  "billing.step_up",
  "browser.controller.detach",
  "browser.controller.heartbeat",
  "browser.controller.register",
  "browser.controller.result",
  "browser.manage",
  "clipboard.paste",
  "command.dispatch",
  "commands.catalog",
  "complete.path",
  "complete.slash",
  "config.get",
  "config.set",
  "file.attach",
  "handoff.fail",
  "handoff.request",
  "handoff.state",
  "image.attach",
  "image.attach_bytes",
  "image.detach",
  "input.detect_drop",
  "llm.oneshot",
  "mcp.servers.oauth.callback",
  "mcp.servers.oauth.cancel",
  "mcp.servers.oauth.poll",
  "message.react",
  "model.disconnect",
  "model.options",
  "model.save_key",
  "pdf.attach",
  "preview.restart",
  "process.kill",
  "process.list",
  "process.stop",
  "prompt.background",
  "prompt.btw",
  "prompt.submit",
  "reload.mcp",
  "rollback.diff",
  "rollback.list",
  "rollback.restore",
  "session.activate",
  "session.branch",
  "session.branch_whole",
  "session.close",
  "session.compress",
  "session.context_breakdown",
  "session.control",
  "session.control.read",
  "session.cwd.set",
  "session.delete",
  "session.events.since",
  "session.history",
  "session.interrupt",
  "session.redirect",
  "session.resume",
  "session.save",
  "session.set_hidden",
  "session.status",
  "session.steer",
  "session.title",
  "session.undo",
  "session.usage",
  "skills.reload",
  "slash.exec",
  "spawn_tree.list",
  "spawn_tree.save",
  "subagent.interrupt",
  "subagent.list",
  "subagent.steer",
  "subagent.tail",
  "terminal.resize",
  "tools.configure",
  "tools.list",
  "tools.show",
  "toolsets.list",
  "verification.status",
  "voice.record",
  "wake.start",
])

export type Wire = {
  /** "artifact" = read from the installed Hermes; "embedded" = fallback set. */
  source: "artifact" | "embedded"
  methods: Set<string>
  /** Methods whose declared params carry `session_id` — the injection gate. */
  session: Set<string>
  /** Server→client request methods: the backend asks, the client answers by frame id. */
  requests: Set<string>
  /** Notification names the backend may emit. */
  events: Set<string>
}

type Raw = Record<string, unknown>

const cache = new Map<string, Wire>()

function box(raw: unknown): Raw {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Raw) : {}
}

function named(list: unknown): string[] {
  return (Array.isArray(list) ? list : [])
    .map(entry => box(entry).name)
    .filter((name): name is string => typeof name === "string")
}

/** Every property a params/result schema declares, following `$ref` and the
 *  composition keywords — Hermes nests the session-scoped params one level down. */
function props(schema: unknown, schemas: Raw, depth = 0): Set<string> {
  if (depth > 6) return new Set()
  const node = box(schema)
  const ref = typeof node.$ref === "string" ? node.$ref.split("/").pop() : undefined
  const target = ref ? box(schemas[ref]) : node
  const out = new Set(Object.keys(box(target.properties)))
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const parts = target[key]
    if (!Array.isArray(parts)) continue
    for (const part of parts) for (const name of props(part, schemas, depth + 1)) out.add(name)
  }
  return out
}

function read(raw: Raw): Wire {
  const schemas = box(box(raw.components).schemas)
  const session = new Set<string>()
  for (const entry of Array.isArray(raw.methods) ? raw.methods : []) {
    const method = box(entry)
    if (typeof method.name !== "string") continue
    const params = Array.isArray(method.params) ? method.params : []
    const keys = params.flatMap(param => [...props(box(param).schema, schemas)])
    if (keys.includes("session_id")) session.add(method.name)
  }
  return {
    source: "artifact",
    methods: new Set(named(raw.methods)),
    session,
    requests: new Set(named(raw["x-server-requests"])),
    events: new Set(named(raw["x-notifications"])),
  }
}

function embedded(): Wire {
  return { source: "embedded", methods: new Set(), session: new Set(EMBEDDED), requests: new Set(), events: new Set() }
}

/** A malformed artifact degrades to the embedded set: the wire contract is
 *  advisory to the UI, and a bad JSON file must not take the TUI down at boot. */
function parse(text: string): Wire {
  try {
    return read(box(JSON.parse(text)))
  } catch {
    return embedded()
  }
}

export function loadContract(root: string): Wire {
  const hit = cache.get(root)
  if (hit) return hit
  const file = join(root, ARTIFACT)
  const wire = existsSync(file) ? parse(readFileSync(file, "utf8")) : embedded()
  cache.set(root, wire)
  return wire
}

/** Whether `method`'s declared params take a `session_id`. */
export function wants(wire: Wire, method: string): boolean {
  return wire.session.has(method)
}

export function resetContractForTests(): void {
  cache.clear()
}

export * as contract from "./gateway-contract"
