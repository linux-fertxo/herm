import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"

describe("live session event routing", () => {
  // El boot resuelve la sesión en la RESPUESTA del RPC y el evento `session.info` no
  // llega en ese camino: si el cliente no marca ready, el composer se queda en
  // «Connecting...» para siempre aunque el chat funcione. El mock por defecto empuja
  // `session.info` en start(), que es justo lo que el gateway real NO hace aquí.
  test("bare launch deja la sesión lista (sin Connecting... eterno)", async () => {
    const gw = new MockGateway()
    gw.start = () => { gw.ok = true; gw.push({ type: "gateway.ready" }) }
    const t = await mount({ gw, launch: { mode: "new", splash: false } })
    await until(t, () => t.frame().includes("Ready"))
    expect(t.frame()).not.toContain("Connecting...")
    t.destroy()
  })

  // Medido por el socket canónico con deepseek-flash: un turno con herramientas puede
  // emitir CERO reasoning.delta (el texto va como thinking.delta, que es el spinner) y
  // entregar todo el razonamiento en message.complete.reasoning. Sin esa rama la
  // pestaña reasoning de la cajita queda vacía para siempre.
  test("el razonamiento que llega en message.complete se pinta en la cajita", async () => {
    const gw = new MockGateway({
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-r", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    act(() => {
      t.gw.push({ type: "message.start", session_id: "sid-r" })
      t.gw.push({ type: "tool.start", session_id: "sid-r", payload: { tool_id: "t1", name: "terminal", context: "uptime" } })
      t.gw.push({ type: "tool.complete", session_id: "sid-r", payload: { tool_id: "t1", summary: "ok" } })
      t.gw.push({
        type: "message.complete", session_id: "sid-r",
        payload: { text: "La carga es baja.", reasoning: "RAZONAMIENTO-SOLO-EN-EL-CIERRE" },
      })
    })
    // Un turno nuevo abre la cajita; el último assistant es el anterior, con su thinking.
    act(() => { t.gw.push({ type: "message.start", session_id: "sid-r" }) })
    await until(t, () => t.frame().includes("RAZONAMIENTO-SOLO-EN-EL-CIERRE"))
    t.destroy()
  })

  test("ignores sibling session stream events after activating another session", async () => {
    const gw = new MockGateway({
      "session.resume": p => ({
        session_id: p.session_id,
        messages: p.session_id === "sid-b"
          ? [{ role: "user", content: "Question B", timestamp: 1 }]
          : [],
      }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-b", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => {
      t.gw.push({ type: "message.start", session_id: "sid-b" })
      t.gw.push({ type: "message.delta", session_id: "sid-b", payload: { text: "B is streaming" } })
      t.gw.push({ type: "message.start", session_id: "sid-a" })
      t.gw.push({ type: "message.delta", session_id: "sid-a", payload: { text: "LATE_FROM_A" } })
      t.gw.push({ type: "status.update", session_id: "sid-a", payload: { text: "A is still running", kind: "lifecycle" } })
      t.gw.push({ type: "message.complete", session_id: "sid-a", payload: { text: "DONE_A" } })
    })
    await until(t, () => t.frame().includes("B is streaming"))

    expect(t.frame()).not.toContain("LATE_FROM_A")
    expect(t.frame()).not.toContain("DONE_A")
    expect(t.frame()).not.toContain("A is still running")
    expect(t.frame()).not.toContain("Ready")
    t.destroy()
  })

  test("ignores sibling process notifications while stream events stay scoped", async () => {
    const gw = new MockGateway({
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-b", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    act(() => {
      t.gw.push({ type: "message.start", session_id: "sid-b" })
      t.gw.push({ type: "message.delta", session_id: "sid-b", payload: { text: "B is streaming" } })
      t.gw.push({
        type: "status.update",
        session_id: "sid-a",
        payload: {
          kind: "process",
          text: "Background process proc_watch completed (exit code 0).\nCommand: watch-kanban",
        },
      })
    })
    await until(t, () => t.frame().includes("B is streaming"))

    expect(t.frame()).not.toContain("proc_watch")
    expect(t.frame()).not.toContain("watch-kanban")
    t.destroy()
  })


  test("sibling background completion clears badge without writing into active transcript", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/background", "run in background"]] }),
      "prompt.background": () => ({ task_id: "bg-42" }),
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-b", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/background do the thing") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("▶ 1"))

    act(() => t.gw.push({
      type: "background.complete",
      session_id: "sid-a",
      payload: { task_id: "bg-42", text: "done elsewhere" },
    }))
    await until(t, () => !t.frame().includes("▶ 1"))

    expect(t.frame()).not.toContain("done elsewhere")
    t.destroy()
  })

  test("session.title updates active title without transcript noise", async () => {
    const gw = new MockGateway({
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-b", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.gw.push({
      type: "session.title",
      payload: { session_id: "sid-b", title: "Generated B" },
    }))
    await until(t, () => /Title\s+Generated B/.test(t.frame()))

    expect(t.frame()).not.toContain("session.title")
    t.destroy()
  })

  test("session.title ignores missing and inactive payloads", async () => {
    const gw = new MockGateway({
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-b", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.gw.push({
      type: "session.title",
      payload: { session_id: "sid-b", title: "Fixture Active Title" },
    }))
    await until(t, () => t.frame().includes("Fixture Active Title"))

    act(() => {
      t.gw.push({ type: "session.title", payload: { title: "Missing Session Fixture" } })
      t.gw.push({ type: "session.title", payload: { session_id: "sid-b" } })
      t.gw.push({ type: "session.title", payload: { session_id: "sid-a", title: "Sibling Session Fixture" } })
    })
    await t.settle()

    expect(t.frame()).toContain("Fixture Active Title")
    expect(t.frame()).not.toContain("Missing Session Fixture")
    expect(t.frame()).not.toContain("Sibling Session Fixture")
    t.destroy()
  })
})
