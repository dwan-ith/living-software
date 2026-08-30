# Living Software

Living Software is a persistent runtime that observes a workspace, executes verified actions through a typed capability kernel, grows new capabilities through approval-gated composition of registered primitives, and renders its interface as a context-dependent ephemeral document.

It is a research prototype of Jules White's Living Software i.e. software that maintains identity, grows its own mechanisms, and whose visible interface is a temporary phenotype generated for the present situation.

## Architecture

The system operates through four coupled feedback loops.

### World Loop

The observer captures periodic DPI-aware desktop screenshots via PowerShell. Content-aware workspace adapters read notes, slides, downloads, and dependency graphs. These produce normalized events that update a persistent world model (`backend/data/living-runtime.json`) via an atomic read-modify-write queue. World entities are tracked with change history and revision numbers. Perception and semantic interpretation are intentionally separate authorities.

### Work Loop

A scheduled 60-second cycle (configurable) selects the most relevant installed capability — matching only events newer than that capability's last run, honoring the manifest's `trigger.threshold` (minimum matching-event count) and `trigger.cooldownMs` (which are enforced, not decorative) — checks its package preconditions against the current world model, re-validates package authority at execution time, executes each declared primitive in sequence, verifies declared postconditions independently of the primitives' self-reports, and commits an immutable, cryptographically-linked receipt:

```text
world state + recent events + current reflection
    -> capability selection (threshold + cooldown enforced)
    -> package precondition check
    -> execution-time authority gate
    -> sequential primitive execution
    -> independent filesystem verification of declared effects
    -> receipt (package digest, hash-chain link, evidence, effects, compensation)
```

When nothing matches and continuity is fresh, the work loop rests instead of emitting a redundant receipt. Receipt spam dilutes exactly the fitness signal that feedback and verification exist to provide.

## Concurrent Metabolism

The runtime's loops are phased, not monolithic. Slow work — provider inference, filesystem effects — runs *outside* the mutation queue against a frozen state snapshot, so a 45-second model call never blocks event ingestion or state writes. The queue itself only ever executes the fast guarded commit: re-resolve the capability, re-check its authority against current state (it may have been rolled back while planning ran), link the receipt into the ledger.

```text
Phase A (concurrent)                Phase B (serialized, fast)
─────────────────────               ──────────────────────────
freeze state snapshot               re-resolve live capability
derive reflection                   re-run authority gate
select capability by trigger        append reflection + receipt
run primitive steps (I/O)           append proposal candidate
verify effects on filesystem        record cycle + events
evaluate evolution needs
```

State mutation stays deliberately serialized — that is transaction consistency, not a bottleneck. What was removed is the coupling between consistency and latency: perception, work, and evolution no longer hold each other hostage. Full Actor-Model distribution (one process per capability) is consciously deferred until a multi-habitat deployment demands it; within one machine it would add IPC failure modes without adding throughput.

## Concurrent Evolution & Prospective Growth

Evolution is no longer purely reactive. Every cycle performs counterfactual coverage analysis: recent history is replayed against installed triggers to find recurring event kinds that nothing covers. Scheduled cycles act at the reactive threshold (4 occurrences); idle-dream cycles act on weaker evidence (3) because quiet periods are exactly when anticipatory growth is affordable. Speculative proposals are labeled `speculative-simulation` in their synthesis provenance, cite their evidence, and remain fully subject to validate → rehearse → approve — dreaming proposes, it does not install.

## Evidence Integrity

Three mechanisms make the runtime's history claims machine-checkable rather than asserted:

- **Hash-chained receipt ledger with a durable anchor.** Every receipt stores `ledgerPrev`, the digest of its predecessor's canonical form; editing or dropping any chained receipt fails the `receipt-ledger-integrity` check. An append-only `ledger-head.jsonl` anchor recomputes digests from canonical content, so forging or wholesale-deleting even the newest receipts is flagged by the `ledger-anchor` audit check. Legacy pre-chain receipts remain valid anchors.
- **Append-only archives with size-bound rotation.** Entries pushed out of the hot windows (`events-archive.jsonl`, `receipts-archive.jsonl`) are appended to journals beside the state file instead of being destroyed by the caps; at 50 MB a journal rotates to a preserved `.rotated` copy. History shrinks in RAM, never on disk.
- **Quarantine over amnesia.** A state file that cannot be parsed is copied to `<name>.corrupt-<timestamp>` and an incident event recorded before a fresh seed boots — corruption is never silently overwritten.

If the final atomic save fails (disk full, AV lock), the runtime reports `persistence.durable: false` plus the error through health/state/audit instead of pretending memory and disk agree.

