import { createHash, randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, extractJsonObject, GEMINI_MODEL, getGemini, hasGemini, pathExists, PROJECT_ROOT_DIR } from './config.js';
import { atomicWriteFile, loadJsonWithQuarantine } from './persistence.js';
import { readFileContent } from './workspaceAdapters.js';
import {
    createCapabilityPackage,
    FORBIDDEN_PRIMITIVES,
    normalizeCapabilityMetrics,
    normalizeCapabilityRecord,
    PRIMITIVE_EFFECTS,
    SAFE_PERMISSIONS,
    SAFE_PRIMITIVES,
    validateCapabilityPackage
} from './capabilityKernel.js';

const SCHEMA_VERSION = 2;
const LIMITS = {
    entities: 300,
    events: 500,
    reflections: 120,
    receipts: 240,
    cycles: 120,
    proposals: 80
};
// Append-only journals rotate once they pass this bound; the rotated copy is
// preserved, so rotation never destroys evidence.
const ARCHIVE_ROTATE_BYTES = 50 * 1024 * 1024;

const BUILTIN_CAPABILITIES = [
    {
        id: 'continuity.snapshot',
        name: 'Continuity Snapshot',
        description: 'Capture a verified, durable summary of the current habitat so work can resume across sessions.',
        origin: 'built-in',
        version: 1,
        status: 'active',
        automatic: true,
        trigger: { eventKinds: ['runtime.boot', 'world.observed', 'user.intent'] },
        permissions: ['read:world', 'write:living-state'],
        steps: [{ primitive: 'world.snapshot' }],
        metrics: { runs: 0, verified: 0, rejected: 0, lastRunAt: null }
    },
    {
        id: 'context.reflect',
        name: 'Context Reflection',
        description: 'Turn recent events into a higher-level reflection with evidence and a bounded recommendation.',
        origin: 'built-in',
        version: 1,
        status: 'active',
        automatic: true,
        trigger: { eventKinds: ['perception.analysis', 'workspace.notification', 'artifact.analysis'] },
        permissions: ['read:events', 'write:living-state'],
        steps: [{ primitive: 'context.reflect' }],
        metrics: { runs: 0, verified: 0, rejected: 0, lastRunAt: null }
    },
    {
        id: 'workspace.risk-map',
        name: 'Workspace Risk Map',
        description: 'Summarize grounded dependency and intervention evidence without mutating user files.',
        origin: 'built-in',
        version: 1,
        status: 'active',
        automatic: true,
        trigger: { eventKinds: ['screen.intervention', 'workspace.risk'] },
        permissions: ['read:world', 'read:workspace', 'write:living-state'],
        steps: [{ primitive: 'risk.summarize' }, { primitive: 'context.reflect' }],
        metrics: { runs: 0, verified: 0, rejected: 0, lastRunAt: null }
    },
    // --- Jules White expansion: capabilities that act on the world ---
    {
        id: 'workspace.nightly-digest',
        name: 'Nightly Digest',
        description: 'When the system is idle, synthesize today\'s events into a Markdown digest proposal saved to Living-Proposals/.',
        origin: 'built-in',
        version: 2,
        status: 'active',
        automatic: false,
        trigger: { eventKinds: ['idle-dream'] },
        permissions: ['read:events', 'write:living-state', 'write:proposals'],
        steps: [{ primitive: 'gemini.synthesize' }, { primitive: 'write.proposal' }],
        metrics: { runs: 0, verified: 0, rejected: 0, lastRunAt: null }
    },
    {
        id: 'downloads.auto-sort',
        name: 'Downloads Auto-Sort',
        description: 'Classify each new file in Downloads using Gemini and move it to a semantic project subfolder.',
        origin: 'built-in',
        version: 2,
        status: 'active',
        automatic: false,
        trigger: { eventKinds: ['file.sort-requested'] },
        permissions: ['read:workspace-content', 'write:living-state', 'write:downloads-sort'],
        steps: [{ primitive: 'workspace.read' }, { primitive: 'gemini.synthesize' }, { primitive: 'file.sort' }],
        metrics: { runs: 0, verified: 0, rejected: 0, lastRunAt: null }
    }
];

function clone(value) {
    return structuredClone(value);
}

function cap(items, limit) {
    return items.slice(0, limit);
}

function cleanText(value, max = 800) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function pathWithin(base, candidate) {
    const relative = path.relative(path.resolve(base), path.resolve(candidate));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeFolderName(value) {
    const name = cleanText(value, 80);
    if (!name || name === '.' || name === '..' || !/^[a-z0-9][a-z0-9 ._-]{0,79}$/i.test(name)) return null;
    return name;
}

function sanitizeData(value, depth = 0) {
    if (depth > 4) return '[depth-limited]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeData(item, depth + 1));
    if (typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value).slice(0, 40)) {
            if (/^(image|audio|video)Base64$/i.test(key)) {
                result[key] = '[binary omitted]';
                continue;
            }
            result[key] = sanitizeData(item, depth + 1);
        }
        return result;
    }
    return cleanText(value);
}

function slug(value) {
    return cleanText(value, 80)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'capability';
}

