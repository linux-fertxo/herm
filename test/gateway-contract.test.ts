import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadContract, wants } from "../src/context/gateway-contract"

// The artifact path Hermes renders its contract to, relative to the agent root.
const ARTIFACT = join("apps", "shared", "src", "gateway-contract.openrpc.json")

const artifact = {
  methods: [
    { name: "ping", params: [] },
    { name: "session.create", params: [] },
    { name: "prompt.submit", params: [{ schema: { $ref: "#/components/schemas/PromptParams" } }] },
    {
      name: "session.resume",
      params: [{ schema: { allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { session_id: { type: "string" } } }] } }],
    },
  ],
  components: {
    schemas: {
      PromptParams: { properties: { session_id: { type: "string" }, text: { type: "string" } } },
      Base: { properties: { profile: { type: "string" } } },
    },
  },
  "x-server-requests": [{ name: "clarify" }, { name: "approval" }],
  "x-notifications": [{ name: "gateway.ready" }],
}

const root = (name: string) => mkdtempSync(join(tmpdir(), `herm-contract-${name}-`))

const seed = (dir: string, body: string | null) => {
  if (body === null) return dir
  mkdirSync(join(dir, "apps", "shared", "src"), { recursive: true })
  writeFileSync(join(dir, ARTIFACT), body)
  return dir
}

describe("gateway contract", () => {
  test("derives the session-scoped set from the artifact's declared params", () => {
    const dir = seed(root("artifact"), JSON.stringify(artifact))

    try {
      const wire = loadContract(dir)

      expect(wire.source).toBe("artifact")
      expect(wire.methods.size).toBe(4)
      // `session_id` sits one $ref / allOf level down, so a shallow read of the
      // method's own schema would gate these two out and re-break the wire.
      expect([...wire.session].sort()).toEqual(["prompt.submit", "session.resume"])
      expect(wire.requests.has("clarify")).toBe(true)
      expect(wire.events.has("gateway.ready")).toBe(true)

      // The gate's whole job: inject on the declared methods, withhold elsewhere.
      // Injecting on `ping` is what Hermes answers `4000 invalid params`.
      expect(wants(wire, "prompt.submit")).toBe(true)
      expect(wants(wire, "ping")).toBe(false)
      expect(wants(wire, "session.create")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to the embedded set when the install ships no artifact", () => {
    const dir = root("missing")

    try {
      const wire = loadContract(dir)

      expect(wire.source).toBe("embedded")
      expect(wants(wire, "ping")).toBe(false)
      expect(wants(wire, "learning.frames")).toBe(false)
      expect(wants(wire, "prompt.submit")).toBe(true)
      expect(wants(wire, "session.resume")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("keeps a corrupt artifact from taking the client down at boot", () => {
    const dir = seed(root("corrupt"), "{ not json")

    try {
      expect(loadContract(dir).source).toBe("embedded")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
