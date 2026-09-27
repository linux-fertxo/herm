import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"
import type { GatewayEvent } from "../src/context/wire"

describe("prompts", () => {

  async function expires(ev: GatewayEvent, id: string, visible: string, closed: string) {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({ type: "message.start" }))
    act(() => { t.gw.ask$(id); t.gw.push(ev) })
    await until(t, () => t.frame().includes(visible))

    act(() => t.gw.push({
      type: "message.complete",
      payload: { text: "PROMPT_EXPIRED_DONE_SENTINEL", usage: { input: 0, output: 0, total: 0 } },
    }))
    await until(t, () => t.frame().includes("Timed out") && !t.frame().includes(closed))

    act(() => t.keys.pressKey("1"))
    await t.settle()
    expect(t.gw.answers).toEqual([])
    t.destroy()
  }

  test("clarify: open-ended (no choices) free-text input", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => { t.gw.ask$("q2"); t.gw.push({
      type: "clarify.request",
      payload: { request_id: "q2", question: "explain?", choices: null },
    }) })
    await t.settle()
    expect(t.frame()).toContain("explain?")

    await act(async () => { await t.keys.typeText("my custom answer") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(t.gw.answers).toEqual([{ id: "q2", result: { answer: "my custom answer" } }])
    t.destroy()
  })


  test("sudo: escape cancels with empty password", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => { t.gw.ask$("su1"); t.gw.push({ type: "sudo.request", payload: { request_id: "su1" } }) })
    await t.settle()
    expect(t.frame()).toContain("Sudo required")

    act(() => t.keys.pressEscape())
    await t.settle()
    expect(t.gw.answers).toEqual([{ id: "su1", result: { value: "" } }])
    expect(t.frame()).not.toContain("Sudo required")
    t.destroy()
  })

  async function withdrawn(ev: GatewayEvent, id: string, visible: string, closed: string) {
    const gw = new MockGateway()
    const t = await mount({ gw })
    await until(t, () => gw.ready && t.frame().includes("Ready"))
    act(() => { gw.ask$(id); gw.push(ev) })
    await until(t, () => t.frame().includes(visible))

    // The backend gave up on its own question (deadline, or a reconnect that
    // dropped the open frame). Answering must report that instead of latching
    // the card into a success it never had.
    gw.withdraw$(id)
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("no longer open"))
    expect(gw.answers).toEqual([])
    expect(t.frame()).toContain(visible)

    // A reconnect replay re-delivers the question still waiting for an answer,
    // so the very same card becomes answerable again.
    gw.ask$(id)
    act(() => t.keys.pressEnter())
    await until(t, () => !t.frame().includes(closed))
    expect(gw.answers).toHaveLength(1)
    expect(t.frame()).not.toContain("no longer open")
    t.destroy()
  }

  test("withdrawn approval keeps the card answerable and never reports success", async () => {
    await withdrawn(
      { type: "approval.request", payload: { request_id: "srq-w1", command: "rm x", description: "delete" } },
      "srq-w1", "Permission required", "Permission required",
    )
  })

  test("withdrawn clarify choice keeps the question answerable", async () => {
    await withdrawn(
      { type: "clarify.request", payload: { request_id: "q-retry", question: "retry choice?", choices: ["yes", "no"] } },
      "q-retry", "retry choice?", "Other (type your answer)",
    )
  })

  test("withdrawn secret keeps the masked value for retry", async () => {
    const gw = new MockGateway()
    const t = await mount({ gw })
    await until(t, () => gw.ready && t.frame().includes("Ready"))
    act(() => { gw.ask$("s-retry"); gw.push({
      type: "secret.request",
      payload: { request_id: "s-retry", prompt: "token?", env_var: "TOKEN" },
    }) })
    await until(t, () => t.frame().includes("Secret: TOKEN"))
    await act(async () => { await t.keys.typeText("hunter2") })

    gw.withdraw$("s-retry")
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("no longer open"))
    expect(gw.answers).toEqual([])
    // The masked value survives, so a re-delivered question needs no retyping.
    expect(t.frame()).toContain("•".repeat(7))

    gw.ask$("s-retry")
    act(() => t.keys.pressEnter())
    await until(t, () => !t.frame().includes("Secret: TOKEN"))
    expect(gw.answers).toEqual([{ id: "s-retry", result: { value: "hunter2" } }])
    t.destroy()
  })

  test("clarify prompt expires on message.complete and cannot answer later", async () => {
    await expires({
      type: "clarify.request",
      payload: { request_id: "clarify-exp", question: "EXPIRING_CLARIFY_SENTINEL", choices: ["yes"] },
    }, "clarify-exp", "EXPIRING_CLARIFY_SENTINEL", "Other (type your answer)")
  })

  test("sudo prompt expires on message.complete and cannot answer later", async () => {
    await expires(
      { type: "sudo.request", payload: { request_id: "sudo-exp" } },
      "sudo-exp", "Sudo required", "Enter your password",
    )
  })

  test("secret prompt expires on message.complete and cannot answer later", async () => {
    await expires({
      type: "secret.request",
      payload: { request_id: "secret-exp", prompt: "SECRET_PROMPT_SHOULD_DISAPPEAR", env_var: "EXPIRING_TOKEN" },
    }, "secret-exp", "Secret: EXPIRING_TOKEN", "SECRET_PROMPT_SHOULD_DISAPPEAR")
  })

  test("terminal-read prompt expires on message.complete and cannot answer later", async () => {
    await expires({
      type: "terminal.read.request",
      payload: { request_id: "term-exp", start: 10, count: 20 },
    }, "term-exp", "Terminal read required", "Enter/Esc returns empty")
  })
})

describe("diagnostics", () => {
  test("errorish gateway.stderr surfaces in transcript", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    const feed: GatewayEvent[] = [
      { type: "gateway.stderr", payload: { line: "DEBUG loaded tools" } },           // benign → hidden
      { type: "gateway.stderr", payload: { line: "Traceback (most recent call last):" } },
      { type: "gateway.stderr", payload: { line: "⚠️  API call failed (HTTP 404)" } },
    ]
    act(() => { for (const ev of feed) t.gw.push(ev) })
    await t.settle()

    const f = t.frame()
    expect(f).toContain("Traceback")
    expect(f).toContain("API call failed")
    expect(f).not.toContain("DEBUG loaded tools")
    t.destroy()
  })

  test("/logs opens dialog showing full stderr tail", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    act(() => {
      t.gw.push({ type: "gateway.stderr", payload: { line: "line one benign" } })
      t.gw.push({ type: "gateway.stderr", payload: { line: "line two ERROR: boom" } })
    })
    await t.settle()

    await act(async () => { await t.keys.typeText("/logs") })
    await t.settle()
    act(() => t.keys.pressEnter())
    // stickyStart="bottom" scrollbox: pass 1 measures scrollHeight,
    // pass 2 applies the offset. Two settles, not until() polling.
    await t.settle()
    await t.settle()

    const f = t.frame()
    expect(f).toContain("Gateway Logs")
    // benign line NOT in transcript but IS in logs dialog
    expect(f).toContain("line one benign")
    expect(f).toContain("line two ERROR: boom")
    t.destroy()
  })
})
