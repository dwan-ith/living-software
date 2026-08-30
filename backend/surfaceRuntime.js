import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import {
    authorizeSurfaceAction,
    digestSurfaceContext,
    normalizeSurfaceCandidate,
    surfaceActionKey,
    SURFACE_PROTOCOL
} from './surfaceProtocol.js';

const STATE_SCHEMA = 1;
const MAX_SESSIONS = 12;
const MAX_TURNS = 24;
const MAX_HISTORY = 16;
const MAX_ACTION_KEYS = 60;

function clean(value, max = 500) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clone(value) {
    return structuredClone(value);
}

function emptyState() {
    return { schemaVersion: STATE_SCHEMA, sessions: {} };
}

function normalizeState(parsed) {
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const sessions = {};
    for (const [id, raw] of Object.entries(parsed.sessions || {}).slice(-MAX_SESSIONS)) {
        if (!raw || typeof raw !== 'object') continue;
        sessions[id] = {
            id,
            focus: clean(raw.focus, 240),
            revision: Math.max(0, Number(raw.revision) || 0),
            turns: Array.isArray(raw.turns) ? raw.turns.slice(-MAX_TURNS) : [],
            history: Array.isArray(raw.history) ? raw.history.slice(0, MAX_HISTORY) : [],
            current: raw.current?.protocol === SURFACE_PROTOCOL ? raw.current : null,
            actionKeys: raw.actionKeys && typeof raw.actionKeys === 'object' && !Array.isArray(raw.actionKeys) ? raw.actionKeys : {},
            createdAt: raw.createdAt || new Date().toISOString(),
            updatedAt: raw.updatedAt || new Date().toISOString()
        };
    }
    return { schemaVersion: STATE_SCHEMA, sessions };
}

function component(id, type, region, width, title, binding, actions = [], description = '', limit = 8, props = {}) {
    return { id, type, region, width, title, description, binding, actions, limit, props };
}

export function composeAdaptiveSurface({ utterance = '', focus = '', context = {} } = {}) {
    const text = `${focus} ${utterance}`.toLowerCase();
    const pending = Number(context?.data?.living?.stats?.pendingProposals || 0);
    const components = [
        component(
            'current-intent',
            'intent-brief',
            'lead',
            'full',
            focus || utterance ? 'Surface composed for the present intent' : 'What needs to become possible now?',
            'living.reflections',
            ['surface.regenerate', 'living.cycle'],
            focus || utterance || 'Describe a goal, uncertainty, or changing situation. The runtime will compose the smallest useful interface from live context.',
            1,
            { intent: clean(utterance || focus, 300) }
        )
    ];

    if (/dependenc|import|graph|downstream|delete|break|coupl/.test(text)) {
        components.push(
            component('dependency-context', 'dependency-graph', 'main', 'full', 'Dependency field', 'workspace.dependencies', [], 'Only relationships and risk evidence relevant to the current workspace.', 18),
            component('workspace-context', 'workspace-map', 'context', 'half', 'Observed habitat', 'workspace.surfaces', [], 'Where the dependency evidence came from.', 10),
            component('risk-capabilities', 'capability-list', 'context', 'half', 'Available responses', 'living.capabilities', ['capability.run', 'capability.rollback'], 'Capabilities that can inspect or preserve continuity.', 6)
        );
    } else if (/proposal|capabilit|evolv|install|activate|rehears|rollback|fitness/.test(text) || pending > 0) {
        components.push(
            component('pending-evolution', 'proposal-list', 'main', 'full', 'Evolution awaiting judgment', 'living.proposals', ['proposal.validate', 'proposal.rehearse', 'proposal.activate', 'proposal.reject'], 'The lifecycle is rendered in the current workflow instead of a separate administration page.', 10),
            component('active-capabilities', 'capability-list', 'main', 'half', 'Current capability genome', 'living.capabilities', ['capability.run', 'capability.rollback'], '', 10),
            component('evolution-evidence', 'receipt-list', 'context', 'half', 'Selection evidence', 'living.receipts', ['receipt.useful', 'receipt.reject'], '', 8)
        );
    } else if (/memory|remember|recall|resume|continuity|history|previous/.test(text)) {
        components.push(
            component('continuity-memory', 'memory-stream', 'main', 'full', 'Continuity memory', 'memory.recent', [], 'Facts and episodes carried across sessions.', 16),
            component('memory-events', 'event-stream', 'context', 'half', 'Recent context changes', 'living.events', [], '', 10),
            component('memory-reflection', 'reflection-card', 'context', 'half', 'Current reflection', 'living.reflections', [], '', 3)
        );
    } else if (/world|screen|workspace|file|note|slide|download|gallery|notification|observe/.test(text)) {
        components.push(
            component('workspace-world', 'workspace-map', 'main', 'half', 'Workspace as a world', 'workspace.surfaces', [], '', 12),
            component('world-entities', 'world-entities', 'main', 'half', 'Live entities', 'living.world.entities', [], '', 16),
            component('world-events', 'event-stream', 'context', 'full', 'What changed', 'living.events', [], '', 12)
        );
    } else if (/audit|rigor|safe|govern|health|verify|receipt|effect/.test(text)) {
        components.push(
            component('runtime-metrics', 'metric-strip', 'main', 'full', 'Runtime evidence', 'living.stats', [], '', 8),
            component('work-receipts', 'receipt-list', 'main', 'half', 'Verified work', 'living.receipts', ['receipt.useful', 'receipt.reject'], '', 10),
            component('runtime-law', 'constitution-card', 'context', 'half', 'Constitution', 'living.constitution', [], '', 1)
        );
    } else {
        components.push(
            component('persistent-self', 'runtime-identity', 'main', 'half', 'Persistent identity', 'living.identity', ['surface.regenerate'], '', 1),
            component('living-loops', 'loop-status', 'main', 'half', 'Current metabolism', 'living.loops', ['living.cycle'], '', 3),
            component('recent-reflection', 'reflection-card', 'context', 'half', 'Current reflection', 'living.reflections', [], '', 3),
            component('recent-events', 'event-stream', 'context', 'half', 'Recent changes', 'living.events', [], '', 8)
        );
    }

    components.push(component('surface-provenance', 'generation-trace', 'context', 'full', 'Why this interface exists', 'none', ['surface.regenerate'], 'This phenotype is disposable; identity, memory, and capabilities are not.', 1));
    return {
        title: clean(focus || utterance, 100) || 'Living Software',
        rationale: 'The interface was composed from the current intent, live world state, capability lifecycle, and available evidence.',
        focus: clean(focus || utterance, 240) || 'Translate changing context into the next useful interaction.',
        layout: components.length > 5 ? 'canvas' : 'split',
        components
    };
}