Receipts are linked to the package digest, not the capability name. An upgrade or rollback produces a new receipt under a new digest. Effect honesty is enforced: any receipt that does not declare artifact mutations that occurred is rejected by the audit endpoint.

### Evolution Loop

When counterfactual coverage analysis finds a recurring event kind that no installed capability and no live proposal answers, `_evaluateEvolutionNeeds` compiles a candidate: if Gemini is configured it drafts the rationale; otherwise a deterministic one is used with honest `algorithmic` provenance. The candidate becomes a versioned capability package with a canonical SHA-256 digest, explicit permissions, declared preconditions, declared postconditions, a rollback mode, and a test list.

Activation is a three-gate process:

1. **Validate** — schema, identity, digest, primitive allowlist, permission completeness, condition validity, rollback consistency, and effect-honesty checks must all pass.
2. **Rehearse (dry-run)** — every primitive step runs in `rehearsal` mode: Gemini calls return a placeholder, file writes declare their target path without writing, moves confirm path safety without executing. No external effect is committed.
3. **Install** — explicit user action activates the package. Prior version is preserved for rollback.

The system cannot bypass this gate sequence. A proposal cannot transition directly to `active`.

### Phenotype Loop

The surface layer replaces the former fixed React dashboard. When the user submits an utterance or the backend's world state changes, `POST /api/surfaces/compose` constructs a context harvest (identity, world, memory, capabilities, proposals, receipts, workspace snapshot) and passes it to the model. The model returns a `living-surface/v1` JSON document — not JSX, not HTML, not JavaScript. The document specifies which component types, data bindings, and declared actions to render. The React client resolves these against a trusted component registry (`src/surfaces/registry.tsx`). Unknown component types, actions not declared in the current surface revision, stale revision numbers, and targets not present in the bound data are all rejected at the backend before execution.

When model inference is disabled, the bounded adaptive boot policy emits an identical protocol document and labels its provenance honestly as `adaptive-policy`.

## Execution Boundary: No Model-Authored Code

The runtime deliberately does **not** have a code-execution primitive. Earlier iterations included a `system.eval` primitive in which Gemini authored a JavaScript function body that the server executed against live Node.js APIs. It was removed because it violated every guarantee the rest of the architecture works to provide:

- **It is constitution level 6.** The runtime's own constitution forbids "installation of generated source code." A primitive that executes model-authored code cannot declare bounded effects, cannot be rehearsed honestly (a rehearsal placeholder proves nothing about what the committed code would do), and cannot record compensations for mutations the runtime never anticipated.
- **It converts prompt injection into remote code execution.** Screen summaries, file contents, and notification text all flow into event logs and model prompts. Any attacker-controlled visible content could steer code generation; executing that output hands over the process — with `fs`, `network`, and full runtime state.
- **It made the audit dishonest.** Permission checks were gerrymandered (`write:filesystem` slipped through an `external|network|shell` regex) to let it pass.

`FORBIDDEN_PRIMITIVES` in `backend/capabilityKernel.js` now rejects such primitives at package-validation time, and the audit includes a `no-autopoietic-execution` check. Models may only compose registered primitives whose effects are declared, rehearsed, verified, and compensable.

## Capability Kernel

`backend/capabilityKernel.js` defines the type system for all capability packages.

**Registered primitives:**

| Primitive | Effect class | Description |
|---|---|---|
| `world.snapshot` | `runtime-read` | Snapshot of current world entities and revision |
| `context.reflect` | `runtime-write` | Derive a reflection from recent events |
| `risk.summarize` | `workspace-read` | Summarize workspace risk signals |
| `workspace.read` | `workspace-read` | Read up to 8 KB from a declared file path |
| `gemini.synthesize` | `external-inference` | Request a text or code draft from Gemini |
| `write.proposal` | `user-artifact-write` | Write a Markdown file to `Living-Proposals/` |
| `file.sort` | `user-artifact-move` | Move a file to a semantic subfolder in Downloads |
| `idle.detect` | `runtime-read` | Check OS-level user idle time against a threshold |
| `screen.interpret` | `external-inference` | Extract app, window title, and summary from the last screenshot |

**Registered permissions:**

`read:world`, `read:events`, `read:workspace`, `read:workspace-content`, `read:screen-state`, `write:living-state`, `write:proposals`, `write:downloads-sort`

An evolved capability can only declare permissions in this set. The validation check confirms that every primitive's required permissions are present in the package manifest. Permission expansion requires a constitutional change, which is an approval-gated action not available to the automatic evolution loop.

