# PLAN — Rescate de herm-tui (fork linux-fertxo/herm)

Fork de `liftaris/herm` para devolver la TUI a la vida contra Hermes ≥ 2026-09-14.
Upstream `dev` congelado en `a0e45022` (2026-07-29); Hermes va por `v0.21.5` (2026-09-24), contract **8**.

## Estado de partida (verificado en vivo, 2026-09-27)

Baseline de tests: **629 pass / 99 fail** (728 tests, 166 ficheros) → `bun test`.

Sonda: `~/.hermes/cache/scratch/probe_gateway.py` (habla JSON-RPC con `python -m tui_gateway.entry`).

```
ping{session_id}      → 4000 invalid params        ✗
ping{}                → {pong:true}                ✓
learning.frames+sid   → 4000                       ✗
learning.frames       → frames                     ✓
session.create        → desktop_contract: 8
clarify.respond       → -32601 unknown method      ✗ (no existe)
secret.respond        → -32601 unknown method      ✗
sudo.respond          → -32601 unknown method      ✗
approval.respond      → params {all, choice}, NO "answer"
client.capabilities   → {server_requests:[13]}
```

## Las cuatro capas de rotura

1. **`session_id` blanket injection.** `request()`/`remote()` en `src/context/gateway-client.ts`
   (líneas ~518 y ~556) meten `session_id` en TODO método. Con `extra="forbid"` es 4000.
   Solo **82 de 237** métodos lo aceptan. Fix: gate `wantsSession(method)`.
2. **Contract drift 5 → 8.** `src/context/backend-contract.ts` declara `MIN=4 MAX=5`; el backend
   emite 8 → reason `"newer"` → bloquea TODOS los RPC mutantes. Fix: `MAX_BACKEND_CONTRACT = 8`
   (v6=plugin rows, v7=blocking prompts son server→client requests, v8=connectors API).
3. **Prompts interactivos muertos.** Desde v7, clarify/approval/secret/sudo son **server→client
   requests** (`id: "srq-…"`, `method: "clarify"`). El gateway solo los envía si el cliente anuncia
   `client.capabilities {server_requests:true}` (`tui_gateway/server_requests.py::send` → `_unanswerable`).
   herm no lo anuncia → `send` devuelve None → el agente **se salta** las preguntas.
   Fix: anunciar capabilities + puentear los frames entrantes al flujo `PromptReq` existente y
   responder con `{jsonrpc:"2.0", id, result}`.
4. **Extractor del repo roto.** `gen-hermes-manifest:check` falla: Hermes partió `server.py` en
   `methods_*.py` + `tui_gateway/contracts/`. Fix: leer el artefacto OpenRPC generado.

## La pieza clave: el artefacto OpenRPC

Hermes ya genera la fuente de verdad:
`~/.hermes/hermes-agent/apps/shared/src/gateway-contract.openrpc.json`
(237 métodos, 82 con `session_id`, 73 notificaciones, 13 server-requests; `x-server-requests`
lleva params/result). Regenerado por `scripts/gen_gateway_contracts.py` desde `tui_gateway/contracts/`.
Resolver `$ref` + `allOf`/`anyOf`/`oneOf` sobre el schema de cada param.

## Plan por fases

### Trampas de entorno del baseline (2026-09-27 — IMPORTANTE)

El "baseline 629/99" era **casi todo artefacto de entorno**, no fallos del repo. Dos trampas:

1. **`NODE_ENV=production` heredado del proceso de Hermes.** React sólo publica `act` en su build
   de desarrollo, así que los 93 ficheros `.tsx` + 6 `.ts` morían al importar con
   *"Export named 'act' not found"* → parecían 99 tests rotos. ARREGLADO en `test/preload.ts`
   (`process.env.NODE_ENV = "test"`): suite 632 → 1391 pass.
2. **`TMPDIR` apuntando al scratch de Hermes** (`~/.hermes/cache/scratch`), que está DENTRO del
   repo git `~/.hermes` → el test `utils/git` encontraba un repo donde no había y `git.branch()`
   devolvía `"main"` en vez de `null`. Con `TMPDIR=/tmp` (entorno de CI): 1391 → **1443 pass**.

**Baseline real: 1443 pass / 1 fail.** Para medirlo hay que correr
`TMPDIR=/tmp bun test` (el fix del preload ya cubre lo de NODE_ENV).

El único fallo real: `analytics() > aggregates totals, ...` — **test dependiente de la hora**.
Espera `byDay.at(-1).sessions === 0` ("hoy, sin filas del fixture") y por la ventana de
medianoche las filas de "hace 1 día" caen en el bucket de hoy. Reproducido a las 01:00 CEST.
PENDIENTE DE DECISIÓN: ¿se arregla el test (fixture relativo a una hora fija) o el bucketing
de `src/service/hermes-analytics.ts`? Sospecha: el test, no el producto.

### Estado (sesión 2)

