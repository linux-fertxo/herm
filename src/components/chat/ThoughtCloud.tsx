// Eikon thought cloud — shows the non-output parts of a turn
// (reasoning, tool trail, status). Sits in flow above the chat scroll.
// Auto-opens while the assistant is reasoning or running tools, closes
// once text is streaming; pinning a past message holds it open. The
// tail bubbles live on the Sidebar avatar.

import { memo, useEffect, useRef, useState } from "react"
import type { BorderCharacters, MouseEvent } from "@opentui/core"
import type { Message, Part, ThinkingPart, ToolPart } from "../../types/message"
import { Tool, cost, visible } from "./tool"
import { usePref, type DetailMode } from "../../context/preferences"
import { useTheme } from "../../theme"

export const CLOUD_MIN = 12
const CLOUD_MAX = 24

// Light triple-dash with rounded corners — reads as a bubble, not a grid.
const CLOUD: BorderCharacters = {
  topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
  horizontal: "┄", vertical: "┆",
  topT: "┄", bottomT: "┄", leftT: "┆", rightT: "┆", cross: "┼",
}

// Stepped bubbles bridging the cloud to the avatar's upper-left. Three
// slots, big→small top→bottom. When animating, one slot is lit per
// frame and travels bottom→top (away from the head, into the cloud);
// the trailing empty frame reads as the bubble entering the cloud.
const SLOTS = [
  ["╭┄┄╮   ", "╰┄┄╯   "],
  ["   ╭╮  ", "   ╰╯  "],
  ["     ╶ ", "       "],
]
const BLANK = "       "
const ORDER = [2, 1, 0, -1]

export const Tail = memo((props: { run: boolean }) => {
  const theme = useTheme().theme
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refs = useRef<any[]>([]) // TextNodeRenderable[6]
  // Paint a full frame (all slots when idle; one lit slot when running).
  // Mutates span .children directly — one requestRender() per touched
  // node, zero React reconciles per 160ms tick.
  const paint = (lit: number | null) => {
    SLOTS.forEach((slot, i) => slot.forEach((l, j) => {
      const node = refs.current[i * 2 + j]
      if (node) node.children = [lit === null || lit === i ? l : BLANK]
    }))
  }
  useEffect(() => {
    if (!props.run) { paint(null); return }
    let f = 0
    paint(ORDER[0])
    const t = setInterval(() => { f = (f + 1) % ORDER.length; paint(ORDER[f]) }, 160)
    return () => { clearInterval(t); paint(null) }
  }, [props.run])
  return (
    <box flexDirection="column">
      {SLOTS.flatMap((slot, i) =>
        slot.map((l, j) => (
          <text key={`${i}-${j}`} fg={theme.hermAvatar}>
            <span ref={el => { refs.current[i * 2 + j] = el }}>{l}</span>
          </text>
        )),
      )}
    </box>
  )
})

function parts(m: Message | undefined): Part[] {
  // ThoughtCloud shows the agent's process (reasoning + tool calls).
  // Prompts render inline in the transcript body, not here.
  return m?.parts.filter(p => p.type === "thinking" || p.type === "tool") ?? []
}

type Pane = "reasoning" | "tools"

function latest(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === "assistant") return messages[i]
  return undefined
}

// Rough row cost — enough for auto-grow between MIN and MAX.
function rows(list: Part[], detail: DetailMode): number {
  return list.reduce((n, p) =>
    n + (p.type === "thinking" ? Math.ceil(p.content.length / 80) || 1
       : p.type === "tool" ? cost(p, detail)
       : 1), 0)
}