## Module Map

| Module | Responsibility |
|---|---|
| `backend/livingRuntime.js` | Identity, constitution, world model, event log, reflections, capability lifecycle, primitive execution, proposals, receipts, feedback, fitness, evolution synthesis |
| `backend/capabilityKernel.js` | Package type system, manifest creation, SHA-256 digests, validation, permission enforcement, fitness normalization |
| `backend/surfaceProtocol.js` | Surface protocol schema, trusted component catalog, binding resolution, action authorization |
| `backend/surfaceRuntime.js` | Persistent surface sessions, conversation turns, context-dependent composition, revision history |
| `backend/surfaceModelProvider.js` | Gemini structured-output surface composer with schema constraint |
| `backend/screenObserver.js` | DPI-aware Windows capture, grounded world-state extraction, signal detection |
| `backend/workspaceAdapters.js` | Content-aware adapters for notes, slides, downloads, gallery, dependencies |
| `backend/memoryStore.js` | Semantic facts, episodes, and cross-surface associations |
| `backend/server.js` | Observer loop, living cycle scheduler, idle-dream loop, surface-context metabolism, REST and WebSocket API |
| `src/App.tsx` | Session-aware habitat shell; no fixed routes, no dashboard |
| `src/surfaces/registry.tsx` | Trusted React renderers for backend-composed surface component types |

## Idle Dream Loop

A secondary interval fires every 60 seconds and measures **real user idle time** through the Windows last-input API (`GetLastInputInfo`, via a small PowerShell probe). Capture timestamps are useless for this — the observer captures every few seconds regardless of whether the human is present. Only when the keyboard and pointer have been silent for 10+ minutes does the loop record an `idle-dream` event and run an autonomous living cycle — which, unlike scheduled cycles, performs **prospective evolution**: it proposes capabilities for below-threshold coverage gaps (see Concurrent Evolution above).

Artifact-changing capabilities such as `workspace.nightly-digest` remain user-started by constitution; the dream phase observes, reflects, and proposes, it does not write files.

## Network Boundary

The backend exposes screenshots, clipboard access, memory, and capability execution, so the local boundary is enforced rather than assumed. WebSocket `living_state` pushes are compact digests (world revision, stats, loop status, latest ids) — the full state is fetched on demand via `GET /api/living/state`, so every event no longer re-broadcasts hundreds of kilobytes of receipts to every connected client:

- The HTTP listener binds to `127.0.0.1` (override with `BIND_HOST`).
- Browser origins must match an allowlist (`ALLOWED_ORIGINS`, default: the Vite dev servers on ports 5173/5174). Requests carrying a foreign `Origin` header are rejected with 403.
- The WebSocket endpoint verifies the same allowlist during the upgrade handshake — WebSockets are not subject to CORS, so without this check any web page could silently receive continuous desktop screenshots.
- Clipboard reads are consent-gated in fact, not just in prose: `POST /api/workspace/clipboard {"confirm":true}`.

## Effect Reversal & Crash Consistency

Receipts that declared artifact mutations record a compensation per mutation. `applyCompensation` (exposed as the `receipt.revert` surface action) applies those compensations in reverse order — deleting created files, moving moved files back — marks the receipt reverted, and records a `work.reverted` event. A partial failure is persisted on the receipt for manual review. "Reversible" on a receipt now means executable, not aspirational.

`file.sort` never overwrites: because `fs.rename` silently replaces existing destinations on every platform, a colliding move lands under a unique `name (2).ext` instead of destroying the destination file.

Artifact effects are also **write-ahead journaled**. Before a move or write touches the filesystem, its full intent (paths, bytes, compensation) is appended to `effect-journal.jsonl`; it is resolved only after the state file is durably saved. If the process crashes in between, the next boot finds the unresolved intent and undoes the effect through its recorded compensation (`work.journal-reconciled`), or flags a genuine conflict for human review. An effect can therefore no longer dangle across a crash.

## Surface Action Idempotency

Every successful surface action consumes an idempotency key derived from `(surfaceId, revision, componentId, action, targetId)`. Replaying the exact same request — the classic double-click — is rejected instead of executing twice; genuinely failed actions do not consume their key and remain retryable.

## Adaptive Observation

The observer respects presence: while OS input activity is recent it captures at the configured interval, but after two idle minutes it backs off to one frame per 30 seconds, and vision analysis is skipped entirely when the screen fingerprint is unchanged since the previous analysis. Fewer screenshots of an empty chair; fewer identical inferences.

## Built-in Capabilities