/** Deterministic JSON: sorted object keys, no whitespace, stable across processes. */
function canonicalJson(value) {
    if (value === undefined) return 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function digestReceipt(receipt) {
    const { ledgerPrev, ledgerDigest, ...core } = receipt;
    return createHash('sha256').update(canonicalJson(core)).digest('hex');
}

function humanize(value) {
    return cleanText(value, 80)
        .split(/[._:-]+/)
        .filter(Boolean)
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join(' ');
}

function seedState(now) {
    return {
        schemaVersion: SCHEMA_VERSION,
        identity: {
            id: 'living-software-local',
            name: 'Living Software',
            habitat: 'persistent-windows-workspace',
            thesis: 'Translate changing human context into verified action and grow bounded capabilities when existing abstractions are insufficient.',
            createdAt: now,
            lastBootAt: now,
            bootCount: 0
        },
        constitution: {
            autonomy: 'bounded',
            automaticPermissions: ['observe', 'read-world', 'write-runtime-state', 'reflect', 'verify'],
            approvalRequired: ['install-capability', 'modify-user-files', 'external-side-effect', 'change-constitution'],
            principles: [
                'Ground claims in observable evidence.',
                'Prefer reversible actions and emit receipts.',
                'Separate proposals from installed capabilities.',
                'Never treat model output as successful action without verification.',
                'Never execute model-authored code; models may only compose registered primitives.',
                'Keep the user in control of capability growth and external side effects.'
            ]
        },
        world: {
            revision: 0,
            observedAt: null,
            lastEventAt: null,
            entities: [],
            relations: []
        },
        events: [],
        reflections: [],
        capabilities: BUILTIN_CAPABILITIES.map((capability) => normalizeCapabilityRecord(clone(capability))),
        proposals: [],
        receipts: [],
        cycles: []
    };
}

function normalizeState(parsed, now) {
    const seed = seedState(now);
    if (!parsed || typeof parsed !== 'object') return seed;

    const capabilities = (Array.isArray(parsed.capabilities) ? parsed.capabilities : []).map((capability) => normalizeCapabilityRecord(capability));
    const capabilityIds = new Set(capabilities.map((item) => item.id));
    for (const builtin of BUILTIN_CAPABILITIES) {
        const existing = capabilities.find((item) => item.id === builtin.id);
        if (!existing) {
            capabilities.push(normalizeCapabilityRecord(clone(builtin)));
            continue;
        }
        if (Number(existing.version || 0) < Number(builtin.version || 1)) {
            const upgraded = normalizeCapabilityRecord({ ...clone(builtin), metrics: existing.metrics });
            upgraded.packageHistory = [
                {
                    package: clone(existing.package),
                    name: existing.name,
                    description: existing.description,
                    automatic: existing.automatic,
                    trigger: clone(existing.trigger),
                    permissions: clone(existing.permissions),
                    steps: clone(existing.steps),
                    supersededAt: now,
                    reason: 'Built-in capability constitution upgrade.'
                },
                ...(existing.packageHistory || [])
            ].slice(0, 12);
            capabilities.splice(capabilities.indexOf(existing), 1, upgraded);
        }
    }

    return {
        ...seed,
        ...parsed,
        schemaVersion: SCHEMA_VERSION,
        identity: { ...seed.identity, ...(parsed.identity || {}) },
        constitution: { ...seed.constitution, ...(parsed.constitution || {}) },
        world: {
            ...seed.world,
            ...(parsed.world || {}),
            entities: Array.isArray(parsed.world?.entities) ? parsed.world.entities : [],
            relations: Array.isArray(parsed.world?.relations) ? parsed.world.relations : []
        },
        events: Array.isArray(parsed.events) ? parsed.events : [],
        reflections: Array.isArray(parsed.reflections) ? parsed.reflections : [],
        capabilities,
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
        receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
        cycles: Array.isArray(parsed.cycles) ? parsed.cycles : []
    };
}

export class LivingRuntime {
    constructor(options = {}) {
        this.dataPath = options.dataPath || path.join(DATA_DIR, 'living-runtime.json');
        this.clock = options.clock || (() => new Date());
        this.idFactory = options.idFactory || randomUUID;
        // Filesystem authority roots. The server never lets request bodies
        // override these; only the process owner (or a test) may narrow them.
        this.workspaceRoot = options.workspaceRoot || PROJECT_ROOT_DIR;
        this.downloadsDir = options.downloadsDir || path.join(os.homedir(), 'Downloads');
        this.archiveRotateBytes = options.archiveRotateBytes || ARCHIVE_ROTATE_BYTES;
        this.state = null;
        this.initialized = false;
        this.initializePromise = null;
        this.queue = Promise.resolve();
        // Serializes append-only journal writes (archives, effect WAL).
        this.archiveQueue = Promise.resolve();
        // Non-null when the last persistence attempt failed: memory and disk are
        // divergent until the next successful save. Surfaced by health() and audit().
        this.persistError = null;
    }

    _now() {
        return this.clock().toISOString();
    }

    _id(prefix) {
        return `${prefix}-${this.idFactory()}`;
    }

    async initialize() {
        if (this.initialized) return this.getState();
        if (!this.initializePromise) this.initializePromise = this._initialize();
        await this.initializePromise;
        return this.getState();
    }

    async _initialize() {
        const now = this._now();
        await mkdir(path.dirname(this.dataPath), { recursive: true });
        const { data: parsed, quarantinedTo } = await loadJsonWithQuarantine(this.dataPath);
        this.state = parsed ? normalizeState(parsed, now) : seedState(now);
        if (quarantinedTo) {
            // A corrupt state file must never be silently overwritten by the next
            // save. Quarantine it, seed fresh, and record the incident as evidence.
            this.state.events.unshift({
                id: this._id('event'),
                kind: 'runtime.state-quarantined',
                source: 'living-runtime',
                summary: `The persisted state file could not be parsed and was quarantined; identity resumed from a fresh seed.`,
                importance: 1,
                data: { quarantinedTo },
                dedupeKey: `runtime.state-quarantined:${quarantinedTo}`,
                createdAt: now
            });
            this.persistError = null;
        }
        await this._reconcileEffectJournal(this.state);

        this.state.identity.bootCount = Number(this.state.identity.bootCount || 0) + 1;
        this.state.identity.lastBootAt = now;
        this._appendEvent(this.state, {
            kind: 'runtime.boot',
            source: 'living-runtime',
            summary: `Living Software resumed in ${this.state.identity.habitat}.`,
            importance: 0.8,
            data: { bootCount: this.state.identity.bootCount, receiptLedgerDepth: this.state.receipts.length },
            dedupeKey: `runtime.boot:${this.state.identity.bootCount}`
        });
        await this._save();
        this.initialized = true;
    }

    async _save() {
        try {
            await atomicWriteFile(this.dataPath, `${JSON.stringify(this.state, null, 2)}\n`);
            this.persistError = null;
        } catch (error) {
            // Never pretend a mutation was durable when it was not: memory and disk
            // are now divergent until the next successful save.
            this.persistError = `${error?.code || ''} ${error?.message || error}`.trim().slice(0, 300);
            throw error;
        }
    }

    async _mutate(operation) {
        await this.initialize();
        const run = this.queue.then(async () => {
            const result = await operation(this.state);
            await this._save();
            return result;
        });
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }

    _appendEvent(state, input) {
        const now = this._now();
        const kind = cleanText(input.kind, 100) || 'runtime.event';
        const summary = cleanText(input.summary, 600) || humanize(kind);
        const dedupeKey = cleanText(input.dedupeKey, 180);

        if (dedupeKey) {
            const existing = state.events.find((event) => event.dedupeKey === dedupeKey);
            if (existing && Date.parse(now) - Date.parse(existing.createdAt) < 30_000) return existing;
        }

        const event = {
            id: this._id('event'),
            kind,
            source: cleanText(input.source, 120) || 'runtime',
            summary,
            importance: Math.max(0, Math.min(1, Number(input.importance) || 0.5)),
            entityIds: Array.isArray(input.entityIds) ? input.entityIds.map((item) => cleanText(item, 160)).filter(Boolean).slice(0, 20) : [],
            data: sanitizeData(input.data || {}),
            dedupeKey: dedupeKey || null,
            createdAt: now
        };
        state.events.unshift(event);
        state.events = this._evict(state.events, LIMITS.events, 'events-archive.jsonl');
        state.world.lastEventAt = now;
        return event;
    }

    /**
     * History is evidence: entries pushed out of the hot window are appended to
     * an append-only JSONL journal beside the state file instead of being
     * destroyed by the cap. Appends are serialized through a dedicated queue so
     * journal lines can never interleave, and archives rotate at a size bound
     * so a long-lived runtime cannot grow them without limit.
     */
    _evict(items, limit, archiveName) {
        if (items.length <= limit) return items.slice(0, limit);
        const overflow = items.slice(limit);
        const lines = overflow.map((item) => JSON.stringify(item)).join('\n');
        this._scheduleArchiveAppend(archiveName, `${lines}\n`);
        return items.slice(0, limit);
    }

    _scheduleArchiveAppend(archiveName, chunk) {
        const archivePath = path.join(path.dirname(this.dataPath), archiveName);
        const write = this.archiveQueue.then(async () => {
            try {
                const info = await stat(archivePath);
                if (info.size + chunk.length > this.archiveRotateBytes) {
                    await rename(archivePath, `${archivePath}.${Date.now()}.rotated`);
                }
            } catch { /* first write: no file yet */ }
            await appendFile(archivePath, chunk, 'utf8');
        });
        this.archiveQueue = write.catch(() => undefined);
        write.catch((error) => console.warn(`[LivingRuntime] archive write failed for ${archiveName}: ${error.message}`));
    }

    _publicState(state = this.state) {
        // Refusals are the immune system working, not work failing: they carry
        // zero executed effects and are excluded from verification statistics.
        const gradedReceipts = state.receipts.filter((receipt) => receipt.status !== 'refused-authority');
        const verifiedReceipts = gradedReceipts.filter((receipt) => receipt.status === 'verified').length;
        const refusedReceipts = state.receipts.length - gradedReceipts.length;
        const activeCapabilities = state.capabilities.filter((capability) => capability.status === 'active').length;
        const pendingProposals = state.proposals.filter((proposal) => ['proposed', 'validated', 'rehearsed'].includes(proposal.status)).length;
        const packageVersions = state.capabilities.reduce((count, capability) => count + 1 + (capability.packageHistory?.length || 0), 0);
        const fitnessScores = state.capabilities.filter((capability) => capability.status === 'active').map((capability) => Number(capability.metrics?.fitness?.score || 0));
        return {
            ...clone(state),
            stats: {
                entities: state.world.entities.length,
                events: state.events.length,
                reflections: state.reflections.length,
                activeCapabilities,
                pendingProposals,
                verifiedReceipts,
                refusedReceipts,
                packageVersions,
                averageFitness: fitnessScores.length ? Math.round(fitnessScores.reduce((sum, score) => sum + score, 0) / fitnessScores.length) : 0,
                verificationRate: gradedReceipts.length ? Math.round((verifiedReceipts / gradedReceipts.length) * 100) : 100
            },
            loops: {
                world: { status: state.world.observedAt ? 'observing' : 'waiting', lastAt: state.world.observedAt, revision: state.world.revision },
                work: { status: state.receipts[0]?.status || 'waiting', lastAt: state.receipts[0]?.createdAt || null },
                evolution: { status: pendingProposals ? 'proposal-ready' : 'watching-patterns', lastAt: state.proposals[0]?.createdAt || null }
            },
            persistence: {
                durable: !this.persistError,
                error: this.persistError,
                receiptLedger: this._verifyReceiptLedger(state)
            }
        };
    }

    async getState() {
        if (!this.initialized) await this.initialize();
        await this.queue;
        return this._publicState();
    }

    async contextForPrompt() {
        const state = await this.getState();
        const activeEntities = state.world.entities.slice(0, 12).map((entity) => `${entity.label} (${entity.state})`).join(', ');
        const reflections = state.reflections.slice(0, 3).map((item) => item.summary).join(' | ');
        const capabilities = state.capabilities.filter((item) => item.status === 'active').map((item) => item.name).slice(0, 12).join(', ');
        return [
            `Identity: ${state.identity.name} in ${state.identity.habitat}; world revision ${state.world.revision}.`,
            `Active world: ${activeEntities || 'not observed yet'}.`,
            `Recent reflection: ${reflections || 'none yet'}.`,
            `Installed capabilities: ${capabilities || 'none'}.`,
            `Authority: ${state.constitution.autonomy}; approval required for ${state.constitution.approvalRequired.join(', ')}.`
        ].join('\n');
    }

    async recordEvent(input) {
        return this._mutate((state) => this._appendEvent(state, input));
    }

    async recordEvents(inputs = []) {
        return this._mutate((state) => inputs.slice(0, 20).map((input) => this._appendEvent(state, input)));
    }

    _observeWorld(state, snapshot, source = 'workspace-system-map') {
        const now = this._now();
        const revision = Number(state.world.revision || 0) + 1;
        const surfaces = Array.isArray(snapshot?.surfaces) ? snapshot.surfaces : [];
        const previous = new Map(state.world.entities.map((entity) => [entity.id, entity]));
        const changed = [];

        for (const surface of surfaces) {
            const id = `surface:${cleanText(surface.id, 80) || slug(surface.label)}`;
            const before = previous.get(id);
            const entity = {
                id,
                kind: 'surface',
                label: cleanText(surface.label, 120) || humanize(surface.id),
                state: cleanText(surface.status, 80) || 'observed',
                authority: cleanText(surface.authority, 260),
                metrics: { count: Number(surface.count) || 0 },
                // Provenance: which observation source and world revision produced this entity.
                provenanceSource: cleanText(source, 120),
                observedInRevision: revision,
                firstSeenAt: before?.firstSeenAt || now,
                lastSeenAt: now
            };
            if (!before || before.state !== entity.state || before.metrics?.count !== entity.metrics.count) changed.push(id);
            previous.set(id, entity);
        }

        state.world.entities = cap([...previous.values()].sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))), LIMITS.entities);
        state.world.relations = cap(surfaces
            .filter((surface) => surface.id !== 'screen')
            .map((surface) => ({
                id: `relation:screen:${cleanText(surface.id, 80)}`,
                from: 'surface:screen',
                to: `surface:${cleanText(surface.id, 80)}`,
                kind: 'contextualizes',
                updatedAt: now
            })), LIMITS.entities);
        state.world.observedAt = now;
        state.world.revision = revision;

        const event = this._appendEvent(state, {
            kind: 'world.observed',
            source,
            summary: `Observed ${surfaces.length} habitat surfaces; ${changed.length} changed since the previous world model.`,
            importance: changed.length ? 0.7 : 0.35,
            entityIds: changed,
            data: { revision: state.world.revision, surfaces: surfaces.length, changed },
            dedupeKey: `world.observed:${state.world.revision}`
        });
        return { event, changed, revision: state.world.revision };
    }

    async observeWorld(snapshot, options = {}) {
        return this._mutate((state) => this._observeWorld(state, snapshot, options.source));
    }

    _deriveReflection(state, reason) {
        const recent = state.events
            .filter((event) => !event.kind.startsWith('cycle.'))
            .slice(0, 20);
        const risk = recent.find((event) => ['screen.intervention', 'workspace.risk'].includes(event.kind));
        const intent = recent.find((event) => event.kind === 'user.intent');
        const changed = recent.find((event) => event.kind === 'world.observed' && Number(event.data?.changed?.length || 0) > 0);

        let kind = 'continuity';
        let headline = 'The habitat is being maintained';
        let summary = `Living Software retained world revision ${state.world.revision} across ${state.world.entities.length} entities.`;
        let recommendation = 'Continue observing and preserve context without interrupting the user.';
        let triggerEvent = null;

        if (risk) {
            kind = 'risk';
            headline = 'A grounded risk entered the world model';
            summary = risk.summary;
            recommendation = 'Run the risk-map capability and keep any external repair approval-gated.';
            triggerEvent = risk;
        } else if (intent) {
            kind = 'intent';
            headline = 'New human context can reshape the runtime';
            summary = intent.summary;
            recommendation = 'Translate the intent through installed capabilities; propose growth only if a capability is missing.';
            triggerEvent = intent;
        } else if (changed) {
            kind = 'change';
            headline = 'The habitat changed';
            summary = changed.summary;
            recommendation = 'Refresh continuity and look for repeated patterns rather than treating every change as an error.';
            triggerEvent = changed;
        }

        // Evidence must be relevant, not just recent: the triggering event leads,
        // and remaining slots go to its entity-linked siblings before raw recency.
        const evidenceIds = [];
        if (triggerEvent) {
            evidenceIds.push(triggerEvent.id);
            for (const event of recent) {
                if (evidenceIds.length >= 6) break;
                const linked = (triggerEvent.entityIds || []).some((entityId) => event.entityIds?.includes(entityId));
                if (event.id !== triggerEvent.id && (linked || event.kind === triggerEvent.kind)) evidenceIds.push(event.id);
            }
        }
        for (const event of recent) {
            if (evidenceIds.length >= 6) break;
            evidenceIds.push(event.id);
        }

        const reflection = {
            id: this._id('reflection'),
            kind,
            headline,
            summary,
            recommendation,
            reason: cleanText(reason, 120) || 'scheduled',
            evidenceEventIds: [...new Set(evidenceIds)].slice(0, 6),
            createdAt: this._now()
        };
        return reflection;
    }

    _appendReflection(state, reflection) {
        state.reflections.unshift(reflection);
        state.reflections = cap(state.reflections, LIMITS.reflections);
    }

    async _runPrimitive(state, primitive, context, reflection, mode = 'commit') {
        if (primitive === 'world.snapshot') {
            return {
                primitive,
                output: {
                    revision: state.world.revision,
                    observedAt: state.world.observedAt,
                    entityCount: state.world.entities.length,
                    activeSurfaces: state.world.entities.filter((entity) => entity.kind === 'surface').map((entity) => ({ id: entity.id, state: entity.state, count: entity.metrics?.count || 0 })).slice(0, 30)
                },
                verified: Number.isInteger(state.world.revision) && state.world.entities.length >= 0,
                evidence: [`world.revision=${state.world.revision}`, `entities=${state.world.entities.length}`]
            };
        }

        if (primitive === 'context.reflect') {
            const selected = reflection || state.reflections[0];
            return {
                primitive,
                output: selected ? { reflectionId: selected.id, headline: selected.headline, recommendation: selected.recommendation } : null,
                verified: Boolean(selected?.id),
                evidence: selected ? [`reflection=${selected.id}`, `${selected.evidenceEventIds.length} evidence events`] : ['no reflection available']
            };
        }

        if (primitive === 'risk.summarize') {
            const files = Array.isArray(context?.dependencies?.files) ? context.dependencies.files : [];
            const high = files.filter((file) => file.risk === 'high');
            const medium = files.filter((file) => file.risk === 'medium');
            const intervention = state.events.find((event) => event.kind === 'screen.intervention');
            return {
                primitive,
                output: {
                    highRiskFiles: high.slice(0, 10).map((file) => ({ name: file.name, references: file.references || 0, signals: file.signals || [] })),
                    mediumRiskCount: medium.length,
                    latestIntervention: intervention?.summary || null
                },
                verified: Boolean(files.length || intervention),
                evidence: [`dependency candidates=${files.length}`, intervention ? `intervention=${intervention.id}` : 'no current intervention']
            };
        }

        // --- Jules White primitives ---

        if (primitive === 'workspace.read') {
            let filePath = context?.filePath || null;
            let autoSelected = false;
            try {
                if (!filePath) {
                    // No explicit target: deterministically select the newest top-level
                    // file in Downloads so the auto-sort package is executable without
                    // the caller supplying private context.
                    const entries = await readdir(this.downloadsDir, { withFileTypes: true });
                    let newest = null;
                    for (const entry of entries.slice(0, 300)) {
                        if (!entry.isFile() || entry.name.startsWith('.')) continue;
                        const candidate = path.join(this.downloadsDir, entry.name);
                        const info = await stat(candidate).catch(() => null);
                        if (!info) continue;
                        if (!newest || info.mtimeMs > newest.mtimeMs) newest = { filePath: candidate, mtimeMs: info.mtimeMs };
                    }
                    if (!newest) return { primitive, output: null, verified: false, evidence: ['Downloads contains no files to read'] };
                    filePath = newest.filePath;
                    autoSelected = true;
                }
            } catch (error) {
                return { primitive, output: null, verified: false, evidence: [`workspace-read-error: ${error.message}`] };
            }
            const readable = pathWithin(this.workspaceRoot, filePath)
                || pathWithin(this.downloadsDir, filePath)
                || pathWithin(path.join(os.homedir(), 'Documents'), filePath);
            if (!readable) return { primitive, output: null, verified: false, evidence: ['filePath is outside the declared workspace roots'] };
            const content = await readFileContent(filePath, 8192);
            return {
                primitive,
                output: { filePath, fileName: path.basename(filePath), contentLength: content.length, preview: content.slice(0, 400) },
                verified: content.length > 0,
                evidence: [
                    `${autoSelected ? 'auto-selected newest download' : 'caller-supplied file'} ${path.basename(filePath)}`,
                    `read ${content.length} bytes`
                ]
            };
        }

        if (primitive === 'gemini.synthesize') {
            if (!hasGemini()) return { primitive, output: null, verified: false, evidence: ['gemini not configured'] };
            const readOutput = (Array.isArray(context?.priorOutputs) ? context.priorOutputs : [])
                .find((item) => item.primitive === 'workspace.read' && item.output?.filePath)?.output || null;
            let prompt = context?.synthesizePrompt || null;
            let wantsJsonFolder = false;
            if (!prompt && readOutput?.filePath) {
                wantsJsonFolder = true;
                prompt = `Classify this file into one concise, existing-sounding project folder name (1-4 words).\n\nFile: ${readOutput.fileName}\nPreview:\n${(readOutput.preview || '').slice(0, 600)}\n\nReply ONLY as JSON: {"targetFolder":"..."}`;
            }
            if (!prompt) {
                const recentEvents = state.events.filter((e) => !e.kind.startsWith('cycle.')).slice(0, 12)
                    .map((e) => `[${e.kind}] ${e.summary}`).join('\n');
                prompt = `You are the evolution engine of a living computer.\n\nRecent habitat events:\n${recentEvents}\n\nLatest reflection: ${reflection?.summary || '(none)'}\n\nDraft a concise Markdown proposal for what capability this system should develop next. Be specific and grounded. Max 400 words.`;
            }
            const declaredEffects = [{ kind: 'external-inference', provider: 'gemini', model: GEMINI_MODEL }];
            if (mode !== 'commit') {
                return {
                    primitive,
                    output: { text: '[rehearsal synthesis placeholder]', model: GEMINI_MODEL, promptLength: prompt.length, rehearsal: true },
                    verified: true,
                    evidence: [`gemini-provider-ready=${GEMINI_MODEL}`, 'no inference request sent during rehearsal'],
                    declaredEffects,
                    externalEffects: [],
                    userArtifactMutations: []
                };
            }
            try {
                const ai = getGemini();
                const response = await ai.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    config: {
                        temperature: 0.4,
                        httpOptions: { timeout: 45000 },
                        systemInstruction: wantsJsonFolder
                            ? 'You classify files for a living computer. Return only the requested JSON.'
                            : 'You are the evolution engine of a living computer. Draft concise, grounded, reversible proposals only. No hallucinated features.'
                    }
                });
                const text = response.text || '';
                if (wantsJsonFolder) {
                    const parsed = extractJsonObject(text);
                    const targetFolder = cleanText(parsed?.targetFolder, 60);
                    return {
                        primitive,
                        output: { text, targetFolder: targetFolder || null, model: GEMINI_MODEL },
                        verified: Boolean(targetFolder),
                        evidence: [`gemini-model=${GEMINI_MODEL}`, targetFolder ? `classified as "${targetFolder}"` : 'no usable classification in response'],
                        declaredEffects,
                        externalEffects: [{ kind: 'model-inference', provider: 'gemini', model: GEMINI_MODEL }],
                        userArtifactMutations: []
                    };
                }
                return {
                    primitive,
                    output: { text, model: GEMINI_MODEL, promptLength: prompt.length },
                    verified: text.length > 20,
                    evidence: [`gemini-model=${GEMINI_MODEL}`, `response-length=${text.length}`],
                    declaredEffects,
                    externalEffects: [{ kind: 'model-inference', provider: 'gemini', model: GEMINI_MODEL }],
                    userArtifactMutations: []
                };
            } catch (error) {
                return { primitive, output: null, verified: false, evidence: [`gemini-error: ${error.message}`] };
            }
        }

        if (primitive === 'write.proposal') {
            // Expect the previous gemini.synthesize step to have produced text
            const draft = context?.synthesizedText || context?.draft || null;
            if (!draft) return { primitive, output: null, verified: false, evidence: ['no synthesized text to write'] };
            try {
                const folder = path.join(this.workspaceRoot, 'Living-Proposals');
                const date = new Date().toISOString().slice(0, 10);
                const title = cleanText(context?.proposalTitle || reflection?.headline || 'evolution-proposal', 60);
                const timePart = new Date().toISOString().slice(11, 19).replace(/:/g, '');
                const filename = `${date}-${timePart}-${slug(title)}.md`;
                const outPath = path.join(folder, filename);
                const content = `# ${title}\n_Generated ${new Date().toISOString()} by Living Software nightly digest_\n\n${draft}`;
                const declaredEffects = [{ kind: 'user-artifact-write', path: `Living-Proposals/${filename}`, operation: 'create' }];
                if (!pathWithin(this.workspaceRoot, outPath)) {
                    return { primitive, output: null, verified: false, evidence: ['proposal path escaped the workspace root'] };
                }
                if (mode !== 'commit') {
                    return {
                        primitive,
                        output: { path: outPath, filename, bytes: content.length, rehearsal: true },
                        verified: true,
                        evidence: [`would create ${content.length} bytes at Living-Proposals/${filename}`, 'no file written during rehearsal'],
                        declaredEffects,
                        externalEffects: [],
                        userArtifactMutations: []
                    };
                }
                await mkdir(folder, { recursive: true });
                const intentId = await this._journalPending({
                    action: 'create-file', path: outPath, bytes: content.length,
                    compensation: { action: 'delete-created-artifact', path: outPath }
                });
                await writeFile(outPath, content, { encoding: 'utf8', flag: 'wx' });
                return {
                    primitive,
                    output: { path: outPath, filename, bytes: content.length },
                    verified: true,
                    evidence: [`journaled intent ${intentId} before writing`, `wrote ${content.length} bytes to Living-Proposals/${filename}`],
                    declaredEffects,
                    externalEffects: [],
                    userArtifactMutations: [{ kind: 'create', intentId, path: outPath, bytes: content.length, compensation: { action: 'delete-created-artifact', path: outPath } }]
                };
            } catch (error) {
                return { primitive, output: null, verified: false, evidence: [`write-error: ${error.message}`] };
            }
        }

        if (primitive === 'file.sort') {
            const filePath = context?.priorOutputs?.find((item) => item.primitive === 'workspace.read' && item.output?.filePath)?.output?.filePath
                || context?.filePath
                || null;
            const deterministicFolder = (() => {
                if (!filePath) return null;
                const extension = path.extname(filePath).toLowerCase();
                if (['.ppt', '.pptx', '.doc', '.docx', '.pdf', '.md', '.txt'].includes(extension)) return 'Sorted Documents';
                if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mov'].includes(extension)) return 'Sorted Media';
                if (['.py', '.js', '.ts', '.tsx', '.ipynb', '.json', '.csv'].includes(extension)) return 'Sorted Projects';
                if (['.zip', '.7z', '.rar', '.tar', '.gz'].includes(extension)) return 'Sorted Archives';
                return 'Sorted Files';
            })();
            const targetFolder = safeFolderName(context?.targetFolder)
                || safeFolderName(context?.synthesizedTargetFolder)
                || deterministicFolder;
            if (!filePath || !targetFolder) {
                return { primitive, output: null, verified: false, evidence: ['file.sort requires a source file and a target folder'] };
            }
            try {
                const downloadsDir = this.downloadsDir;
                if (!pathWithin(downloadsDir, filePath)) return { primitive, output: null, verified: false, evidence: ['source file must be inside Downloads'] };
                const destDir = path.join(downloadsDir, targetFolder);
                const baseName = path.basename(filePath);
                let destPath = path.join(destDir, baseName);
                // fs.rename REPLACES an existing destination (MoveFileEx REPLACE_EXISTING
                // on Windows, rename(2) on POSIX). Silent overwrite is data loss, so a
                // colliding move must pick a unique name instead of clobbering.
                let collisionRenamed = false;
                if (await pathExists(destPath)) {
                    const extension = path.extname(baseName);
                    const stem = path.basename(baseName, extension);
                    let resolved = false;
                    for (let index = 2; index < 1000; index += 1) {
                        const candidate = path.join(destDir, `${stem} (${index})${extension}`);
                        if (!(await pathExists(candidate))) { destPath = candidate; resolved = true; break; }
                    }
                    if (!resolved) return { primitive, output: null, verified: false, evidence: [`destination folder is saturated with ${stem}${extension} copies`] };
                    collisionRenamed = true;
                }
                if (!pathWithin(downloadsDir, destPath)) return { primitive, output: null, verified: false, evidence: ['destination escaped Downloads'] };
                await access(filePath);
                const declaredEffects = [{ kind: 'user-artifact-move', from: filePath, to: destPath }];
                if (mode !== 'commit') {
                    return {
                        primitive,
                        output: { from: filePath, to: destPath, rehearsal: true },
                        verified: true,
                        evidence: [
                            `would move ${baseName} to Downloads/${targetFolder}/${collisionRenamed ? ` as ${path.basename(destPath)} (collision-safe)` : ''}`.trim(),
                            'no file moved during rehearsal'
                        ],
                        declaredEffects,
                        externalEffects: [],
                        userArtifactMutations: []
                    };
                }
                await mkdir(destDir, { recursive: true });
                const intentId = await this._journalPending({
                    action: 'move', from: filePath, to: destPath,
                    compensation: { action: 'move', from: destPath, to: filePath }
                });
                await rename(filePath, destPath);
                return {
                    primitive,
                    output: { from: filePath, to: destPath },
                    verified: true,
                    declaredEffects,
                    externalEffects: [],
                    userArtifactMutations: [{ kind: 'move', intentId, from: filePath, to: destPath, compensation: { action: 'move', from: destPath, to: filePath } }],
                    evidence: [
                        `journaled intent ${intentId} before moving`,
                        `moved ${path.basename(filePath)} → Downloads/${targetFolder}/${collisionRenamed ? ` as ${path.basename(destPath)} without overwriting the existing file` : ''}`.trim()
                    ]
                };
            } catch (error) {
                return { primitive, output: null, verified: false, evidence: [`sort-error: ${error.message}`] };
            }
        }

        if (primitive === 'idle.detect') {
            const thresholdMs = Number(context?.idleThresholdMs) || 10 * 60 * 1000;
            const idleMs = Number(context?.systemIdleMs) || 0;
            const idle = idleMs >= thresholdMs;
            return {
                primitive,
                output: { idle, idleMs, thresholdMs },
                verified: true,
                evidence: [`idle=${idle}`, `idleMs=${Math.round(idleMs / 1000)}s`, `threshold=${Math.round(thresholdMs / 1000)}s`]
            };
        }

        if (primitive === 'screen.interpret') {
            const capture = context?.lastCapture;
            if (!capture?.imageBase64) return { primitive, output: null, verified: false, evidence: ['no screen capture available'] };
            if (!hasGemini()) return { primitive, output: null, verified: false, evidence: ['gemini not configured'] };
            const declaredEffects = [{ kind: 'external-inference', provider: 'gemini', model: GEMINI_MODEL, input: 'screen-capture' }];
            if (mode !== 'commit') {
                return {
                    primitive,
                    output: { rehearsal: true, model: GEMINI_MODEL },
                    verified: true,
                    evidence: ['vision provider ready', 'no image sent during rehearsal'],
                    declaredEffects,
                    externalEffects: [],
                    userArtifactMutations: []
                };
            }
            try {
                const ai = getGemini();
                const response = await ai.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: [{
                        role: 'user', parts: [
                            { text: 'Identify the active application, window title, and a one-sentence summary of visible content. Reply ONLY as JSON: {"app":"...","windowTitle":"...","summary":"..."}' },
                            { inlineData: { data: capture.imageBase64, mimeType: 'image/jpeg' } }
                        ]
                    }],
                    config: { temperature: 0.1, httpOptions: { timeout: 45000 } }
                });
                const raw = response.text || '';
                let parsed = {};
                try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { parsed = { summary: raw.slice(0, 200) }; }
                return {
                    primitive,
                    output: { app: parsed.app || 'unknown', windowTitle: parsed.windowTitle || 'unknown', summary: parsed.summary || '' },
                    verified: Boolean(parsed.app || parsed.windowTitle),
                    evidence: [`app=${parsed.app || 'unknown'}`, `title=${(parsed.windowTitle || '').slice(0, 60)}`],
                    declaredEffects,
                    externalEffects: [{ kind: 'model-inference', provider: 'gemini', model: GEMINI_MODEL, input: 'screen-capture' }],
                    userArtifactMutations: []
                };
            } catch (error) {
                return { primitive, output: null, verified: false, evidence: [`screen-interpret-error: ${error.message}`] };
            }
        }

        // NOTE: There is deliberately no 'system.eval' (or any model-authored code
        // execution) primitive. Executing generated source is a constitution level-6
        // violation: it cannot declare bounded effects, cannot be rehearsed honestly,
        // and turns prompt injection from screen/file content into remote code
        // execution. FORBIDDEN_PRIMITIVES in capabilityKernel.js rejects it at
        // validation time.

        return { primitive, output: null, verified: false, evidence: ['primitive is not registered'] };
    }

    _evaluatePreconditions(state, manifest, context = {}) {
        return (manifest.preconditions || []).map((condition) => {
            let passed = false;
            if (condition === 'world.available') passed = Boolean(state.world && Array.isArray(state.world.entities));
            if (condition === 'events.available') passed = state.events.length > 0;
            if (condition === 'dependencies.available') passed = Array.isArray(context?.dependencies?.files);
            return { condition, passed, evidence: passed ? `${condition} satisfied` : `${condition} not satisfied` };
        });
    }

    _evaluatePostconditions(manifest, results, effects = {}) {
        return (manifest.postconditions || []).map((condition) => {
            let passed = false;
            if (condition === 'receipt.emitted') passed = true;
            if (condition === 'steps.verified') passed = results.length > 0 && results.every((result) => result.verified);
            if (condition === 'no-user-files-mutated') passed = (effects.userArtifactMutations || []).length === 0
                && !(manifest.steps || []).some((step) => ['user-artifact-write', 'user-artifact-move'].includes(PRIMITIVE_EFFECTS[step.primitive]));
            if (condition === 'effects.declared') {
                const expected = (manifest.steps || []).filter((step) => ['user-artifact-write', 'user-artifact-move'].includes(PRIMITIVE_EFFECTS[step.primitive])).length;
                passed = expected > 0 && (effects.declaredEffects || []).length >= expected;
            }
            return { condition, passed, evidence: passed ? `${condition} satisfied` : `${condition} not satisfied` };
        });
    }

    async _planCapability(state, capability, context = {}, reflection = null, options = {}) {
        const manifest = capability.package?.manifest || createCapabilityPackage(capability).manifest;
        const mode = options.mode === 'commit' ? 'commit' : 'rehearsal';
        const preconditions = this._evaluatePreconditions(state, manifest, context);
        const allowed = preconditions.every((condition) => condition.passed);
        const results = [];
        let synthesizedText = null;
        let synthesizedTargetFolder = null;
        if (allowed) {
            for (const step of manifest.steps || []) {
                if (!SAFE_PRIMITIVES.has(step.primitive)) {
                    results.push({ primitive: step.primitive, output: null, verified: false, evidence: ['blocked by constitution'] });
                    continue;
                }
                // Thread prior outputs forward so multi-step packages compose:
                // workspace.read feeds gemini.synthesize, which feeds file.sort.
                const stepContext = { ...context };
                if (synthesizedText) stepContext.synthesizedText = synthesizedText;
                if (synthesizedTargetFolder) stepContext.synthesizedTargetFolder = synthesizedTargetFolder;
                if (results.length) stepContext.priorOutputs = results.map((result) => ({ primitive: result.primitive, output: sanitizeData(result.output) }));
                const result = await this._runPrimitive(state, step.primitive, stepContext, reflection, mode);
                if (step.primitive === 'gemini.synthesize' && result.output?.text) synthesizedText = result.output.text;
                if (step.primitive === 'gemini.synthesize' && result.output?.targetFolder) synthesizedTargetFolder = result.output.targetFolder;
                results.push(result);
            }
        }
        const declaredEffects = results.flatMap((result) => result.declaredEffects || []);
        const externalEffects = results.flatMap((result) => result.externalEffects || []);
        const userArtifactMutations = results.flatMap((result) => result.userArtifactMutations || []);
        const postconditions = this._evaluatePostconditions(manifest, results, { declaredEffects, externalEffects, userArtifactMutations });
        const verified = allowed && results.length > 0 && results.every((result) => result.verified) && postconditions.every((condition) => condition.passed);
        return {
            id: this._id('plan'),
            capabilityId: manifest.capabilityId,
            capabilityVersion: manifest.version,
            packageDigest: capability.package?.digest || null,
            authority: declaredEffects.some((effect) => String(effect.kind).startsWith('user-artifact')) ? 'declared-artifact-effects' : 'runtime-state-only',
            mode,
            preconditions,
            steps: results,
            postconditions,
            verified,
            declaredEffects,
            externalEffects,
            userArtifactMutations,
            createdAt: this._now()
        };
    }

    // --- Phased execution ------------------------------------------------------
    // Slow work (provider inference, filesystem effects) runs OUTSIDE the
    // mutation queue against a frozen state snapshot, so a 45s model call never
    // blocks event ingestion or state writes. The queue only ever executes the
    // fast, guarded commit: re-resolve the capability, re-check authority, link
    // the receipt into the ledger. Consistency stays serialized; metabolism
    // does not.

    _authorityCheck(capability) {
        const authority = validateCapabilityPackage(capability.package || {});
        const permissionsConstitutional = (capability.permissions || []).every((permission) => SAFE_PERMISSIONS.has(permission));
        const failedChecks = authority.checks.filter((check) => !check.passed).map((check) => check.id);
        return {
            ok: authority.status === 'passed' && permissionsConstitutional,
            evidence: [
                `package validation ${authority.status}`,
                failedChecks.length ? `failed checks: ${failedChecks.join(', ')}` : 'manifest intact',
                permissionsConstitutional ? 'permissions constitutional' : `non-constitutional permissions: ${(capability.permissions || []).filter((p) => !SAFE_PERMISSIONS.has(p)).join(', ')}`
            ]
        };
    }

    _refusalReceipt(capability, context, evidenceLines) {
        const now = this._now();
        return {
            id: this._id('receipt'),
            capabilityId: capability?.id || 'unknown',
            capabilityVersion: capability?.version || null,
            packageDigest: capability?.package?.digest || null,
            planId: null,
            authority: 'refused',
            status: 'refused-authority',
            inputs: sanitizeData(context),
            preconditions: [],
            outputs: [],
            postconditions: [{ condition: 'authority.valid', passed: false, evidence: 'execution refused before any step ran' }],
            evidence: evidenceLines.slice(0, 40),
            transaction: { mode: 'none', stagedAt: now, committedAt: now, mutations: [], declaredEffects: [], externalEffects: [], userArtifactMutations: [] },
            reversible: true,
            rollback: 'No effect was committed; fix or roll back the package.',
            feedback: null,
            createdAt: now
        };
    }

    // Independent filesystem verification of declared artifact effects:
    // primitives self-report success, but a move is only verified when the
    // destination exists and the source is gone; a write when the file exists
    // at its declared size. Verification must not grade its own homework.
    async _verifyPlanEffects(plan) {
        const fsEvidence = [];
        let effectsVerified = true;
        for (const mutation of plan.userArtifactMutations) {
            try {
                if (mutation.kind === 'move') {
                    const movedOk = (await pathExists(mutation.to)) && !(await pathExists(mutation.from));
                    fsEvidence.push(`${movedOk ? 'verified' : 'UNVERIFIED'} move → ${path.basename(mutation.to)}`);
                    effectsVerified = effectsVerified && movedOk;
                } else if (mutation.kind === 'create') {
                    const createdOk = await pathExists(mutation.path)
                        && (!Number.isInteger(mutation.bytes) || (await stat(mutation.path)).size === mutation.bytes);
                    fsEvidence.push(`${createdOk ? 'verified' : 'UNVERIFIED'} create → ${path.basename(mutation.path)}`);
                    effectsVerified = effectsVerified && createdOk;
                }
            } catch (error) {
                fsEvidence.push(`verification error on ${mutation.kind}: ${cleanText(error.message, 120)}`);
                effectsVerified = false;
            }
        }
        return { fsEvidence, effectsVerified };
    }

    /**
     * Phase A — runs OFF the mutation queue. Takes a frozen public-state view;
     * pre-gates authority, runs every primitive step (including provider
     * inference), and verifies declared effects on the filesystem.
     */
    async _planForExecution(view, capability, context = {}, reflection = null) {
        const gate = this._authorityCheck(capability);
        if (!gate.ok) return { refused: this._refusalReceipt(capability, context, gate.evidence) };

        const plan = await this._planCapability(view, capability, context, reflection, { mode: 'commit' });
        const { fsEvidence, effectsVerified } = await this._verifyPlanEffects(plan);
        return { plan, fsEvidence, effectsVerified };
    }

    /**
     * Phase B — runs INSIDE the mutation queue. Re-resolves the live capability
     * and re-checks its authority against current state (it may have been rolled
     * back or edited while phase A was running), then links the prepared receipt
     * into the ledger.
     */
    _commitExecution(state, capabilityId, execution, context = {}) {
        const live = state.capabilities.find((item) => item.id === capabilityId);
        if (!live) {
            const receipt = this._refusalReceipt(null, context, [`capability ${capabilityId} no longer exists`, ...execution.refusalFallback || []]);
            this._commitReceipt(state, { id: capabilityId, name: capabilityId, version: null, metrics: {} }, receipt, { verified: false });
            return receipt;
        }
        if (execution.refused) {
            this._commitReceipt(state, live, execution.refused, { verified: false });
            return execution.refused;
        }
        if (live.status !== 'active') {
            const receipt = this._refusalReceipt(live, context, [`capability changed during planning: status is now '${live.status}'`]);
            this._commitReceipt(state, live, receipt, { verified: false });
            return receipt;
        }
        const gate = this._authorityCheck(live);
        if (!gate.ok) {
            const receipt = this._refusalReceipt(live, context, gate.evidence);
            this._commitReceipt(state, live, receipt, { verified: false });
            return receipt;
        }

        const plan = execution.plan;
        const verified = plan.verified && execution.effectsVerified;
        const now = this._now();
        const receipt = {
            id: this._id('receipt'),
            capabilityId: live.id,
            capabilityVersion: live.version,
            packageDigest: live.package?.digest || null,
            planId: plan.id,
            authority: 'bounded-runtime',
            status: verified ? 'verified' : 'failed-verification',
            inputs: sanitizeData(context),
            preconditions: plan.preconditions,
            outputs: plan.steps.map((result) => ({ primitive: result.primitive, output: sanitizeData(result.output) })),
            postconditions: [
                ...plan.postconditions,
                ...(execution.fsEvidence.length ? [{ condition: 'effects.filesystem-verified', passed: execution.effectsVerified, evidence: execution.fsEvidence.join('; ') }] : [])
            ],
            evidence: [
                ...plan.preconditions.map((item) => item.evidence),
                ...plan.steps.flatMap((result) => result.evidence),
                ...plan.postconditions.map((item) => item.evidence),
                ...execution.fsEvidence
            ].slice(0, 40),
            transaction: {
                mode: plan.userArtifactMutations.length ? 'declared-artifact-effects' : 'runtime-state-only',
                stagedAt: plan.createdAt,
                committedAt: now,
                mutations: ['receipt', 'capability-metrics', 'event-log', ...plan.userArtifactMutations.map((item) => item.kind)],
                declaredEffects: plan.declaredEffects,
                externalEffects: plan.externalEffects,
                userArtifactMutations: plan.userArtifactMutations
            },
            reversible: plan.userArtifactMutations.every((item) => Boolean(item.compensation)),
            rollback: plan.userArtifactMutations.length
                ? 'Apply each recorded compensation (receipt.revert) before rolling back the active package.'
                : 'Rollback the active package or deactivate this evolved capability; no user artifact was mutated.',
            feedback: null,
            createdAt: now
        };
        this._commitReceipt(state, live, receipt, { verified });
        return receipt;
    }

    /**
     * Receipt ledger: every receipt commits with a hash link to its predecessor,
     * making silent edits or drops of persisted history detectable. Legacy
     * receipts without links remain valid as chain anchors.
     */
    async _commitReceipt(state, capability, receipt, { verified = null } = {}) {
        const previous = state.receipts[0] || null;
        receipt.ledgerPrev = previous ? digestReceipt(previous) : 'genesis';
        receipt.ledgerDigest = digestReceipt(receipt);

        state.receipts.unshift(receipt);
        state.receipts = this._evict(state.receipts, LIMITS.receipts, 'receipts-archive.jsonl');

        // Durable external anchor: one line per committed receipt in an
        // append-only head journal. The in-state chain cannot see wholesale
        // deletion (an emptied array vacuously passes); the anchor can.
        this._scheduleArchiveAppend('ledger-head.jsonl', `${JSON.stringify({
            id: receipt.id,
            digest: receipt.ledgerDigest,
            prev: receipt.ledgerPrev,
            capabilityId: receipt.capabilityId,
            at: receipt.createdAt
        })}\n`);

        // Journal intents stay pending until the state file is durably saved;
        // public entry points resolve them afterwards via _resolveReceiptIntents.
        const intentIds = (receipt.transaction?.userArtifactMutations || [])
            .map((mutation) => mutation.intentId).filter(Boolean);
        Object.defineProperty(receipt, '_intents', { value: intentIds, enumerable: false });

        const effectiveVerified = verified === null ? receipt.status === 'verified' : verified;
        const metrics = normalizeCapabilityMetrics(capability.metrics);
        capability.metrics = normalizeCapabilityMetrics({
            ...metrics,
            runs: metrics.runs + 1,
            verified: metrics.verified + (effectiveVerified ? 1 : 0),
            lastRunAt: this._now()
        });

        this._appendEvent(state, {
            kind: 'capability.executed',
            source: capability.id,
            summary: `${capability.name} ${effectiveVerified ? 'completed with verification' : `ended as ${receipt.status}`}.`,
            importance: effectiveVerified ? 0.65 : 0.9,
            data: { receiptId: receipt.id, capabilityId: capability.id, version: capability.version, packageDigest: receipt.packageDigest, status: receipt.status },
            dedupeKey: `capability.executed:${receipt.id}`
        });
    }

    _verifyReceiptLedger(state = this.state) {
        const broken = [];
        let chained = 0;
        for (let index = 0; index < state.receipts.length - 1; index += 1) {
            const newer = state.receipts[index];
            if (!newer?.ledgerPrev) continue;
            chained += 1;
            if (newer.ledgerPrev !== digestReceipt(state.receipts[index + 1])) {
                broken.push({ id: newer.id, at: newer.createdAt });
            }
        }
        return { intact: broken.length === 0, chained, broken };
    }

    /**
     * The head anchor detects what the in-state chain cannot: wholesale
     * deletion of the receipt ledger. If the anchor journal has entries but the
     * live ledger is empty (or its newest digest does not match the anchor),
     * history was erased rather than evolved.
     */
    async _verifyLedgerAnchor() {
        const state = this.state;
        let raw = '';
        try {
            raw = await readFile(path.join(path.dirname(this.dataPath), 'ledger-head.jsonl'), 'utf8');
        } catch {
            return { intact: true, anchored: false, evidence: 'no anchor journal yet' };
        }
        const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
        const last = lines.length ? (() => { try { return JSON.parse(lines[lines.length - 1]); } catch { return null; } })() : null;
        if (!last) return { intact: false, anchored: true, evidence: 'anchor journal is unreadable' };
        const newest = state.receipts[0] || null;
        if (!newest) return { intact: false, anchored: true, evidence: `${lines.length} anchored receipts but the live ledger is empty` };
        // Recompute from canonical content rather than trusting the stored
        // digest: a forged receipt edits its payload, not its own hash claim.
        const recomputed = digestReceipt(newest);
        if (last.id !== newest.id || last.digest !== recomputed) {
            return { intact: false, anchored: true, evidence: 'newest receipt does not match the durable anchor' };
        }
        return { intact: true, anchored: true, evidence: `anchored at ${newest.id}` };
    }

    // --- Write-ahead effect journal -------------------------------------------
    // A declared artifact mutation is journaled as 'pending' BEFORE it touches
    // the filesystem and resolved only after the receipt is durably saved. A
    // crash in between leaves an unresolved intent that the next boot undoes
    // through its recorded compensation: effects never dangle.

    get effectJournalPath() {
        return path.join(path.dirname(this.dataPath), 'effect-journal.jsonl');
    }

    async _journalPending(mutation) {
        const intentId = this._id('intent');
        const line = `${JSON.stringify({ id: intentId, state: 'pending', mutation, at: this._now() })}\n`;
        const write = this.archiveQueue.then(() => appendFile(this.effectJournalPath, line, 'utf8'));
        this.archiveQueue = write.catch(() => undefined);
        await write;
        return intentId;
    }

    async _journalResolve(intentId, outcome) {
        const line = `${JSON.stringify({ id: intentId, state: outcome, at: this._now() })}\n`;
        const write = this.archiveQueue.then(() => appendFile(this.effectJournalPath, line, 'utf8'));
        this.archiveQueue = write.catch(() => undefined);
        try { await write; } catch { /* journal best-effort from here on */ }
    }

    async _reconcileEffectJournal(state) {
        let raw = '';
        try {
            raw = await readFile(this.effectJournalPath, 'utf8');
        } catch {
            return; // no journal yet
        }
        const latest = new Map();
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                latest.set(entry.id, entry);
            } catch { /* torn trailing line from a crash mid-append */ }
        }

        for (const entry of latest.values()) {
            if (entry.state !== 'pending' || !entry.mutation) continue;
            const mutation = entry.mutation;
            let outcome = 'resolved-noop';
            try {
                if (mutation.compensation?.action === 'move') {
                    const movedHappened = await pathExists(mutation.to);
                    const sourceRestored = await pathExists(mutation.compensation.to);
                    if (movedHappened && !sourceRestored) {
                        await rename(mutation.to, mutation.compensation.to);
                        outcome = 'resolved-compensated';
                    } else if (movedHappened && sourceRestored) {
                        outcome = 'needs-human-review';
                    }
                } else if (mutation.compensation?.action === 'delete-created-artifact') {
                    if (await pathExists(mutation.path)) {
                        await rm(mutation.path);
                        outcome = 'resolved-compensated';
                    } else {
                        outcome = 'resolved-noop';
                    }
                }
            } catch (error) {
                outcome = `needs-human-review:${cleanText(error.message, 120)}`;
            }
            await this._journalResolve(entry.id, outcome);
            state.events.unshift({
                id: this._id('event'),
                kind: 'work.journal-reconciled',
                source: 'effect-journal',
                summary: `Unresolved pre-crash artifact intent ${entry.id} was ${outcome.startsWith('resolved') ? 'undone or no-op via its recorded compensation' : 'flagged for human review'}.`,
                importance: outcome === 'resolved-compensated' ? 0.85 : 1,
                data: { intentId: entry.id, mutation: sanitizeData(mutation), outcome },
                dedupeKey: `work.journal-reconciled:${entry.id}`,
                createdAt: this._now()
            });
            state.events = cap(state.events, LIMITS.events);
        }
    }

    _findCapabilityForRecentEvents(state) {
        const nowMs = Date.parse(this._now());
        const recentEvents = state.events.slice(0, 12);
        // Manifest triggers are enforced for real: threshold is the minimum count
        // of matching events NEWER than the capability's last run, cooldownMs
        // silences re-firing, and stale events never re-trigger a capability
        // that already handled them.
        const matching = state.capabilities.find((capability) => {
            if (capability.status !== 'active' || !capability.automatic) return false;
            if (capability.metrics?.fitness?.recommendation === 'retire-review') return false;
            const lastRunMs = Date.parse(capability.metrics?.lastRunAt || '') || 0;
            if (capability.trigger?.cooldownMs && nowMs - lastRunMs < capability.trigger.cooldownMs) return false;
            const kinds = capability.trigger?.eventKinds || [];
            if (!kinds.length) return false;
            const hits = recentEvents.filter((event) => Date.parse(event.createdAt) > lastRunMs && kinds.includes(event.kind));
            return hits.length >= Math.max(1, Number(capability.trigger?.threshold) || 1);
        });
        if (matching) return matching;

        // The work loop is allowed to rest. Forcing continuity.snapshot on every
        // scheduled tick spams receipts, inflates metrics, and dilutes the fitness
        // signal that feedback and verification are supposed to provide.
        const fallback = state.capabilities.find((capability) => capability.id === 'continuity.snapshot');
        if (!fallback) return null;
        const lastSnapshotReceipt = state.receipts.find((receipt) => receipt.capabilityId === fallback.id);
        const cooldownMs = 10 * 60 * 1000;
        if (lastSnapshotReceipt && nowMs - Date.parse(lastSnapshotReceipt.createdAt) < cooldownMs) return null;
        return fallback;
    }

    _createProposal(state, input = {}) {
        const target = input.targetCapabilityId
            ? state.capabilities.find((capability) => capability.id === input.targetCapabilityId)
            : null;
        if (input.targetCapabilityId && !target) throw new Error(`Upgrade target not found: ${input.targetCapabilityId}`);

        let capabilityId = target?.id || cleanText(input.capabilityId, 120) || `evolved.${slug(input.name)}`;
        if (!target) {
            const base = capabilityId;
            let suffix = 2;
            while (state.capabilities.some((capability) => capability.id === capabilityId)) capabilityId = `${base}-${suffix++}`;
        }
        const version = target ? Number(target.version || 0) + 1 : 1;
        const pkg = createCapabilityPackage({
            ...input,
            capabilityId,
            version,
            description: input.rationale || input.description,
            permissions: input.permissions || ['read:world', 'read:events', 'write:living-state']
        });
        const manifest = pkg.manifest;
        const proposal = {
            id: this._id('proposal'),
            name: manifest.name,
            rationale: manifest.description,
            status: 'proposed',
            origin: manifest.origin,
            synthesis: sanitizeData(input.synthesis || null),
            targetCapabilityId: target?.id || null,
            trigger: manifest.trigger,
            permissions: manifest.permissions,
            steps: manifest.steps,
            tests: manifest.tests,
            package: pkg,
            validation: null,
            rehearsal: null,
            evidenceEventIds: Array.isArray(input.evidenceEventIds) ? input.evidenceEventIds.slice(0, 12) : [],
            createdAt: this._now(),
            installedAt: null
        };
        state.proposals.unshift(proposal);
        state.proposals = cap(state.proposals, LIMITS.proposals);
        return proposal;
    }

    /**
     * Counterfactual coverage analysis: replay recent history against installed
     * triggers and find recurring event kinds that NOTHING covers. Scheduled
     * cycles propose at the reactive threshold (4); idle-dream cycles act on
     * weaker evidence (3) because quiet periods are exactly when anticipatory
     * growth is affordable. Runs OFF the mutation queue; may call a provider
     * for the rationale.
     */
    async _evaluateEvolutionNeeds(view, { reason = 'scheduled' } = {}) {
        const excluded = /^(runtime\.|cycle\.|capability\.|world\.observed|evolution\.|work\.rest|idle-dream|perception\.(analysis|unknown)$)/;
        const counts = new Map();
        for (const event of view.events.slice(0, 120)) {
            if (excluded.test(event.kind)) continue;
            if (event.kind.startsWith('perception.') && Number(event.data?.confidence || 0) < 0.65) continue;
            counts.set(event.kind, (counts.get(event.kind) || 0) + 1);
        }
        const predictive = reason === 'idle-dream';
        const threshold = predictive ? 3 : 4;
        const repeated = [...counts.entries()].sort((a, b) => b[1] - a[1]).find(([, count]) => count >= threshold);
        if (!repeated) return null;

        const [kind, count] = repeated;
        const alreadyCovered = view.capabilities.some((capability) => capability.trigger?.eventKinds?.includes(kind));
        // Any live proposal (or previously installed one) already answers this pattern;
        // re-proposing the same "Companion" for every repeated event kind is noise,
        // not growth. Rejected proposals may be superseded by new evidence.
        const alreadyProposed = view.proposals.some((proposal) =>
            ['proposed', 'validated', 'rehearsed', 'installed'].includes(proposal.status)
            && proposal.trigger?.eventKinds?.includes(kind));
        const openProposalCount = view.proposals.filter((proposal) => ['proposed', 'validated', 'rehearsed'].includes(proposal.status)).length;
        if (alreadyCovered || alreadyProposed || openProposalCount >= 5) return null;

        // --- Rationale synthesis: grounded first, provider-drafted when available ---
        let rationale = `The runtime observed ${count} recent "${kind}" events without an installed capability dedicated to that pattern.`;
        if (predictive) rationale += ` This proposal was formed during an idle period from below-threshold evidence, as anticipatory coverage rather than a reaction to repetition.`;
        let synthesisMeta = predictive ? { source: 'speculative-simulation', observations: count } : { source: 'algorithmic' };
        if (hasGemini()) {
            try {
                const sampleEvents = view.events.filter((e) => e.kind === kind).slice(0, 5).map((e) => e.summary).join('\n');
                const ai = getGemini();
                const response = await ai.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: [{ role: 'user', parts: [{ text: `The living-software runtime observed the pattern "${kind}" ${count} times.\n\nSample events:\n${sampleEvents}\n\nIn 2 sentences, explain why this pattern warrants a new capability and what that capability should do. Be concise and grounded.` }] }],
                    config: { temperature: 0.3, httpOptions: { timeout: 45000 }, systemInstruction: 'You are the evolution engine of a living computer. One short, grounded, non-marketing paragraph only.' }
                });
                if (response.text?.length > 10) {
                    rationale = response.text.trim();
                    synthesisMeta = { source: 'gemini', model: GEMINI_MODEL, predictive };
                }
            } catch { /* fall back to algorithmic rationale */ }
        }

        return {
            kind,
            count,
            name: `${humanize(kind)} Companion`,
            rationale,
            origin: 'pattern-evolution',
            triggerKinds: [kind],
            permissions: ['read:world', 'read:events', 'write:living-state'],
            steps: [{ primitive: 'world.snapshot' }, { primitive: 'context.reflect' }],
            evidenceEventIds: view.events.filter((event) => event.kind === kind).slice(0, 8).map((event) => event.id),
            synthesis: synthesisMeta,
            predictive
        };
    }

    /** Phase B — append an evaluated candidate inside the mutation queue. */
    _appendEvolutionCandidate(state, candidate) {
        const stillCovered = state.capabilities.some((capability) => capability.trigger?.eventKinds?.includes(candidate.kind))
            || state.proposals.some((proposal) =>
                ['proposed', 'validated', 'rehearsed', 'installed'].includes(proposal.status)
                && proposal.trigger?.eventKinds?.includes(candidate.kind));
        if (stillCovered) return null;

        const proposal = this._createProposal(state, {
            name: candidate.name,
            rationale: candidate.rationale,
            origin: candidate.origin,
            triggerKinds: candidate.triggerKinds,
            permissions: candidate.permissions,
            steps: candidate.steps,
            evidenceEventIds: candidate.evidenceEventIds,
            synthesis: candidate.synthesis
        });
        this._appendEvent(state, {
            kind: 'evolution.proposed',
            source: 'evolution-engine',
            summary: `Proposed ${proposal.name} (${candidate.synthesis.source}-authored${candidate.predictive ? ', speculative' : ''}) from ${candidate.count} uncovered "${candidate.kind}" events; installation requires approval.`,
            importance: candidate.predictive ? 0.7 : 0.75,
            data: { proposalId: proposal.id, trigger: candidate.kind, observations: candidate.count, synthesis: candidate.synthesis }
        });
        return proposal;
    }

    async _resolveReceiptIntents(receipt) {
        for (const intentId of receipt?._intents || []) {
            await this._journalResolve(intentId, 'resolved');
        }
    }

    async runCycle(options = {}) {
        // Phase A — off the mutation queue: freeze a consistent view, derive the
        // reflection, select the capability, run its primitives (provider calls
        // happen here), and evaluate evolution needs. State writes wait.
        await this.initialize();
        await this.queue;
        const startedAt = this._now();
        const reason = cleanText(options.reason, 120) || 'manual';
        const workContext = { dependencies: options.dependencies || null, reason, lastCaptureAt: options.lastCaptureAt || 0 };
        const view = this._publicState();

        const reflection = this._deriveReflection(view, reason);
        const selected = this._findCapabilityForRecentEvents(view);
        let execution = null;
        if (selected) {
            execution = await this._planForExecution(view, selected, workContext, reflection);
        }
        const candidate = await this._evaluateEvolutionNeeds(view, { reason });

        // Phase B — one fast guarded commit under the queue.
        const result = await this._mutate(async (state) => {
            let observation = null;
            if (options.worldSnapshot) observation = this._observeWorld(state, options.worldSnapshot, options.source || 'living-cycle');
            this._appendEvent(state, {
                kind: 'cycle.started',
                source: 'living-runtime',
                summary: `Living cycle started (${reason}).`,
                importance: 0.35,
                data: { reason }
            });
            this._appendReflection(state, reflection);

            let receipt = null;
            if (execution) {
                receipt = this._commitExecution(state, selected.id, execution, workContext);
            } else {
                this._appendEvent(state, {
                    kind: 'work.rest',
                    source: 'living-runtime',
                    summary: 'No installed capability matched recent context and continuity is fresh; the work loop rested instead of emitting a redundant receipt.',
                    importance: 0.3,
                    dedupeKey: `work.rest:${startedAt.slice(0, 16)}`
                });
            }
            const proposal = candidate ? this._appendEvolutionCandidate(state, candidate) : null;
            const cycle = {
                id: this._id('cycle'),
                reason,
                phases: {
                    world: observation ? 'updated' : 'retained',
                    reflection: reflection.id,
                    work: receipt ? receipt.id : 'rested',
                    evolution: proposal?.id || 'watching-patterns'
                },
                capabilityId: selected?.id || null,
                status: !receipt ? 'rested' : (receipt.status === 'verified' ? 'verified' : 'degraded'),
                startedAt,
                completedAt: this._now()
            };
            state.cycles.unshift(cycle);
            state.cycles = cap(state.cycles, LIMITS.cycles);
            if (receipt) {
                this._appendEvent(state, {
                    kind: 'cycle.completed',
                    source: 'living-runtime',
                    summary: `Living cycle ${cycle.status}; ${receipt.capabilityId} emitted receipt ${receipt.id}.`,
                    importance: cycle.status === 'verified' ? 0.55 : 0.9,
                    data: { cycleId: cycle.id, receiptId: receipt.id, proposalId: proposal?.id || null }
                });
            } else {
                this._appendEvent(state, {
                    kind: 'cycle.completed',
                    source: 'living-runtime',
                    summary: `Living cycle rested; no capability was triggered and no receipt was needed.`,
                    importance: 0.35,
                    data: { cycleId: cycle.id, proposalId: proposal?.id || null }
                });
            }
            return { cycle, reflection, receipt, proposal, state: this._publicState(state) };
        });
        await this._resolveReceiptIntents(result.receipt);
        return result;
    }

    async executeCapability(capabilityId, context = {}) {
        await this.initialize();
        await this.queue;
        const view = this._publicState();
        const capability = view.capabilities.find((item) => item.id === capabilityId && item.status === 'active');
        if (!capability) throw new Error(`Active capability not found: ${capabilityId}`);
        const reflection = this._deriveReflection(view, `capability:${capabilityId}`);
        const execution = await this._planForExecution(view, capability, context, reflection);

        const receipt = await this._mutate((state) => this._commitExecution(state, capabilityId, execution, context));
        await this._resolveReceiptIntents(receipt);
        return receipt;
    }

    async proposeCapability(input = {}) {
        return this._mutate((state) => {
            const name = cleanText(input.name, 120);
            if (!name) throw new Error('Capability name is required.');
            if (!Array.isArray(input.steps) || !input.steps.length) throw new Error('At least one declared primitive is required.');
            const proposal = this._createProposal(state, {
                ...input,
                name,
                rationale: cleanText(input.rationale, 600) || 'Proposed by the user for bounded runtime composition.',
                origin: cleanText(input.origin, 80) || 'user-directed'
            });
            this._appendEvent(state, {
                kind: 'evolution.proposed',
                source: 'user',
                summary: `User proposed capability package ${proposal.package.manifest.capabilityId}@${proposal.package.manifest.version}.`,
                data: { proposalId: proposal.id, packageDigest: proposal.package.digest, targetCapabilityId: proposal.targetCapabilityId }
            });
            return proposal;
        });
    }

    async validateProposal(proposalId) {
        return this._mutate((state) => {
            const proposal = state.proposals.find((item) => item.id === proposalId);
            if (!proposal || !['proposed', 'invalid', 'validated'].includes(proposal.status)) throw new Error(`Validatable proposal not found: ${proposalId}`);
            const target = proposal.targetCapabilityId ? state.capabilities.find((capability) => capability.id === proposal.targetCapabilityId) : null;
            const validation = validateCapabilityPackage(proposal.package, {
                expectedVersion: target ? Number(target.version || 0) + 1 : 1,
                expectedCapabilityId: target?.id || proposal.package?.manifest?.capabilityId
            });
            proposal.validation = { ...validation, validatedAt: this._now() };
            proposal.status = validation.status === 'passed' ? 'validated' : 'invalid';
            const event = this._appendEvent(state, {
                kind: validation.status === 'passed' ? 'evolution.validated' : 'evolution.validation-failed',
                source: 'capability-kernel',
                summary: `${proposal.name} package validation ${validation.status}.`,
                importance: validation.status === 'passed' ? 0.7 : 0.9,
                data: { proposalId: proposal.id, packageDigest: proposal.package.digest, failedChecks: validation.checks.filter((check) => !check.passed).map((check) => check.id) }
            });
            return { proposal, validation: proposal.validation, event };
        });
    }

    async dryRunProposal(proposalId, context = {}) {
        return this._mutate(async (state) => {
            const proposal = state.proposals.find((item) => item.id === proposalId);
            if (!proposal || proposal.status !== 'validated' || proposal.validation?.status !== 'passed') throw new Error(`Validated proposal not found: ${proposalId}`);
            const capability = normalizeCapabilityRecord({
                ...proposal.package.manifest,
                id: proposal.package.manifest.capabilityId,
                package: proposal.package,
                status: 'rehearsal'
            });
            const reflection = state.reflections[0] || {
                id: 'reflection:rehearsal',
                headline: 'Capability package rehearsal',
                recommendation: 'Commit only after every rehearsal condition passes.',
                evidenceEventIds: state.events.slice(0, 6).map((event) => event.id)
            };
            const plan = await this._planCapability(state, capability, context, reflection);
            proposal.rehearsal = {
                status: plan.verified ? 'passed' : 'failed',
                plan: sanitizeData(plan),
                rehearsedAt: this._now()
            };
            proposal.status = plan.verified ? 'rehearsed' : 'validated';
            const event = this._appendEvent(state, {
                kind: plan.verified ? 'evolution.rehearsed' : 'evolution.rehearsal-failed',
                source: 'capability-kernel',
                summary: `${proposal.name} dry-run ${plan.verified ? 'passed' : 'failed'} without committing side effects.`,
                importance: plan.verified ? 0.75 : 0.9,
                data: { proposalId: proposal.id, planId: plan.id, packageDigest: proposal.package.digest }
            });
            return { proposal, rehearsal: proposal.rehearsal, event };
        });
    }

    async rejectProposal(proposalId, reason = 'Rejected during explicit review.') {
        return this._mutate((state) => {
            const proposal = state.proposals.find((item) => item.id === proposalId);
            if (!proposal || !['proposed', 'invalid', 'validated', 'rehearsed'].includes(proposal.status)) throw new Error(`Rejectable proposal not found: ${proposalId}`);
            proposal.status = 'rejected';
            proposal.rejectedAt = this._now();
            proposal.rejectionReason = cleanText(reason, 500) || 'Rejected during explicit review.';
            const event = this._appendEvent(state, {
                kind: 'evolution.rejected',
                source: 'user',
                summary: `${proposal.name} was rejected during explicit capability review.`,
                importance: 0.75,
                data: { proposalId: proposal.id, reason: proposal.rejectionReason }
            });
            return { proposal, event };
        });
    }

    async installProposal(proposalId) {
        return this._mutate((state) => {
            const proposal = state.proposals.find((item) => item.id === proposalId);
            if (!proposal || proposal.status !== 'rehearsed' || proposal.validation?.status !== 'passed' || proposal.rehearsal?.status !== 'passed') {
                throw new Error(`Proposal must pass validation and dry-run before installation: ${proposalId}`);
            }
            const target = proposal.targetCapabilityId ? state.capabilities.find((item) => item.id === proposal.targetCapabilityId) : null;
            const finalValidation = validateCapabilityPackage(proposal.package, {
                expectedVersion: target ? Number(target.version || 0) + 1 : 1,
                expectedCapabilityId: target?.id || proposal.package.manifest.capabilityId
            });
            if (finalValidation.status !== 'passed') throw new Error('Capability package changed after validation.');

            let capability;
            if (target) {
                target.packageHistory ||= [];
                target.packageHistory.unshift({
                    package: clone(target.package),
                    name: target.name,
                    description: target.description,
                    automatic: target.automatic,
                    trigger: clone(target.trigger),
                    permissions: clone(target.permissions),
                    steps: clone(target.steps),
                    supersededAt: this._now()
                });
                const manifest = proposal.package.manifest;
                Object.assign(target, {
                    name: manifest.name,
                    description: manifest.description,
                    origin: manifest.origin,
                    version: manifest.version,
                    automatic: manifest.automatic,
                    trigger: clone(manifest.trigger),
                    permissions: clone(manifest.permissions),
                    steps: clone(manifest.steps),
                    package: clone(proposal.package),
                    status: 'active',
                    proposalId: proposal.id
                });
                target.lifecycle ||= { installedAt: null, activatedAt: null, lastRollbackAt: null, rollbackCount: 0 };
                target.lifecycle.activatedAt = this._now();
                target.metrics = normalizeCapabilityMetrics(target.metrics);
                capability = target;
            } else {
                capability = normalizeCapabilityRecord({
                    id: proposal.package.manifest.capabilityId,
                    package: clone(proposal.package),
                    status: 'active',
                    proposalId: proposal.id,
                    installedAt: this._now(),
                    metrics: {}
                });
                capability.lifecycle.installedAt = this._now();
                capability.lifecycle.activatedAt = capability.lifecycle.installedAt;
                state.capabilities.unshift(capability);
            }
            proposal.status = 'installed';
            proposal.installedAt = this._now();
            proposal.capabilityId = capability.id;
            const event = this._appendEvent(state, {
                kind: target ? 'evolution.upgraded' : 'evolution.installed',
                source: 'evolution-engine',
                summary: `${capability.name}@${capability.version} became active after validation, rehearsal, and explicit approval.`,
                importance: 0.9,
                data: { proposalId: proposal.id, capabilityId: capability.id, version: capability.version, packageDigest: capability.package.digest }
            });
            return { capability, proposal, event };
        });
    }

    async rollbackCapability(capabilityId, reason = 'Explicit user rollback.') {
        return this._mutate((state) => {
            const capability = state.capabilities.find((item) => item.id === capabilityId);
            if (!capability || capability.origin === 'built-in') throw new Error(`Rollbackable evolved capability not found: ${capabilityId}`);
            const fromVersion = capability.version;
            capability.lifecycle ||= { installedAt: null, activatedAt: null, lastRollbackAt: null, rollbackCount: 0 };
            capability.retiredPackages ||= [];
            capability.retiredPackages.unshift({ package: clone(capability.package), retiredAt: this._now(), reason: cleanText(reason, 500) });

            const previous = capability.packageHistory?.shift();
            if (previous?.package?.manifest) {
                const manifest = previous.package.manifest;
                Object.assign(capability, {
                    name: manifest.name,
                    description: manifest.description,
                    origin: manifest.origin,
                    version: manifest.version,
                    automatic: manifest.automatic,
                    trigger: clone(manifest.trigger),
                    permissions: clone(manifest.permissions),
                    steps: clone(manifest.steps),
                    package: clone(previous.package),
                    status: 'active'
                });
            } else {
                capability.status = 'rolled-back';
            }
            capability.lifecycle.lastRollbackAt = this._now();
            capability.lifecycle.rollbackCount = Number(capability.lifecycle.rollbackCount || 0) + 1;
            const event = this._appendEvent(state, {
                kind: 'evolution.rolled-back',
                source: 'user',
                summary: previous ? `${capability.name} rolled back from version ${fromVersion} to ${capability.version}.` : `${capability.name} was deactivated by rollback.`,
                importance: 0.9,
                data: { capabilityId, fromVersion, toVersion: previous ? capability.version : null, reason: cleanText(reason, 500) }
            });
            return { capability, event };
        });
    }

    async recordFeedback(input = {}) {
        return this._mutate((state) => {
            const receipt = state.receipts.find((item) => item.id === input.receiptId);
            if (!receipt) throw new Error(`Receipt not found: ${input.receiptId}`);
            const verdict = ['useful', 'rejected', 'incorrect'].includes(input.verdict) ? input.verdict : 'useful';
            receipt.feedback = { verdict, note: cleanText(input.note, 500), createdAt: this._now() };
            const capability = state.capabilities.find((item) => item.id === receipt.capabilityId);
            if (capability) {
                const metrics = normalizeCapabilityMetrics(capability.metrics);
                capability.metrics = normalizeCapabilityMetrics({
                    ...metrics,
                    useful: metrics.useful + (verdict === 'useful' ? 1 : 0),
                    rejected: metrics.rejected + (verdict === 'rejected' ? 1 : 0),
                    incorrect: metrics.incorrect + (verdict === 'incorrect' ? 1 : 0)
                });
            }
            const event = this._appendEvent(state, {
                kind: 'work.feedback',
                source: 'user',
                summary: `User marked ${receipt.capabilityId} output as ${verdict}.`,
                importance: verdict === 'useful' ? 0.55 : 0.85,
                data: { receiptId: receipt.id, capabilityId: receipt.capabilityId, verdict, note: receipt.feedback.note }
            });
            return { receipt, event };
        });
    }

    async applyCompensation(receiptId) {
        return this._mutate(async (state) => {
            const receipt = state.receipts.find((item) => item.id === receiptId);
            if (!receipt) throw new Error(`Receipt not found: ${receiptId}`);
            const mutations = receipt.transaction?.userArtifactMutations || [];
            if (!mutations.length) throw new Error('This receipt declared no user-artifact mutations to revert.');
            if (receipt.compensationAppliedAt) throw new Error(`Receipt ${receiptId} was already reverted.`);

            const applied = [];
            const failed = [];
            // Apply compensations in reverse order so dependent effects unwind last-in-first-out.
            for (const mutation of [...mutations].reverse()) {
                const compensation = mutation.compensation;
                try {
                    if (!compensation?.action) throw new Error('mutation recorded without a compensating action');
                    if (compensation.action === 'delete-created-artifact') {
                        if (await pathExists(compensation.path)) await rm(compensation.path);
                    } else if (compensation.action === 'move') {
                        if (!(await pathExists(compensation.from))) throw new Error(`moved artifact is gone: ${compensation.from}`);
                        if (await pathExists(compensation.to)) throw new Error(`rollback target exists: ${compensation.to}`);
                        await rename(compensation.from, compensation.to);
                    } else {
                        throw new Error(`unsupported compensation action: ${compensation.action}`);
                    }
                    applied.push({ kind: mutation.kind, path: mutation.path || compensation.path || compensation.from });
                } catch (error) {
                    failed.push({ kind: mutation.kind, detail: cleanText(error.message, 200) });
                }
            }

            const now = this._now();
            if (failed.length === 0) {
                receipt.compensationAppliedAt = now;
            } else {
                receipt.compensationPartial = { appliedCount: applied.length, failedCount: failed.length, failed, attemptedAt: now };
            }

            const capability = state.capabilities.find((item) => item.id === receipt.capabilityId);
            if (capability && failed.length === 0) {
                const metrics = normalizeCapabilityMetrics(capability.metrics);
                capability.metrics = normalizeCapabilityMetrics({ ...metrics, rejected: metrics.rejected + 1 });
            }
            const event = this._appendEvent(state, {
                kind: 'work.reverted',
                source: 'user',
                summary: failed.length === 0
                    ? `All ${applied.length} declared artifact effect(s) from ${receipt.capabilityId} were reverted via their recorded compensations.`
                    : `Compensation for ${receipt.id} partially failed (${failed.length} of ${mutations.length}); manual review required.`,
                importance: failed.length === 0 ? 0.7 : 1,
                data: { receiptId, capabilityId: receipt.capabilityId, applied, failed },
                dedupeKey: `work.reverted:${receiptId}`
            });
            return { receipt, applied, failed, event };
        });
    }

    async audit() {
        const state = await this.getState();
        // The anchor check reads the durable head journal; cache the result so
        // audit stays a single consistent snapshot.
        this._anchorCache = await this._verifyLedgerAnchor();
        const active = state.capabilities.filter((capability) => capability.status === 'active');
        const modernReceipts = state.receipts.filter((receipt) => receipt.packageDigest);
        const checks = [
            {
                id: 'schema-current',
                passed: state.schemaVersion === SCHEMA_VERSION,
                evidence: `schema=${state.schemaVersion}`
            },
            {
                id: 'package-integrity',
                passed: active.every((capability) => validateCapabilityPackage(capability.package).status === 'passed'),
                evidence: `${active.length} active package(s) checked`
            },
            {
                id: 'bounded-authority',
                passed: active.every((capability) => (capability.permissions || []).every((permission) => SAFE_PERMISSIONS.has(permission))),
                evidence: `${active.length} active package(s) use only constitution-registered permissions`
            },
            {
                id: 'no-autopoietic-execution',
                passed: active.every((capability) => (capability.steps || []).every((step) => !FORBIDDEN_PRIMITIVES.has(step.primitive))),
                evidence: 'no model-authored code execution primitive is installed'
            },
            {
                id: 'artifact-effect-honesty',
                passed: modernReceipts.every((receipt) => {
                    const mutations = receipt.transaction?.userArtifactMutations || [];
                    if (!mutations.length) return true;
                    return receipt.transaction?.mode === 'declared-artifact-effects'
                        && mutations.every((mutation) => mutation.compensation)
                        && receipt.reversible === true;
                }),
                evidence: 'artifact mutations, when present, require declared effects and compensating actions'
            },
            {
                id: 'receipt-provenance',
                passed: modernReceipts.length === 0 || modernReceipts.every((receipt) => /^[a-f0-9]{64}$/.test(receipt.packageDigest)),
                evidence: `${modernReceipts.length}/${state.receipts.length} receipt(s) use package provenance; older receipts remain immutable`
            },
            {
                id: 'receipt-ledger-integrity',
                passed: this._verifyReceiptLedger(state).intact,
                evidence: `${this._verifyReceiptLedger(state).chained} chained receipt link(s) verified`
            },
            (() => {
                const anchor = this._anchorCache || { intact: true, anchored: false, evidence: 'not yet verified this cycle' };
                return {
                    id: 'ledger-anchor',
                    passed: anchor.intact,
                    evidence: anchor.evidence
                };
            })(),
            {
                id: 'persistence-health',
                passed: !this.persistError,
                evidence: this.persistError ? `last save failed: ${this.persistError}` : 'last save succeeded; memory and disk agree'
            },
            {
                id: 'constitution-integrity',
                passed: state.constitution?.autonomy === 'bounded'
                    && ['install-capability', 'modify-user-files', 'external-side-effect', 'change-constitution']
                        .every((item) => (state.constitution?.approvalRequired || []).includes(item)),
                evidence: `autonomy=${state.constitution?.autonomy || 'missing'}`
            },
            {
                id: 'retirement-review-pending',
                passed: !active.some((capability) => capability.metrics?.fitness?.recommendation === 'retire-review'),
                evidence: active.filter((capability) => capability.metrics?.fitness?.recommendation === 'retire-review')
                    .map((capability) => `${capability.id}@${capability.version}`).join(', ') || 'no capability is awaiting retirement review'
            },
            {
                id: 'noise-restraint',
                passed: !state.proposals.some((proposal) => ['proposed', 'validated', 'rehearsed'].includes(proposal.status) && proposal.trigger?.eventKinds?.includes('perception.unknown')),
                evidence: 'uncertainty telemetry cannot justify pending growth'
            },
            {
                id: 'verification',
                passed: state.stats.verificationRate >= 90,
                evidence: `verification=${state.stats.verificationRate}%`
            }
        ];
        const passed = checks.filter((check) => check.passed).length;
        return {
            status: passed === checks.length ? 'passed' : 'attention',
            score: Math.round((passed / checks.length) * 100),
            checks,
            generatedAt: this._now()
        };
    }

    async health() {
        const state = await this.getState();
        // A refusal is correct governance, not degradation; only work that ran
        // and failed its own verification degrades health.
        const failed = state.receipts.filter((receipt) => receipt.status !== 'verified' && receipt.status !== 'refused-authority').length;
        return {
            status: failed ? 'degraded' : 'healthy',
            refusedReceipts: state.stats.refusedReceipts,
            identity: state.identity,
            worldRevision: state.world.revision,
            activeCapabilities: state.stats.activeCapabilities,
            pendingProposals: state.stats.pendingProposals,
            packageVersions: state.stats.packageVersions,
            averageFitness: state.stats.averageFitness,
            verificationRate: state.stats.verificationRate,
            lastCycle: state.cycles[0] || null,
            stateDigest: createHash('sha256').update(JSON.stringify({
                revision: state.world.revision,
                events: state.events.length,
                capabilities: state.capabilities.map((item) => `${item.id}@${item.version}`),
                receipts: state.receipts.map((item) => `${item.id}:${item.status}`).slice(0, 30)
            })).digest('hex')
        };
    }
}

export const livingRuntime = new LivingRuntime();
