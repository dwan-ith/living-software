import { createHash } from 'node:crypto';

export const SURFACE_PROTOCOL = 'living-surface/v1';

export const SURFACE_BINDINGS = Object.freeze([
    'none',
    'living.identity',
    'living.stats',
    'living.loops',
    'living.reflections',
    'living.capabilities',
    'living.proposals',
    'living.receipts',
    'living.events',
    'living.world.entities',
    'living.constitution',
    'workspace.surfaces',
    'workspace.dependencies',
    'memory.recent'
]);

export const SURFACE_ACTIONS = Object.freeze([
    'surface.regenerate',
    'living.cycle',
    'capability.run',
    'capability.rollback',
    'proposal.validate',
    'proposal.rehearse',
    'proposal.activate',
    'proposal.reject',
    'receipt.useful',
    'receipt.reject',
    'receipt.revert'
]);

export const SURFACE_COMPONENT_CATALOG = Object.freeze({
    'intent-brief': {
        description: 'A contextual lead card explaining the current user intent and why this surface was composed.',
        bindings: ['none', 'living.reflections'],
        actions: ['surface.regenerate', 'living.cycle']
    },
    'runtime-identity': {
        description: 'Persistent identity, habitat, boot continuity, and autonomy.',
        bindings: ['living.identity'],
        actions: ['surface.regenerate']
    },
    'metric-strip': {
        description: 'Compact runtime metrics selected for the current task.',
        bindings: ['living.stats'],
        actions: []
    },
    'loop-status': {
        description: 'World, work, and evolution loop state.',
        bindings: ['living.loops'],
        actions: ['living.cycle']
    },
    'reflection-card': {
        description: 'Recent higher-level reflection with evidence and recommendation.',
        bindings: ['living.reflections'],
        actions: []
    },
    'capability-list': {
        description: 'Installed capability packages, versions, fitness, and lifecycle controls.',
        bindings: ['living.capabilities'],
        actions: ['capability.run', 'capability.rollback']
    },
    'proposal-list': {
        description: 'Capability proposals with validation, rehearsal, activation, and rejection controls.',
        bindings: ['living.proposals'],
        actions: ['proposal.validate', 'proposal.rehearse', 'proposal.activate', 'proposal.reject']
    },
    'receipt-list': {
        description: 'Verified work receipts, real effects, evidence, feedback, and revert controls.',
        bindings: ['living.receipts'],
        actions: ['receipt.useful', 'receipt.reject', 'receipt.revert']
    },
    'event-stream': {
        description: 'Recent world, work, evolution, and interface events.',
        bindings: ['living.events'],
        actions: []
    },
    'world-entities': {
        description: 'Observed habitat entities and their current states.',
        bindings: ['living.world.entities'],
        actions: []
    },
    'dependency-graph': {
        description: 'A task-specific dependency and downstream-risk graph.',
        bindings: ['workspace.dependencies'],
        actions: []
    },
    'workspace-map': {
        description: 'Observed workspace surfaces, authority, status, and object counts.',
        bindings: ['workspace.surfaces'],
        actions: []
    },
    'memory-stream': {
        description: 'Recent persistent facts and episodes relevant to continuity.',
        bindings: ['memory.recent'],
        actions: []
    },
    'constitution-card': {
        description: 'Autonomy boundary, governing principles, and approval requirements.',
        bindings: ['living.constitution'],
        actions: []
    },
    'generation-trace': {
        description: 'Provenance for this generated phenotype: source, context digest, revision, and warnings.',
        bindings: ['none'],
        actions: ['surface.regenerate']
    }
});

const COMPONENT_TYPES = Object.freeze(Object.keys(SURFACE_COMPONENT_CATALOG));
const REGIONS = Object.freeze(['lead', 'main', 'context']);
const WIDTHS = Object.freeze(['full', 'half', 'third']);

function clean(value, max = 500) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function plainProps(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 16)) {
        if (!/^[a-z][a-zA-Z0-9]{0,40}$/.test(key)) continue;
        if (typeof item === 'string') result[key] = clean(item, 500);
        if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
        if (typeof item === 'boolean') result[key] = item;
    }
    return result;
}

export function surfaceCatalogForModel() {
    return Object.entries(SURFACE_COMPONENT_CATALOG).map(([type, definition]) => ({
        type,
        description: definition.description,
        bindings: definition.bindings,
        actions: definition.actions
    }));
}

export const SURFACE_RESPONSE_JSON_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
        title: { type: 'string', maxLength: 100 },
        rationale: { type: 'string', maxLength: 500 },
        focus: { type: 'string', maxLength: 240 },
        layout: { type: 'string', enum: ['focus', 'split', 'canvas'] },
        components: {
            type: 'array',
            minItems: 1,
            maxItems: 14,
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,48}$' },
                    type: { type: 'string', enum: COMPONENT_TYPES },
                    region: { type: 'string', enum: REGIONS },
                    width: { type: 'string', enum: WIDTHS },
                    title: { type: 'string', maxLength: 100 },
                    description: { type: 'string', maxLength: 320 },
                    binding: { type: 'string', enum: SURFACE_BINDINGS },
                    limit: { type: 'integer', minimum: 1, maximum: 24 },
                    actions: {
                        type: 'array',
                        maxItems: 6,
                        items: { type: 'string', enum: SURFACE_ACTIONS }
                    },
                    props: {
                        type: 'object',
                        additionalProperties: {
                            anyOf: [
                                { type: 'string', maxLength: 500 },
                                { type: 'number' },
                                { type: 'boolean' }
                            ]
                        }
                    }
                },
                required: ['id', 'type', 'region', 'width', 'title', 'binding', 'actions']
            }
        }
    },
    required: ['title', 'rationale', 'focus', 'layout', 'components']
});