export const ThoughtCloud = memo((props: {
  height: number
  messages: Message[]
  pick?: Message
  onResize: (h: number) => void
  onClose?: () => void
}) => {
  const { theme, syntaxStyle } = useTheme()
  const detail = usePref("toolDetails") ?? "expanded"
  const src = props.pick ?? latest(props.messages)
  const all = parts(src)
  const think = all.filter((p): p is ThinkingPart => p.type === "thinking")
  const tools = all.filter((p): p is ToolPart => p.type === "tool")
  const seen = tools.filter(t => visible(t, detail))
  const [pane, setPane] = useState<Pane>("reasoning")
  // El usuario ha tocado una pestaña: manda él hasta que cambie de mensaje.
  // Sin esto, un cambio automático le tapaba lo que estaba leyendo.
  const userPane = useRef(false)
  const msgKey = src?.id ?? ""
  useEffect(() => { userPane.current = false }, [msgKey])
  const running = tools.some(t => t.status === "running")
  const thinkChars = think.reduce((n, p) => n + p.content.length, 0)
  // Razonamiento que está llegando AHORA (deltas): manda sobre los tools.
  const thinkLive = think.some(p => p.streaming)
  useEffect(() => {
    if (userPane.current) return
    if (thinkLive) { setPane("reasoning"); return }
    if (running) { setPane("tools"); return }
    // Proveedores que NO streamean el reasoning (DeepSeek manda un único
    // `reasoning.available` DESPUÉS de los tool calls) dejaban la cajita
    // clavada en tools para siempre: el reasoning existía y no se veía.
    if (thinkChars > 0) { setPane("reasoning"); return }
    if (seen.length > 0) setPane("tools")
  }, [thinkLive, running, thinkChars, seen.length])
  const body = pane === "reasoning" ? think : seen

  // Auto-grow: track content until the user drags; then their size
  // sticks. `want` is the dep so growth follows streamed thinking text,
  // not just part count.
  const manual = useRef(false)
  const want = Math.min(CLOUD_MAX, Math.max(CLOUD_MIN, rows(body, detail) + 3))
  const resize = props.onResize
  useEffect(() => {
    if (!manual.current) resize(want)
  }, [want, resize])

  // Drag-resize via the bottom edge. MouseEvent.y is absolute terminal
  // row; delta from the drag origin maps 1:1 to height rows.
  const drag = useRef<{ y: number; h: number } | null>(null)
  const grab = (e: MouseEvent) => {
    drag.current = { y: e.y, h: props.height }
    manual.current = true
    e.stopPropagation()
  }
  const move = (e: MouseEvent) => {
    const d = drag.current
    if (!d) return
    resize(Math.min(CLOUD_MAX, Math.max(CLOUD_MIN, d.h + (e.y - d.y))))
  }
  const drop = () => { drag.current = null }

  const pill = (id: Pane, label: string, n: number | null) => {
    const on = pane === id
    return (
      <box height={1} marginRight={2}
           onMouseDown={(e: MouseEvent) => { e.stopPropagation(); userPane.current = true; setPane(id) }}>
        <text>
          <span fg={on ? theme.accent : theme.textMuted}>
            {on ? <strong>{label}</strong> : label}
          </span>
          {n !== null && n > 0 ? <span fg={theme.textMuted}>{` ${n}`}</span> : null}
        </text>
      </box>
    )
  }

  return (
    <box
      height={props.height} flexDirection="column" position="relative" marginLeft={1}
      border borderColor={theme.hermAvatar} customBorderChars={CLOUD}
      backgroundColor={theme.backgroundPanel} paddingX={1}
    >
      <box height={1} flexShrink={0} flexDirection="row">
        {pill("reasoning", pane === "reasoning" || think.length === 0 ? "reasoning" : "reasoning •", null)}
        {pill("tools", "tools", seen.length)}
        <box flexGrow={1} />
        {detail !== "expanded" ? (
          <box marginRight={1}><text fg={theme.textMuted}>⟨{detail}⟩</text></box>
        ) : null}
        {props.onClose ? (
          <box width={1} onMouseDown={props.onClose}>
            <text fg={theme.textMuted}>×</text>
          </box>
        ) : null}
      </box>
      <scrollbox scrollY stickyScroll stickyStart="bottom" flexGrow={1}>
        <box flexDirection="column" width="100%">
          {body.map((p, i) =>
            p.type === "thinking"
              ? <box key={(p as ThinkingPart).key ?? `th-${i}`} minHeight={1} width="100%" flexShrink={0}>
                  <markdown content={(p as ThinkingPart).content} fg={theme.markdownText} syntaxStyle={syntaxStyle} />
                </box>
              : <box key={(p as ToolPart).id || `t-${i}`} width="100%" flexShrink={0}>
                  <Tool branch={i === body.length - 1 ? "last" : "mid"} tool={p as ToolPart} detail={detail} />
                </box>,
          )}
        </box>
      </scrollbox>
      <box position="absolute" left={0} right={0} bottom={0} height={1}
           onMouseDown={grab} onMouseDrag={move} onMouseUp={drop} onMouseDragEnd={drop} />
    </box>
  )
})