| Capability | Trigger | Primitives | Effect |
|---|---|---|---|
| `continuity.snapshot` | `runtime.boot`, `world.observed`, `user.intent` | `world.snapshot` | Persist world revision |
| `context.reflect` | `perception.analysis`, `workspace.notification` | `context.reflect` | Derive a reflection |
| `workspace.risk-map` | `screen.intervention`, `workspace.risk` | `risk.summarize`, `context.reflect` | Risk summary |
| `workspace.nightly-digest` | `idle-dream` | `gemini.synthesize`, `write.proposal` | Markdown digest in `Living-Proposals/` |
| `downloads.auto-sort` | `file.sort-requested` | `workspace.read`, `gemini.synthesize`, `file.sort` | Classify and move Downloads file |

## State Persistence

All persistent state lives in two JSON files:

- `backend/data/living-runtime.json` — identity, boot count, constitution, world model, events (cap 500), reflections (cap 120), capabilities (versioned with history), proposals, receipts (cap 240), cycles (cap 120), feedback
- `backend/data/surface-runtime.json` — surface sessions, conversation turns (cap 25 per session), revision history, generation provenance

Both files are git-ignored. A process restart resumes the same identity and event history rather than starting a blank session.

## Setup

```powershell
npm.cmd install
npm.cmd --prefix backend install
```

Copy `.env.example` to `backend/.env`. Inference is disabled by default:

```text
MODEL_INFERENCE_ENABLED=false
```

The runtime runs completely without a Gemini key in this mode. The deterministic policy compiler handles capability selection, reflection synthesis, and surface composition. All loops, receipts, fitness, validation, and rollback work identically.

To enable model inference:

```text
MODEL_INFERENCE_ENABLED=true
GEMINI_API_KEY=your-key
```

Start backend and frontend in separate terminals:

```powershell
node backend/server.js
npm.cmd run dev
```

Open `http://127.0.0.1:5173`.

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Backend HTTP port |
| `BIND_HOST` | `127.0.0.1` | Interface the backend binds to (loopback by default) |
| `ALLOWED_ORIGINS` | Vite dev origins on 5173/5174 | Semicolon-separated browser origins allowed to drive the runtime |
| `LIVING_DATA_DIR` | `backend/data` | Override for all persistent state (used by tests/parallel instances) |
| `MODEL_INFERENCE_ENABLED` | `false` | Enable Gemini inference (required for `gemini.synthesize`, surface composer) |
| `GEMINI_API_KEY` | — | Google Gemini API key |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Model for text synthesis |
| `LIVING_AUTOSTART` | `true` | Start the living cycle timer on boot |
| `LIVING_CYCLE_INTERVAL_MS` | `60000` | Scheduled cycle interval in milliseconds |
| `OBSERVER_INTERVAL_MS` | `3500` | Screen capture polling interval |
| `OBSERVER_ANALYSIS_COOLDOWN_MS` | `15000` | Minimum gap between full analyses |
| `OBSERVER_FAILURE_BACKOFF_MS` | `300000` | Backoff after repeated observer errors |
| `POWERSHELL_EXE` | `powershell.exe` | PowerShell executable used by capture, idle, and clipboard probes |

## API Reference

### Generative Surface

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/surfaces/catalog` | Trusted component, binding, and action catalog |
| `POST` | `/api/surfaces/compose` | Compose a new surface from current conversation and world context |
| `GET` | `/api/surfaces/:sessionId` | Resume an existing surface session |
| `POST` | `/api/surfaces/:sessionId/actions` | Authorize and execute a surface-declared action |

### Living Runtime

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/living/state` | Full runtime state and loop statistics |
| `GET` | `/api/living/health` | Health summary, verification rate, and state digest |
| `POST` | `/api/living/events` | Ingest a normalized event |
| `POST` | `/api/living/cycle` | Manual trigger: world, work, and evolution loops |
| `POST` | `/api/living/evolve` | Translate an expressed need into a capability proposal |
| `POST` | `/api/living/proposals/:id/validate` | Validate a proposal package |
| `POST` | `/api/living/proposals/:id/dry-run` | Rehearse without committing effects |
| `POST` | `/api/living/proposals/:id/install` | Activate an approved proposal |
| `POST` | `/api/living/proposals/:id/reject` | Reject without installation |
| `POST` | `/api/living/capabilities/:id/run` | Execute a capability and emit a receipt |
| `POST` | `/api/living/capabilities/:id/rollback` | Restore prior package version |
| `POST` | `/api/living/feedback` | Attach feedback verdict to a receipt |
| `POST` | `/api/living/receipts/:id/revert` | Apply recorded compensations and undo artifact effects |
| `POST` | `/api/workspace/clipboard` | Consent-gated clipboard read: body `{"confirm":true}` required |
| `GET` | `/api/living/audit` | Evaluate package integrity, authority, and effect honesty |

