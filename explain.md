# Living Software — System Explanation

## The transition

This repository began as Persistent Computer: a Windows observer that streamed the desktop, used a multimodal model to detect visible problems, and displayed pushback in a React workspace. The current runtime deliberately disables Gemini and Gemma inference; the living architecture must remain real without either provider.

That observer remains useful, but observation and inconsistency detection are not a complete definition of living software. The project now treats Persistent Computer as the habitat and sensory body of a broader Living Runtime.

The runtime is designed around a stricter definition:

> Living Software persists as the same computational identity, maintains a model of its changing world, translates context into bounded action, verifies outcomes, learns feedback, and grows new capabilities under human governance.

Its interface is now included in that definition. The stable application is no longer a list of pages. The stable layer is a protocol, renderer catalog, conversation, world model, and action constitution. A visible surface is a temporary phenotype generated for the present situation.

## Three coupled loops

### World loop

The world loop turns heterogeneous observations into durable state.

```text
screen / files / notes / slides / dependencies / notifications
    -> normalized event
    -> entity and relation update
    -> world revision
    -> durable persistence
```

The observer captures screen pixels locally but does not assign semantic meaning while model inference is disabled. Deterministic workspace adapters, dependency scans, explicit user events, notifications, and consent-gated clipboard reads still produce provenance-tagged world evidence. Pixel capture and semantic interpretation remain separate authorities.

Workspace adapters expose bounded content when it is actually readable. Binary-only artifacts preserve an explicit metadata-only uncertainty boundary.

### Work loop

The work loop uses installed capability packages rather than treating generated prose as action.

```text
recent events + world state + reflection
    -> select capability
    -> check package preconditions
    -> stage and execute trusted primitives
    -> verify postconditions
    -> commit an immutable package-linked receipt
    -> collect user feedback
```

Current capabilities are conservative. They snapshot continuity, reflect on context, and summarize grounded risk. They write only runtime state, except two explicitly user-started packages that may classify and move a Downloads file or write a proposal artifact. Their receipts include the package digest, version, preconditions, outputs, postconditions, transaction boundary, evidence, compensation records, and rollback statement; recorded compensations are executable through the receipt-revert action rather than aspirational. The work loop may also rest: when no installed capability matches events newer than its last run and continuity is fresh, the cycle records rest instead of a redundant receipt. Reliability and user feedback become a measurable fitness score rather than an implicit impression.

There is deliberately no code-execution primitive. An earlier `system.eval` primitive executed model-authored JavaScript inside the server process; it was a constitution level-6 violation (generated source installation), turned prompt injection from screen or file content into remote code execution, and could not declare bounded effects. Forbidden primitives are now rejected at package validation, and the runtime audit carries an explicit no-autopoietic-execution check.

### Evolution loop

The evolution loop gives the system a bounded form of growth.

```text
repeated pattern or expressed unmet need
    -> capability synthesis
    -> versioned manifest + canonical digest
    -> constitutional validation
    -> side-effect-free dry-run
    -> explicit activation or recorded rejection
    -> receipts + fitness
    -> upgrade, rollback, or retirement review
```

The deterministic need compiler selects a small composition of registered primitives from explicit words and evidence classes. It cannot emit shell commands, arbitrary source code, or unregistered effects. It may compose a bounded inference, proposal-artifact, or Downloads-move primitive only when the need explicitly calls for it; those effects must be declared, the package is forced out of automatic mode, rehearsal cannot commit them, and execution must record a compensation. A proposal cannot become active directly: its digest, identity, version sequence, permissions, conditions, tests, rollback scope, and primitive set must validate, then every step must pass rehearsal. Upgrades preserve the prior package and rollback either restores that version or deactivates a version-one evolved capability.

## Persistent state

`backend/data/living-runtime.json` contains:

- identity and boot history;
- the runtime constitution;
- world entities and relations;
- normalized events;
- evidence-linked reflections;
- installed capabilities and package-version history;
- proposed, validated, rehearsed, installed, invalid, and rejected proposals;
- action receipts;
- user feedback;
- completed living cycles.

The file is runtime data and is intentionally ignored by git. Restarting the process resumes this state and records another boot event.

The older `backend/data/memory.json` remains the recall layer for facts, episodes, and associations. Deterministic grounded capabilities can receive relevant memory alongside current Living Runtime context.

`backend/data/surface-runtime.json` persists interface sessions separately: present focus, bounded conversation turns, current surface revision, and generation history. It does not turn a rendered screen into identity. A restart can regenerate the phenotype from the surviving world and conversation.

## Human authority

The runtime constitution separates six levels of behavior:

1. **Automatic:** observe, read the world model, reflect, write runtime state, and verify.
2. **Proposed:** compile a declarative package from a qualified pattern or expressed need.
3. **Validated and rehearsed:** prove authority and behavior without activation.
4. **Approval-gated:** activate, upgrade, roll back, or retire a capability.
5. **User-started and effect-declared:** run a bounded artifact-changing or configured-inference capability with explicit effect records and compensation metadata.
6. **Not authorized:** arbitrary filesystem mutation, undeclared external effects, shell execution, installation of generated source code, or constitutional change.

This distinction is essential. A system that merely says it repaired something is not living or reliable; it is unverified. A system that can change itself without a boundary is not rigorous; it is unsafe.