- ✅ **Fase 1 — HECHA Y VERIFICADA.** `src/context/gateway-contract.ts` lee el artifact OpenRPC
  (resuelve `$ref` + `allOf`/`anyOf`/`oneOf`) y expone `methods` / `session` / `requests` / `events`,
  con fallback embebido si el install no trae artifact. Leído contra el Hermes real: 237 / 82 / 13 / 73,
  idéntico al recuento independiente en Python. Ojo: el módulo NO importa `gateway-client` (evita ciclo):
  recibe la raíz como parámetro.
- ✅ **Fase 2 — HECHA.** Gate aplicado en las dos ocurrencias de `gateway-client.ts`
  (`request()` y `remote()`): `this.declared.session.has(method)`.
  Verificado end-to-end con el `GatewayClient` real contra el gateway: `learning.frames`,
  `agents.list`, `cron.manage`, `skills.manage`, `session.active_list`, `session.list`,
  `toolsets.list`, `session.history`, `session.usage` → **todas responden** (antes: 4000).
  Y los session-scoped siguen recibiendo el id.
- ⏳ Fase 3 pendiente — ya señalada en vivo: `session.status` responde
  `"Hermes backend contract 8 is newer than Herm supports (4-5)"`.
- Tests: `test/gateway-contract.test.ts` (3 casos: artifact, fallback, artifact corrupto).
  Suite: 632 pass / 99 fail (baseline 629/99 → sin regresiones).

### Fases

1. ✅ `src/context/gateway-contract.ts` (nuevo): carga el artifact bajo `hermesAgentRoot()`,
   resuelve refs, expone `methods` / `sessionScoped` / `serverRequests` / `notifications`.
   Con **fallback embebido** (el artifact solo existe en installs git).
2. Gate `session_id` en `gateway-client.ts` (las 2 ocurrencias).
3. `MAX_BACKEND_CONTRACT = 8`; añadir param `profile` donde el contrato lo pida.
4. `client.capabilities {server_requests:true}` al `gateway.ready`; puente de server requests
   → eventos sintéticos para `PromptReq`; `respond(id,result)`/`fail(id,...)`; reenviar
   `open_requests` que devuelven `session.resume`/`session.activate`/`session.events.since`.
5. Purgar `clarify.respond`/`secret.respond`/`sudo.respond` (muertos) en
   `src/components/chat/PromptCard.tsx` y `src/app/useStream.ts`; `approval.respond` → `choice`.
   Result shapes: clarify → `{answer}` / `{answers:{qid:ans}}` / `{}` = cancel-all;
   approval → `{choice, all?}`; sudo/secret/terminal.read/vault → `{value}`.
6. Arreglar `scripts/hermes-source.ts` (extractor) para consumir el OpenRPC; regenerar
   schema/manifest/fixtures (`gen-schema:check`, `gen-hermes-manifest:check`, `gen-fixtures:check`).
7. Tests: `bun test` → objetivo bajar de 99 fallos; `bunx tsc --noEmit`; `bun run build`.
8. Verificar con la sonda en vivo + `herm` real. Espejo a `gitea.fertxo.com`. Instalar como `herm`
   (sustituye el global `herm-tui@1.10.0`).

## Notas de repo

- Default branch **`dev`**; features y PRs contra `dev` (AGENTS.md). No tocar `main`.
- Nombres de una sola palabra para locales/funciones; sin `else`; evitar `any`/try-catch.
- Nunca lanzar un script suelto que toque `~/.hermes`: setear `HERMES_HOME` a tmpdir primero.
- `bun test` ← `test/preload.ts` ya aísla el home.
- **Correr la suite con `bun run test`** (el script fija `TZ=UTC TMPDIR=/tmp`).

## Sesión 3 (2026-09-28) — fases 4 y 5 hechas y verificadas EN VIVO

### Verificación en vivo del camino server→client (la buena)

`herm` real (CONTROL=1, `localhost:7788`) contra el gateway real (v0.21.5, contract 8):

```
POST /send  "usa la herramienta clarify … ¿qué color pruebo? rojo/azul"
→ frame real del backend → tarjeta renderizada en el transcript:
   ┃ ask ¿qué color pruebo?
   ┃ ▸ 1. rojo (Recommended)   2. azul   3. Other (type your answer)
   ┃ ↑/↓ · Enter · 1-2 · Esc cancel
POST /key "2"  → tarjeta se cierra, outcome "✓ ¿qué color pruebo? / 1 answered"
respuesta del agente: "Elegiste azul. 🎨"
```

Eso es el ida y vuelta completo: capabilities anunciadas → frame `srq` recibido →
render → `respond(id,{answer})` → el backend recibe la respuesta.

**Truco para probarlo sin tocar la política de aprobaciones: `clarify`.** Las
aprobaciones dependen de `approvals.mode`; clarify no.

### Gotchas nuevos

