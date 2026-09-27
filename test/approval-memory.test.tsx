import { beforeEach, describe, expect, test } from "bun:test"
import { act, createRef } from "react"
import { mount, mountNode, until, MockGateway } from "./harness"
import * as prefs from "../src/context/preferences"
import { PromptCard, type PromptCardHandle } from "../src/components/chat/PromptCard"
import type { NeverPrompt } from "../src/context/preferences"
import type { PromptPart, PromptReq } from "../src/types/message"

type ApprovalReq = Extract<PromptReq, { variant: "approval" }>

let hn = 0
const req = (over: Partial<ApprovalReq> = {}): ApprovalReq => ({
  variant: "approval",
  request_id: `srq-h${++hn}`,
  command: "rm -rf /tmp/a",
  description: "Run dangerous command?",
  ...over,
})

const part = (over: Partial<ApprovalReq> = {}): PromptPart => ({
  type: "prompt",
  id: "approval-test",
  variant: "approval",
  req: req(over),
})

const prefsAny = prefs as typeof prefs & {
  get: (key: "neverPrompts") => NeverPrompt[] | undefined
  set: (key: "neverPrompts", value: NeverPrompt[]) => void
}

const choices = (gw: MockGateway) => gw.answers.map(a => a.result.choice)

beforeEach(() => {
  prefs.reset()
  prefsAny.set("neverPrompts", [])
})