## Generative Surface loop

The former fixed React dashboard has been removed. `App.tsx` is now a session-aware container with an intent input, connection state, and a registry renderer.

```text
current utterance + recent conversation
    + identity / world / memory
    + capability packages / proposals / receipts
    + bounded workspace snapshot
    -> optional schema-constrained model composer
    -> protocol validation and catalog authorization
    -> living-surface/v1 document
    -> trusted React component registry
    -> typed action with surface revision + component + target
    -> backend authorization + execution
    -> new world state and recomposed phenotype
```

If the user asks about downstream risk, the surface contains a dependency graph and relevant capability controls. If the user asks to resume prior work, those components disappear and a memory stream, events, and reflection are composed. Capability proposals appear inline when they are contextually relevant. There is no fixed feature navigation.

The model does not generate JSX, JavaScript, selectors, endpoints, or arbitrary HTML. It may only select registered component types, server-owned data bindings, and declared actions in structured JSON. The backend rejects unknown components, incompatible bindings, undeclared actions, stale revisions, and targets not present in the bound surface data. This follows the same safety principle as A2UI: generated UI is declarative data; executable rendering remains trusted client code.

When model inference is disabled, the bounded adaptive policy emits the same surface protocol and labels provenance honestly as `adaptive-policy`. With Gemini enabled, structured output is constrained by the surface JSON schema and then independently validated. Model output is a proposed phenotype, not authority.

## What is real now

- DPI-aware Windows desktop capture with presence-aware adaptive cadence
- model-independent deterministic runtime policy
- local pixel capture with an explicit no-semantic-inference boundary
- deterministic content and metadata grounding
- persistent identity and world state with quarantine-on-corruption (never silent amnesia)
- phased metabolism: provider inference and effect verification run outside the state queue, so perception is never blocked by a slow model call
- normalized events from perception, interactions, notifications, and dependency scans
- continuous scheduled living cycles that rest when nothing is triggered
- evidence-linked reflections whose evidence leads with the triggering event
- bounded capability execution behind an execution-time authority gate re-checked at commit
- verification receipts that are hash-chained for tamper detection, archived instead of deleted, and independently filesystem-verified for artifact effects
- write-ahead effect journaling: pre-crash artifact intents are compensated on boot
- collision-safe artifact moves that never overwrite existing files
- explicit user feedback with honest fitness provenance (feedbackCount)
- counterfactual coverage analysis driving evolution, with speculative below-threshold proposals formed during idle-dream (labeled `speculative-simulation`, still approval-gated)
- repeated-pattern and need-driven capability proposals with open-proposal noise caps
- manifest validation, forbidden-primitive rejection, enforced trigger thresholds/cooldowns, and side-effect-free rehearsal
- approval-gated activation, version upgrades, and rollback
- package-linked transaction receipts and capability fitness
- runtime integrity audit including no-autopoietic-execution, receipt-ledger-integrity, persistence-health, constitution-integrity, and retirement-review checks
- bounded-time local and cloud model calls so no hung provider can wedge a queue
- refusal-aware health semantics: refused-authority receipts count as governance working, not work failing
- durable ledger anchor (`ledger-head.jsonl`) that flags forged or wholesale-deleted receipt history
- size-bounded rotation for append-only evidence archives
- compact `living_state` WebSocket digests instead of full-state re-broadcasts
- per-node renderer isolation on the phenotype (one broken node cannot kill the surface)
- exact-token memory retrieval with importance/recency weighting
- loopback-bound HTTP listener with a browser-origin allowlist on HTTP and WebSocket handshakes
- consent-gated clipboard reads (explicit POST confirmation)
- idempotent surface actions: replays cannot execute twice
- real OS-level idle detection for the dream phase
- LivingBench tests for governance, unsafe packages, network boundary, effect reversion, crash recovery, ledger tampering, concurrency guarantees, speculative evolution, upgrades, rollback, and feedback
- persistent generative-surface sessions and revisions
- context-dependent replacement of the complete component composition
- trusted component registry and binding resolution
- backend authorization for every generated UI action
- deduplicated, cached context harvesting shared by the world and phenotype loops
- explicit effect manifests and non-committing rehearsals for artifact-changing primitives
- bounded-time model calls so a hung provider cannot freeze the mutation queue

## What remains research work

- event-driven file and process watchers instead of periodic snapshots
- durable project/task/decision entities learned from multiple surfaces
- semantic retrieval beyond weighted token overlap; reflection consolidation
- independent semantic verification of model output (artifact effects are already filesystem-verified)
- signed implementation-bearing packages in a resource-limited subprocess sandbox
- full predictive coding: simulating future habitat states and counterfactual worlds beyond trigger-coverage replay
- Actor-model distribution across processes for multi-habitat deployments (single-machine phased concurrency is in place)
- automated retirement policy execution with human review (candidates are surfaced by audit today)
- authentication for non-browser local callers (the origin allowlist defends browsers and LAN exposure, not same-user processes)
- automated browser-level regression tests in CI
- LivingBench scenarios for deterministic perception provenance

The current system is therefore a minimal but actual Living Runtime with a living interface. It implements persistence, observation, bounded work, verification, feedback, capability growth, and contextual phenotype generation. It does not claim open-ended autonomous self-modification, unconstrained model authority, or general desktop competence.