- **`approvals.mode: smart` NO genera preguntas.** El juez auxiliar auto-aprueba
  (incluso un `echo 'rm -rf …' | sh`, que el escáner marca HIGH). Para ver una
  tarjeta de approval hay que poner `manual` — y eso lo decide Fertxo: cambiar su
  config a `manual` hace que *también mis propios comandos* pidan permiso, y a las
  01:30 no hay quien los conteste. **No tocar `approvals.mode` sin él delante.**
  La vía sancionada para restaurarlo: `hermes config set approvals.mode smart`
  (la herramienta de edición rechaza escribir config.yaml, y `patch` también).
- **El extractor es pin-scoped, no está roto.** `gen-schema:check` falla contra el
  Hermes *instalado* (moved `DEFAULT_CONFIG` → `hermes_cli/config_defaults.py`;
  métodos → `methods_*.py`) pero pasa contra el **pin**. Los checks se corren así:
  ```bash
  mkdir -p /tmp/hermes-pin && cd /tmp/hermes-pin && git init -q . \
    && git remote add origin https://github.com/NousResearch/hermes-agent.git \
    && git fetch --depth=1 origin $(python3 -c "import json;print(json.load(open('hermes.contract.json'))['pinned'])") \
    && git checkout -q --detach FETCH_HEAD
  cd ~/dev/herm && HERMES_AGENT_ROOT=/tmp/hermes-pin bun run gen-hermes-manifest:check
  ```
- **El pin (jul-2026) no trae `apps/shared/src/gateway-contract.openrpc.json`.** El
  artefacto OpenRPC es posterior; por eso el manifiesto sigue derivándose por AST y
  `src/context/gateway-contract.ts` (runtime, fase 1) lee el artefacto del Hermes
  *instalado* con fallback embebido. Subir el pin = regenerar manifiesto+schema+
  fixtures+overlay; no se hace ahora (no aporta función y arriesga una suite verde).
- **Trampa de zona horaria en la suite** (tercera trampa de entorno): `bun test`
  corre el reloj JS en **UTC** pero `bun:sqlite` mantiene la zona del **sistema**;
  en host no-UTC se desalinean un día y `analytics()` falla siempre entre 00:00 y
  02:00 CEST, nunca en CI. Fijado con `TZ=UTC` en el script y en CI.

### Estado de fases

- 1-3 ✅ (sesión 2) · **4 ✅** (implementada + verificada en vivo) · **5 ✅** (purga
  hecha; `*.respond` fuera de src y harness) · **6 ✅** (manifiesto regenerado; los 3
  checks pasan contra el pin) · **7 ✅** (`bunx tsc --noEmit` limpio, `bun run build`
  OK, suite **1445 pass / 0 fail**) · **8 ✅**:
  - **Espejo Gitea**: repo privado `fertxo/herm` creado por API y `git push gitea --all`
    (`dev` + `fix/gateway-contract-gate`), verificado contra la API: las dos puntas
    coinciden con las locales. Remoto: `git push gitea` (o `--all`). La API necesita
    `GITEA_TOKEN` (en `~/.hermes/.env`, scheme `token`); la credencial de
    `~/.git-credentials` solo vale para git, no para la API (ya sustituida por el token).
  - **`dev` promovido** al tip de la rama por fast-forward en local, GitHub y Gitea
    (`afeb5f1`), y es la rama por defecto: `bun add -g github:linux-fertxo/herm` instala
    ya los arreglos, sin anclar ref. Queda pendiente de decidir si se sube el pin de
    compatibilidad (no hace falta para funcionar contra el Hermes actual).
  - **Instalado como `herm`**: `~/.local/bin/herm -> ~/dev/herm/bin/herm.cjs` (que
    ejecuta `dist/index.js`). `herm-tui@1.10.0` global desinstalado (ojo: `npm -g rm`
    no lo veía porque el prefix de npm apunta a `~/.local/lib` y el paquete vivía en el
    árbol de nvm — hubo que borrar `lib/node_modules/herm-tui` a mano). El `herm-tui`
    local de `~/package.json` también está fuera.
  - **28-sep, post-entrega — bug hallado en uso real**: el frame lleva su propio id
    (`srq-…`), pero `approval` **declara además un `request_id` suyo**
    (`tools/approval_gateway_wait.py`: `setdefault("request_id", uuid4().hex)`); la
    traducción `{request_id: id, ...params}` dejaba ganar al de dentro, así que la tarjeta
    contestaba con un id que `_open` no conocía → «this request is no longer open» y
    **nada llegaba al backend** (el log lo registraba como «prompt timed out without a
    user response»). Arreglado en `a9b3e9a` (el id del frame, el último) con test de
    regresión verificado por mutación. Comprobado A/B con dos bundles (con y sin el bug) y
    con la mano de Fertxo sobre la tarjeta real de fichero protegido. Suite: 1446/0.
    Para el futuro: hay **dos familias** de tarjeta y solo la del `approval_gateway_wait`
    (comando peligroso, fichero protegido) lleva ese campo; la del escáner Tirith no.