describe("approval memory", () => {
  test("normal approval prompt path answers once when no memory exists", async () => {
    const gw = new MockGateway(); gw.ok = true
    const ref = createRef<PromptCardHandle>()
    const p = part({ pattern_keys: ["rm_recursive"] })
    gw.ask$(p.req.request_id)
    await using t = await mountNode(
      <PromptCard ref={ref} part={p} onAnswer={() => {}} />,
      { gw },
    )

    expect(t.frame()).toContain("Permission required")
    expect(t.frame()).toContain("$ rm -rf /tmp/a")
    expect(gw.answers).toEqual([])

    act(() => ref.current!.feed({ name: "1" } as never))
    await t.settle()

    expect(gw.answers).toEqual([{ id: p.req.request_id, result: { choice: "once" } }])
    expect(prefsAny.get("neverPrompts")).toEqual([])
  })

  test("stores never_prompts for a specific question and pattern_keys-derived subject", async () => {
    const gw = new MockGateway(); gw.ok = true
    const ref = createRef<PromptCardHandle>()
    const p = part({ pattern_keys: ["rm_recursive", "tmp_write"] })
    gw.ask$(p.req.request_id)
    await using t = await mountNode(
      <PromptCard ref={ref} part={p} onAnswer={() => {}} />,
      { gw },
    )

    act(() => ref.current!.feed({ name: "3" } as never))
    await t.settle()

    // "never ask again" also resolves the other pending prompts of the turn.
    expect(gw.answers).toEqual([{ id: p.req.request_id, result: { choice: "always", all: true } }])
    expect(prefsAny.get("neverPrompts")).toEqual([
      { group: "approval", question: "Run dangerous command?", subject: "rm_recursive|tmp_write" },
    ])
  })

  test("reuses memory for the same question and pattern_keys-derived subject", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => {
      t.gw.ask$("srq-i1")
      t.gw.push({
        type: "approval.request",
        payload: { request_id: "srq-i1", command: "rm -rf /tmp/a", description: "Run dangerous command?", pattern_keys: ["rm_recursive", "tmp_write"] },
      })
    })
    await t.settle()
    act(() => t.keys.pressKey("3"))
    await t.settle()

    act(() => {
      t.gw.ask$("srq-i2")
      t.gw.push({
        type: "approval.request",
        payload: { request_id: "srq-i2", command: "rm -rf /tmp/b", description: "Run dangerous command?", pattern_keys: ["rm_recursive", "tmp_write"] },
      })
    })
    await t.settle()

    expect(choices(t.gw)).toEqual(["always", "always"])
    expect(t.gw.answers.at(-1)?.result.all).toBe(true)
    expect(t.frame()).not.toContain("$ rm -rf /tmp/b")
    t.destroy()
  })

  test("a remembered approval the backend no longer waits on restores the card", async () => {
    prefsAny.set("neverPrompts", [
      { group: "approval", question: "Run dangerous command?", subject: "rm_recursive|tmp_write" },
    ])
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    // Not `ask$`ed: the frame is gone by the time the memory auto-answer runs.
    act(() => t.gw.push({
      type: "approval.request",
      payload: { request_id: "srq-i3", command: "rm -rf /tmp/retry", description: "Run dangerous command?", pattern_keys: ["rm_recursive", "tmp_write"] },
    }))

    // Silence is the failure this guards: the user must be told the remembered
    // answer went nowhere, and the card has to come back to be answered by hand.
    await until(t, () => t.frame().includes("$ rm -rf /tmp/retry") && t.frame().includes("no longer open"))
    expect(t.gw.answers).toEqual([])
    t.destroy()
  })

  test("does not reuse memory for a different question or different subject", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => {
      t.gw.ask$("srq-i5")
      t.gw.push({
        type: "approval.request",
        payload: { request_id: "srq-i5", command: "rm -rf /tmp/a", description: "Run dangerous command?", pattern_keys: ["rm_recursive", "tmp_write"] },
      })
    })
    await t.settle()
    act(() => t.keys.pressKey("3"))
    await t.settle()

    act(() => {
      t.gw.ask$("srq-i6")
      t.gw.push({
        type: "approval.request",
        payload: { request_id: "srq-i6", command: "rm -rf /tmp/b", description: "Run package manager?", pattern_keys: ["rm_recursive", "tmp_write"] },
      })
    })
    await t.settle()
    expect(t.gw.answers).toHaveLength(1)
    expect(t.frame()).toContain("Run package manager?")
    act(() => t.keys.pressEscape())
    await t.settle()

    act(() => {
      t.gw.ask$("srq-i7")
      t.gw.push({
        type: "approval.request",
        payload: { request_id: "srq-i7", command: "cat /tmp/a", description: "Run dangerous command?", pattern_keys: ["tmp_read"] },
      })
    })
    await t.settle()
    expect(t.gw.answers).toHaveLength(2)
    expect(t.frame()).toContain("$ cat /tmp/a")
    t.destroy()
  })

  test("falls back to command as subject when approval.request.pattern_keys is missing", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => {
      t.gw.ask$("srq-i8")
      t.gw.push({
        type: "approval.request",
        payload: { request_id: "srq-i8", command: "bun add zod", description: "Run package manager?" },
      })
    })
    await t.settle()
    expect(t.frame()).toContain("subject: bun add zod")
    act(() => t.keys.pressKey("3"))
    await t.settle()

    act(() => {
      t.gw.ask$("srq-i9")
      t.gw.push({
        type: "approval.request",
        payload: { request_id: "srq-i9", command: "bun add zod", description: "Run package manager?" },
      })
    })
    await t.settle()
    expect(t.gw.answers).toHaveLength(2)

    act(() => t.gw.push({
      type: "approval.request",
      payload: { request_id: "srq-i10", command: "bun update zod", description: "Run package manager?" },
    }))
    await t.settle()
    expect(t.gw.answers).toHaveLength(2)
    expect(t.frame()).toContain("$ bun update zod")
    t.destroy()
  })

  test("resolve_all memory is scoped by group", async () => {
    prefsAny.set("neverPrompts", [
      { group: "slash", question: "Run dangerous command?", subject: "rm_recursive" },
    ])
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.gw.push({
      type: "approval.request",
      payload: { request_id: "srq-i11", command: "rm -rf /tmp/a", description: "Run dangerous command?", pattern_keys: ["rm_recursive"] },
    }))
    await t.settle()

    expect(t.gw.answers).toEqual([])
    expect(t.frame()).toContain("Permission required")
    t.destroy()
  })
})
