import { describe, test, expect } from "bun:test"
import { act, useState } from "react"
import { mountNode, until } from "./harness"
import { ThoughtCloud } from "../src/components/chat/ThoughtCloud"
import type { Message } from "../src/types/message"

describe("ThoughtCloud reasoning", () => {
  test("renders reasoning as markdown while tools stay custom rows", async () => {
    const messages: Message[] = [{
      id: "a1", role: "assistant", timestamp: 0,
      parts: [
        { type: "thinking", content: "Use `scan_skill_commands()` then **verify**.", streaming: false },
        { type: "tool", id: "tw", name: "write_file", args: "", preview: "src/x.ts", status: "done", duration: 9 },
      ],
    }]
    const t = await mountNode(
      <box flexDirection="column" width="100%" height="100%">
        <ThoughtCloud height={12} messages={messages} onResize={() => {}} />
      </box>,
      { width: 100, height: 20 },
    )
    await until(t, () => t.frame().includes("Use scan_skill_commands() then verify."))
    expect(t.frame()).not.toContain("`scan_skill_commands()`")
    expect(t.frame()).not.toContain("**verify**")

    const rows = t.frame().split("\n")
    const y = rows.findIndex(row => row.includes("reasoning") && row.includes("tools"))
    const x = rows[y].indexOf("tools")
    await act(async () => { await t.mouse.pressDown(x, y) })
    await until(t, () => t.frame().includes("src/x.ts"))
    expect(t.frame()).toContain("src/x.ts")
    t.destroy()
  })

  // Regresión: los proveedores que no streamean el reasoning (DeepSeek manda un
  // único `reasoning.available` DESPUÉS de los tool calls) dejaban la cajita
  // clavada en el panel de tools y el reasoning no se veía nunca.
  test("salta a reasoning cuando llega después de las herramientas", async () => {
    let update: (m: Message[]) => void = () => {}
    const tool = { type: "tool" as const, id: "tw", name: "terminal", args: "", preview: "date", status: "done" as const, duration: 9 }
    const soloTool: Message[] = [{ id: "a1", role: "assistant", timestamp: 0, parts: [tool] }]
    const conReasoning: Message[] = [{
      id: "a1", role: "assistant", timestamp: 0,
      parts: [{ type: "thinking", content: "Primero miro la hora del sistema.", streaming: false }, tool],
    }]
    const Wrapper = () => {
      const [m, set] = useState<Message[]>(soloTool)
      update = set
      return (
        <box flexDirection="column" width="100%" height="100%">
          <ThoughtCloud height={12} messages={m} onResize={() => {}} />
        </box>
      )
    }
    const t = await mountNode(<Wrapper />, { width: 100, height: 20 })
    await until(t, () => t.frame().includes("date"))
    expect(t.frame()).not.toContain("Primero miro la hora")

    await act(async () => { update(conReasoning) })
    await until(t, () => t.frame().includes("Primero miro la hora"))
    expect(t.frame()).toContain("Primero miro la hora")
    t.destroy()
  })
})