## Testing

```powershell
npm.cmd --prefix backend test
npm.cmd run lint
node --check backend/server.js
```

The test suite (39 tests across `livingRuntime`, `livingBench`, `surfaceRuntime`, `workspaceAdapters`, `securityAndEffects`, `evidenceIntegrity`, and `integrationApi`) covers:

- Persistent identity and constitution across restarts
- World observation and entity change tracking, with provenance (source + revision) on entities
- Work loop receipts and postcondition verification, plus work-loop rest
- Refusal semantics: refused-authority receipts leave health and verification rate intact
- Ledger anchor: forged or wholesale-deleted receipts are flagged against the durable head journal
- Archive rotation: append-only journals stay size-bounded
- Memory retrieval: exact-token relevance outranks substring coincidence; recency breaks importance ties
- Repeated-pattern capability proposals with noise caps
- Package validation, permission checks, and digest integrity
- Constitution enforcement: forbidden primitives (generated-code execution) can never be packaged
- Execution-time authority gate: drifted packages are refused before any step runs
- Trigger threshold and cooldownMs enforcement in cycle selection
- Receipt hash-chain integrity and tamper detection via audit
- Corrupt-state quarantine with incident evidence
- Write-ahead effect journal: pre-crash artifact intents are compensated on boot
- Network boundary: browser origin allowlist behavior over live HTTP
- Surface action idempotency: replayed actions cannot execute twice (live HTTP)
- Artifact effects: collision-safe moves that never overwrite, rehearsals that commit nothing, and compensation reverts that actually undo effects
- Side-effect-free rehearsal and explicit rejection
- Versioned installation, in-place upgrade, and rollback to prior package
- Capability fitness from verification rates and explicit feedback
- Process-restart continuity (same identity, same event history)
- Surface protocol catalog enforcement
- Context-dependent surface composition
- Gemini-composed surface schema and catalog validation
- Stale revision, undeclared action, and unbound target rejection
- Persistent surface conversation and history
- Effect honesty: artifact rehearsal never commits, execution must record mutations
- Prefix-bounded workspace reads

## Boundaries

The following are genuine architectural limitations of the current implementation:

1. **One process, phased concurrency.** Perception, work, and evolution no longer block each other (see Concurrent Metabolism), and state mutation is deliberately serialized for transaction consistency. True Actor-Model distribution — one isolated process per capability with message-passing — is deferred until multi-habitat deployment justifies its IPC failure modes.

2. **Crash consistency has one narrow window.** The write-ahead journal closes the mutation-to-receipt gap, but an effect whose receipt was durably saved yet whose `resolved` journal line was lost to a crash in the following instant will be compensated again on next boot — the safe direction (undo uncertain effects), but it can undo an already-receipted move once.

3. **Inference verification is provider-reported.** Artifact effects get independent filesystem verification (destination exists, source gone, byte counts match), but inference steps still self-report "verified" at presence level (non-empty usable output). Verifying semantic quality of model output without a second model remains open.

4. **Prospective growth is coverage-based, not clairvoyant.** The dream phase acts earlier than reactive counting and grounds proposals in replayed evidence, but it does not simulate future habitat states or counterfactual worlds beyond trigger coverage. Predictive coding in the full cognitive-science sense remains research work.

5. **Origin allowlisting is not authentication.** Any local process can still drive the runtime; the boundary defends against browser-based drive-by access and LAN exposure, not against local malware running as the same user.

6. **Perception depends on provider availability.** With inference disabled or providers unreachable, screen pixels are captured but never semantically interpreted — an honest, explicit boundary rather than a silent failure.

## Research Lineage

- Jules White, *Building Living Software Systems with Generative & Agentic AI*: https://arxiv.org/abs/2408.01768
- Kephart and Chess, *The Vision of Autonomic Computing*: https://doi.org/10.1109/MC.2003.1160055
- Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*: https://doi.org/10.1145/3586183.3606763
- Arora et al., *Self-Evolving Systems: Moving Beyond Deterministic Interfaces to Adaptive Generative Interfaces*: https://research.google/pubs/self-evolving-systems-moving-beyond-deterministic-interfaces-to-adaptive-generative-interfaces/
- Google A2UI, declarative agent-to-interface protocol: https://github.com/google/A2UI
