import { createHash } from 'node:crypto';

export const CAPABILITY_SCHEMA = 'living-capability/v1';

export const SAFE_PRIMITIVES = new Set([
    'world.snapshot',
    'context.reflect',
    'risk.summarize',
    'workspace.read',        // read up to 8 KB of a workspace-rooted text file
    'gemini.synthesize',     // call Gemini to draft bounded proposal text
    'write.proposal',        // write a .md file under <workspace>/Living-Proposals/
    'file.sort',             // move a file to a semantic subfolder in Downloads (never overwrites)
    'idle.detect',           // check OS-level user idle time
    'screen.interpret'       // extract app/window/summary from the last screenshot
]);

// FORBIDDEN_PRIMITIVES documents capabilities the constitution explicitly denies.
// They are rejected during package validation even if someone reintroduces them here.
export const FORBIDDEN_PRIMITIVES = Object.freeze(new Set([
    'system.eval',           // model-authored code execution — constitution level 6 violation
    'shell.execute',
    'fs.write-raw'
]));

export const SAFE_PERMISSIONS = new Set([
    'read:world',
    'read:events',
    'read:workspace',
    'read:workspace-content',
    'read:screen-state',
    'write:living-state',
    'write:proposals',
    'write:downloads-sort'
]);

export const SAFE_PRECONDITIONS = new Set([
    'world.available',
    'events.available',
    'dependencies.available'
]);

export const SAFE_POSTCONDITIONS = new Set([
    'receipt.emitted',
    'steps.verified',
    'no-user-files-mutated',
    'effects.declared'
]);

export const PRIMITIVE_EFFECTS = Object.freeze({
    'world.snapshot': 'runtime-read',
    'context.reflect': 'runtime-write',
    'risk.summarize': 'workspace-read',
    'workspace.read': 'workspace-read',
    'gemini.synthesize': 'external-inference',
    'write.proposal': 'user-artifact-write',
    'file.sort': 'user-artifact-move',
    'idle.detect': 'runtime-read',
    'screen.interpret': 'external-inference'
});

const REQUIRED_PERMISSIONS = {
    'world.snapshot': ['read:world'],
    'context.reflect': ['read:events', 'write:living-state'],
    'risk.summarize': ['read:workspace'],
    'workspace.read': ['read:workspace-content'],
    'gemini.synthesize': ['read:events', 'write:living-state'],
    'write.proposal': ['write:proposals'],
    'file.sort': ['write:downloads-sort'],
    'idle.detect': ['read:screen-state'],
    'screen.interpret': ['read:screen-state', 'read:world']
};

function clean(value, max = 500) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function unique(items, limit = 20) {
    return [...new Set(items.filter(Boolean))].slice(0, limit);
}

export function capabilitySlug(value) {
    return clean(value, 100)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'capability';
}