export class SurfaceRuntime {
    constructor(options = {}) {
        this.dataPath = options.dataPath || path.join(DATA_DIR, 'surface-runtime.json');
        this.contextProvider = options.contextProvider || (async () => ({ data: {}, promptContext: {} }));
        this.generator = options.generator || null;
        this.clock = options.clock || (() => new Date());
        this.idFactory = options.idFactory || randomUUID;
        this.state = null;
        this.initialized = false;
        this.initializePromise = null;
        this.queue = Promise.resolve();
    }

    _now() {
        return this.clock().toISOString();
    }

    _id(prefix) {
        return `${prefix}-${this.idFactory()}`;
    }

    async initialize() {
        if (this.initialized) return;
        if (!this.initializePromise) this.initializePromise = this._initialize();
        await this.initializePromise;
    }

    async _initialize() {
        await mkdir(path.dirname(this.dataPath), { recursive: true });
        try {
            this.state = normalizeState(JSON.parse(await readFile(this.dataPath, 'utf8')));
        } catch {
            this.state = emptyState();
        }
        this.initialized = true;
    }

    async _save() {
        const temporary = `${this.dataPath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
        await rename(temporary, this.dataPath);
    }

    _session(sessionId) {
        const id = clean(sessionId, 120) || this._id('session');
        if (!this.state.sessions[id]) {
            const now = this._now();
            this.state.sessions[id] = { id, focus: '', revision: 0, turns: [], history: [], current: null, actionKeys: {}, createdAt: now, updatedAt: now };
            const ordered = Object.values(this.state.sessions).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
            this.state.sessions = Object.fromEntries(ordered.slice(0, MAX_SESSIONS).map((item) => [item.id, item]));
        }
        if (!this.state.sessions[id].actionKeys) this.state.sessions[id].actionKeys = {};
        return this.state.sessions[id];
    }

    /**
     * Idempotency: an identical (surface, revision, component, action, target)
     * tuple that already executed is a replay — likely a double click or a
     * duplicated request — and must never execute twice (e.g. two file moves).
     */
    async authorizeAction(sessionId, input) {
        await this.initialize();
        const session = this.state.sessions[clean(sessionId, 120)];
        const key = surfaceActionKey(input);
        if (session?.actionKeys?.[key]) {
            throw new Error(`This exact action already ran on revision ${Number(input.revision)}; the surface has been regenerated since.`);
        }
        const surface = await this.getCurrent(sessionId);
        return { surface, ...authorizeSurfaceAction(surface, input), actionKey: key };
    }

    async compose(input = {}) {
        await this.initialize();
        const run = this.queue.then(async () => {
            const session = this._session(input.sessionId);
            const utterance = clean(input.utterance, 1200);
            const requestedFocus = clean(input.focus, 240);
            if (utterance) {
                session.turns.push({ role: 'user', text: utterance, createdAt: this._now() });
                session.turns = session.turns.slice(-MAX_TURNS);
            }
            session.focus = requestedFocus || utterance || session.focus || 'Translate changing context into the next useful interaction.';

            const context = await this.contextProvider({
                session: clone(session),
                utterance,
                focus: session.focus,
                reason: clean(input.reason, 100) || 'compose',
                viewport: input.viewport || null
            });
            const promptContext = context?.promptContext || context?.data || {};
            const contextDigest = digestSurfaceContext(promptContext);
            const warnings = [];
            let candidate = null;
            let mode = 'adaptive-policy';
            let provider = 'local-context-policy';
            let model = null;
            const startedAt = Date.now();

            if (this.generator?.available?.()) {
                try {
                    const generated = await this.generator.compose({
                        session: clone(session),
                        utterance,
                        focus: session.focus,
                        previousSurface: session.current ? {
                            title: session.current.title,
                            focus: session.current.focus,
                            components: session.current.components.map((item) => ({ type: item.type, binding: item.binding }))
                        } : null,
                        context: promptContext
                    });
                    candidate = normalizeSurfaceCandidate(generated.candidate);
                    mode = 'model-composed';
                    provider = generated.provider || 'generative-provider';
                    model = generated.model || null;
                } catch (error) {
                    warnings.push(`Generative composer rejected: ${clean(error.message, 240)}`);
                }
            } else {
                warnings.push('Generative provider is dormant; composed from the bounded context policy.');
            }

            if (!candidate) {
                candidate = normalizeSurfaceCandidate(composeAdaptiveSurface({ utterance, focus: session.focus, context }));
            }

            session.revision += 1;
            const now = this._now();
            const surface = {
                protocol: SURFACE_PROTOCOL,
                id: this._id('surface'),
                sessionId: session.id,
                revision: session.revision,
                title: candidate.title,
                rationale: candidate.rationale,
                focus: candidate.focus,
                layout: candidate.layout,
                components: candidate.components,
                data: clone(context?.data || {}),
                generation: {
                    mode,
                    provider,
                    model,
                    contextDigest,
                    latencyMs: Date.now() - startedAt,
                    warnings
                },
                generatedAt: now
            };
            session.current = surface;
            session.updatedAt = now;
            session.history.unshift({
                id: surface.id,
                revision: surface.revision,
                title: surface.title,
                focus: surface.focus,
                componentTypes: surface.components.map((item) => item.type),
                generation: surface.generation,
                generatedAt: now
            });
            session.history = session.history.slice(0, MAX_HISTORY);
            await this._save();
            return clone(surface);
        });
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }

    async getCurrent(sessionId) {
        await this.initialize();
        const session = this.state.sessions[clean(sessionId, 120)];
        return session?.current ? clone(session.current) : null;
    }

    async recordAction(sessionId, action = {}) {
        await this.initialize();
        const run = this.queue.then(async () => {
            const session = this._session(sessionId);
            // Only successful executions consume the idempotency key, so a
            // genuinely failed action can be retried.
            if (action.actionKey) {
                session.actionKeys[action.actionKey] = { summary: clean(action.summary || '', 300), at: this._now() };
                const keys = Object.entries(session.actionKeys)
                    .sort((a, b) => Date.parse(b[1].at || 0) - Date.parse(a[1].at || 0))
                    .slice(0, MAX_ACTION_KEYS);
                session.actionKeys = Object.fromEntries(keys);
            }
            session.turns.push({
                role: 'action',
                text: clean(`${action.action || 'surface.action'} ${action.targetId || ''}: ${action.summary || 'completed'}`, 600),
                createdAt: this._now()
            });
            session.turns = session.turns.slice(-MAX_TURNS);
            session.updatedAt = this._now();
            await this._save();
            return clone(session);
        });
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }
}
