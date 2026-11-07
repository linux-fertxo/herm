// Session-scoped model switch over the canonical gateway. The old
// `config.set {key:"model"}` verb is refused with `use_session_mutation_model`:
// a model pick is a revision-fenced `session.mutate operation=model`, with the
// spent MAD tuple (revision + generation) read from the row it will write.

import { sdb } from "./sessions-db"
import type { Gateway } from "../context/gateway"

export type ModelSwitchResult = {
  model?: string
  provider?: string
  status?: "applied" | "deferred" | "confirmation_required"
  confirm?: string
  confirm_message?: string
  target_model?: string
}

/** Parse `/model <arg>` into `{model, provider?}`. Unknown flags are dropped;
 *  the caller reports them. Mirrors the canonical `modelPayload` grammar minus
 *  `--reasoning` (herm has no reasoning level in the model path). */
export function parseModelArg(arg: string): { model: string; provider?: string } {
  const parts = arg.trim().split(/\s+/)
  const model = parts.shift() ?? ""
  const out: { model: string; provider?: string } = { model }
  while (parts.length) {
    const flag = parts.shift()!
    if (flag === "--provider" && parts[0] && !parts[0].startsWith("--")) out.provider = parts.shift()
    // --global / --session / --reasoning ignored at this layer
  }
  return out
}

/** Ask the gateway to switch the live session to *arg* (grammar of `/model`).
 *  Needs the durable session id (`resumeId`) whose state.db row carries the
 *  fence; throws when that row is absent (gateway-only session). */
export async function switchSessionModel(gw: Gateway, sid: string, arg: string): Promise<ModelSwitchResult> {
  const f = sdb.fence(sid)
  if (!f) throw new Error("no local session row to fence the model switch")
  const { model, provider } = parseModelArg(arg)
  if (!model) throw new Error("model required")
  const payload: Record<string, string> = { model }
  if (provider) payload.provider = provider
  return gw.request<ModelSwitchResult>("session.mutate", {
    session_id: sid,
    request_id: crypto.randomUUID(),
    expected_revision: f.revision,
    expected_generation: f.generation,
    operation: "model",
    payload,
  })
}