export function digestCapabilityManifest(manifest) {
    return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function createCapabilityPackage(input = {}) {
    const steps = unique((Array.isArray(input.steps) ? input.steps : [])
        .map((step) => clean(step?.primitive, 100)))
        .map((primitive) => ({ primitive }));
    const inferredPermissions = steps.flatMap((step) => REQUIRED_PERMISSIONS[step.primitive] || []);
    const permissions = unique([
        ...(Array.isArray(input.permissions) ? input.permissions.map((item) => clean(item, 100)) : []),
        ...inferredPermissions
    ]);
    const capabilityId = clean(input.capabilityId, 120) || `evolved.${capabilitySlug(input.name)}`;
    const version = Math.max(1, Math.floor(Number(input.version) || 1));
    const mutatesUserArtifacts = steps.some((step) => ['user-artifact-write', 'user-artifact-move'].includes(PRIMITIVE_EFFECTS[step.primitive]));
    const manifest = {
        schema: CAPABILITY_SCHEMA,
        capabilityId,
        version,
        name: clean(input.name, 120),
        description: clean(input.description || input.rationale, 800),
        origin: clean(input.origin, 80) || 'user-directed',
        automatic: Boolean(input.automatic),
        trigger: {
            eventKinds: unique((input.triggerKinds || input.trigger?.eventKinds || []).map((kind) => clean(kind, 100)), 10),
            threshold: Math.max(1, Math.min(20, Math.floor(Number(input.trigger?.threshold || input.threshold) || 1))),
            cooldownMs: Math.max(0, Math.min(86_400_000, Math.floor(Number(input.trigger?.cooldownMs || input.cooldownMs) || 0)))
        },
        permissions,
        steps,
        preconditions: unique((input.preconditions || ['world.available', 'events.available']).map((item) => clean(item, 100)), 10),
        postconditions: unique((input.postconditions || [
            'receipt.emitted',
            'steps.verified',
            mutatesUserArtifacts ? 'effects.declared' : 'no-user-files-mutated'
        ]).map((item) => clean(item, 100)), 10),
        rollback: mutatesUserArtifacts ? {
            mode: 'compensating-action',
            scope: 'declared-artifacts',
            userArtifactMutation: true
        } : {
            mode: 'restore-previous-package-or-deactivate',
            scope: 'runtime-state-only',
            userArtifactMutation: false
        },
        tests: unique((input.tests || [
            'All primitives and permissions are constitution-approved.',
            'A dry-run verifies every declared step.',
            'Execution emits an evidence-linked receipt.',
            'No user artifact or external system is mutated.'
        ]).map((item) => clean(item, 240)), 12)
    };
    return { manifest, digest: digestCapabilityManifest(manifest) };
}

export function validateCapabilityPackage(pkg, options = {}) {
    const manifest = pkg?.manifest || {};
    const checks = [];
    const check = (id, passed, evidence) => checks.push({ id, passed: Boolean(passed), evidence: clean(evidence, 300) });

    check('schema', manifest.schema === CAPABILITY_SCHEMA, `schema=${manifest.schema || 'missing'}`);
    check('identity', Boolean(manifest.capabilityId && manifest.name && manifest.description), `capability=${manifest.capabilityId || 'missing'} version=${manifest.version || 'missing'}`);
    check('digest', pkg?.digest === digestCapabilityManifest(manifest), 'manifest digest must match its canonical content');

    const primitives = (manifest.steps || []).map((step) => step.primitive);
    check('bounded-steps', primitives.length > 0 && primitives.length <= 8, `${primitives.length} declared step(s)`);
    check('safe-primitives', primitives.every((primitive) => SAFE_PRIMITIVES.has(primitive)), primitives.join(', ') || 'none');
    check('forbidden-primitives', primitives.every((primitive) => !FORBIDDEN_PRIMITIVES.has(primitive)),
        primitives.filter((primitive) => FORBIDDEN_PRIMITIVES.has(primitive)).join(', ') || 'no constitution-denied primitive');
    check('safe-permissions', (manifest.permissions || []).every((permission) => SAFE_PERMISSIONS.has(permission)), (manifest.permissions || []).join(', ') || 'none');

    const missingPermissions = primitives.flatMap((primitive) => REQUIRED_PERMISSIONS[primitive] || [])
        .filter((permission) => !(manifest.permissions || []).includes(permission));
    check('least-authority-complete', missingPermissions.length === 0, missingPermissions.length ? `missing ${unique(missingPermissions).join(', ')}` : 'all primitive permissions declared');
    check('safe-preconditions', (manifest.preconditions || []).every((condition) => SAFE_PRECONDITIONS.has(condition)), (manifest.preconditions || []).join(', '));
    check('safe-postconditions', (manifest.postconditions || []).every((condition) => SAFE_POSTCONDITIONS.has(condition)), (manifest.postconditions || []).join(', '));
    const fileActingPrimitives = primitives.filter((primitive) => ['user-artifact-write', 'user-artifact-move'].includes(PRIMITIVE_EFFECTS[primitive]));
    const rollbackValid = fileActingPrimitives.length
        ? manifest.rollback?.mode === 'compensating-action' && manifest.rollback?.scope === 'declared-artifacts' && manifest.rollback?.userArtifactMutation === true
        : manifest.rollback?.scope === 'runtime-state-only' && manifest.rollback?.userArtifactMutation === false;
    check('rollback', rollbackValid, fileActingPrimitives.length ? 'artifact effects require a declared compensating action' : 'rollback is bounded to runtime state');
    check('effect-postconditions', fileActingPrimitives.length
        ? (manifest.postconditions || []).includes('effects.declared') && !(manifest.postconditions || []).includes('no-user-files-mutated')
        : (manifest.postconditions || []).includes('no-user-files-mutated'), fileActingPrimitives.length ? 'artifact effects are explicit' : 'user artifacts remain immutable');
    check('automatic-artifact-effects', !fileActingPrimitives.length || manifest.automatic === false, fileActingPrimitives.length ? 'artifact mutation requires a user-started run' : 'no artifact mutation primitive');
    check('no-external-effects', !(manifest.permissions || []).some((permission) => /external|network|shell|filesystem|autopoietic|eval/i.test(permission)), 'no external side-effect authority declared');
    const inferencePrimitives = primitives.filter((primitive) => PRIMITIVE_EFFECTS[primitive] === 'external-inference');
    check('inference-is-user-started', !inferencePrimitives.length || manifest.automatic === false,
        inferencePrimitives.length ? 'external inference requires a user-started run' : 'no external inference primitive');

    if (options.expectedVersion) check('version-sequence', manifest.version === options.expectedVersion, `expected=${options.expectedVersion} actual=${manifest.version}`);
    if (options.expectedCapabilityId) check('upgrade-target', manifest.capabilityId === options.expectedCapabilityId, `expected=${options.expectedCapabilityId} actual=${manifest.capabilityId}`);

    return {
        status: checks.every((item) => item.passed) ? 'passed' : 'failed',
        checks,
        digest: pkg?.digest || null
    };
}

export function normalizeCapabilityMetrics(metrics = {}) {
    const runs = Math.max(0, Number(metrics.runs) || 0);
    const verified = Math.max(0, Number(metrics.verified) || 0);
    const useful = Math.max(0, Number(metrics.useful) || 0);
    const rejected = Math.max(0, Number(metrics.rejected) || 0);
    const incorrect = Math.max(0, Number(metrics.incorrect) || 0);
    const reliability = runs ? Math.round((verified / runs) * 100) : 100;
    const feedbackCount = useful + rejected + incorrect;
    const utility = feedbackCount ? Math.max(0, Math.round(((useful - rejected * 0.5 - incorrect) / feedbackCount) * 100)) : 70;
    const score = Math.round(reliability * 0.65 + utility * 0.35);
    let recommendation = runs < 2 ? 'probation' : 'healthy';
    if (runs >= 3 && (reliability < 70 || incorrect >= 2)) recommendation = 'retire-review';
    else if (rejected >= 2 || score < 65) recommendation = 'review';
    return {
        ...metrics,
        runs,
        verified,
        useful,
        rejected,
        incorrect,
        lastRunAt: metrics.lastRunAt || null,
        fitness: {
            score,
            reliability,
            // Honest provenance for the score: with zero feedback, `utility` is a
            // neutral prior, not evidence. Consumers should check feedbackCount.
            utility,
            feedbackCount,
            recommendation
        }
    };
}

export function normalizeCapabilityRecord(capability = {}) {
    const pkg = capability.package?.manifest
        ? capability.package
        : createCapabilityPackage({
            capabilityId: capability.id,
            version: capability.version,
            name: capability.name,
            description: capability.description,
            origin: capability.origin,
            automatic: capability.automatic,
            trigger: capability.trigger,
            permissions: capability.permissions,
            steps: capability.steps
        });
    const manifest = pkg.manifest;
    return {
        ...capability,
        id: manifest.capabilityId,
        name: manifest.name,
        description: manifest.description,
        origin: manifest.origin,
        version: manifest.version,
        automatic: manifest.automatic,
        trigger: manifest.trigger,
        permissions: manifest.permissions,
        steps: manifest.steps,
        status: capability.status || 'active',
        package: pkg,
        packageHistory: Array.isArray(capability.packageHistory) ? capability.packageHistory : [],
        lifecycle: {
            installedAt: capability.lifecycle?.installedAt || capability.installedAt || null,
            activatedAt: capability.lifecycle?.activatedAt || capability.installedAt || null,
            lastRollbackAt: capability.lifecycle?.lastRollbackAt || null,
            rollbackCount: Number(capability.lifecycle?.rollbackCount || 0)
        },
        metrics: normalizeCapabilityMetrics(capability.metrics)
    };
}