export function validateSurfaceCandidate(candidate) {
    const errors = [];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return { status: 'failed', errors: ['surface candidate must be an object'] };
    }
    if (!clean(candidate.title, 100)) errors.push('title is required');
    if (!clean(candidate.rationale, 500)) errors.push('rationale is required');
    if (!['focus', 'split', 'canvas'].includes(candidate.layout)) errors.push('layout is invalid');
    if (!Array.isArray(candidate.components) || candidate.components.length < 1 || candidate.components.length > 14) {
        errors.push('components must contain between 1 and 14 nodes');
    }

    const ids = new Set();
    for (const [index, component] of (candidate.components || []).entries()) {
        const prefix = `components[${index}]`;
        if (!component || typeof component !== 'object') {
            errors.push(`${prefix} must be an object`);
            continue;
        }
        if (!/^[a-z][a-z0-9-]{1,48}$/.test(String(component.id || ''))) errors.push(`${prefix}.id is invalid`);
        if (ids.has(component.id)) errors.push(`${prefix}.id is duplicated`);
        ids.add(component.id);
        const definition = SURFACE_COMPONENT_CATALOG[component.type];
        if (!definition) {
            errors.push(`${prefix}.type is not registered`);
            continue;
        }
        if (!REGIONS.includes(component.region)) errors.push(`${prefix}.region is invalid`);
        if (!WIDTHS.includes(component.width)) errors.push(`${prefix}.width is invalid`);
        if (!definition.bindings.includes(component.binding)) errors.push(`${prefix}.binding is not allowed for ${component.type}`);
        if (!Array.isArray(component.actions)) errors.push(`${prefix}.actions must be an array`);
        else if (component.actions.some((action) => !definition.actions.includes(action))) errors.push(`${prefix}.actions contains an undeclared action`);
    }
    return { status: errors.length ? 'failed' : 'passed', errors };
}

export function normalizeSurfaceCandidate(candidate) {
    const validation = validateSurfaceCandidate(candidate);
    if (validation.status !== 'passed') {
        throw new Error(`Invalid generative surface: ${validation.errors.join('; ')}`);
    }
    return {
        title: clean(candidate.title, 100),
        rationale: clean(candidate.rationale, 500),
        focus: clean(candidate.focus, 240),
        layout: candidate.layout,
        components: candidate.components.map((component) => ({
            id: component.id,
            type: component.type,
            region: component.region,
            width: component.width,
            title: clean(component.title, 100),
            description: clean(component.description, 320),
            binding: component.binding,
            limit: Math.max(1, Math.min(24, Math.floor(Number(component.limit) || 8))),
            actions: [...new Set(component.actions)],
            props: plainProps(component.props)
        }))
    };
}

export function digestSurfaceContext(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const TARGET_COLLECTIONS = Object.freeze({
    'capability.run': 'capabilities',
    'capability.rollback': 'capabilities',
    'proposal.validate': 'proposals',
    'proposal.rehearse': 'proposals',
    'proposal.activate': 'proposals',
    'proposal.reject': 'proposals',
    'receipt.useful': 'receipts',
    'receipt.reject': 'receipts',
    'receipt.revert': 'receipts'
});

export function authorizeSurfaceAction(surface, input = {}) {
    if (!surface || surface.protocol !== SURFACE_PROTOCOL) throw new Error('Current surface is unavailable.');
    if (input.surfaceId !== surface.id || Number(input.revision) !== Number(surface.revision)) {
        throw new Error('Surface action is stale; regenerate before acting.');
    }
    const component = surface.components.find((item) => item.id === input.componentId);
    if (!component) throw new Error('Source component is not present on the current surface.');
    const action = clean(input.action, 80);
    if (!SURFACE_ACTIONS.includes(action) || !component.actions.includes(action)) {
        throw new Error(`Action ${action || '(missing)'} was not declared by this component.`);
    }
    const collection = TARGET_COLLECTIONS[action];
    const targetId = clean(input.targetId, 160) || null;
    if (collection) {
        const items = surface.data?.living?.[collection];
        if (!targetId || !Array.isArray(items) || !items.some((item) => item.id === targetId)) {
            throw new Error(`Action target is not bound to this surface: ${targetId || '(missing)'}`);
        }
    } else if (targetId) {
        throw new Error('This action does not accept a target.');
    }
    return { component, action, targetId };
}

/**
 * Idempotency key for a surface action: identical intent against the same
 * revision is a replay (double click), not a second execution.
 */
export function surfaceActionKey(input = {}) {
    const payload = JSON.stringify({
        surfaceId: String(input.surfaceId || ''),
        revision: Number(input.revision) || 0,
        componentId: String(input.componentId || ''),
        action: String(input.action || ''),
        targetId: String(input.targetId || '')
    });
    return createHash('sha256').update(payload).digest('hex');
}
