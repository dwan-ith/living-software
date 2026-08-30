import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SurfaceRuntime } from '../surfaceRuntime.js';
import { validateSurfaceCandidate } from '../surfaceProtocol.js';

function context() {
    return {
        data: {
            living: {
                identity: { name: 'Living Software', bootCount: 3 },
                constitution: { autonomy: 'bounded', principles: [], approvalRequired: [] },
                stats: { activeCapabilities: 2, pendingProposals: 0 },
                loops: {},
                reflections: [],
                capabilities: [{ id: 'continuity.snapshot', name: 'Continuity Snapshot' }],
                proposals: [],
                receipts: [],
                events: [],
                world: { entities: [] }
            },
            workspace: {
                surfaces: [],
                dependencies: { scanned: 2, files: [{ id: 'dependency:app', name: 'App.tsx', risk: 'high', references: 4 }] }
            },
            memory: { recent: [] }
        },
        promptContext: { revision: 1, dependencyFiles: ['App.tsx'] }
    };
}

async function runtimeFixture(options = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'living-surface-test-'));
    const runtime = new SurfaceRuntime({
        dataPath: path.join(directory, 'surfaces.json'),
        contextProvider: async () => context(),
        ...options
    });
    await runtime.initialize();
    return { runtime, directory };
}

test('surface protocol rejects executable or unregistered UI components', () => {
    const validation = validateSurfaceCandidate({
        title: 'Unsafe',
        rationale: 'Attempt arbitrary execution.',
        focus: 'unsafe',
        layout: 'focus',
        components: [{
            id: 'unsafe-code',
            type: 'javascript-eval',
            region: 'main',
            width: 'full',
            title: 'Run code',
            binding: 'none',
            actions: ['shell.execute']
        }]
    });
    assert.equal(validation.status, 'failed');
    assert.ok(validation.errors.some((item) => item.includes('not registered')));
});

test('surface composition changes phenotype with user context', async (t) => {
    const { runtime, directory } = await runtimeFixture();
    t.after(() => rm(directory, { recursive: true, force: true }));

    const dependency = await runtime.compose({ sessionId: 'person-a', utterance: 'Show downstream dependency risk before I delete anything.' });
    const memory = await runtime.compose({ sessionId: 'person-a', utterance: 'Help me recall what mattered in the previous session.' });

    assert.ok(dependency.components.some((item) => item.type === 'dependency-graph'));
    assert.ok(!memory.components.some((item) => item.type === 'dependency-graph'));
    assert.ok(memory.components.some((item) => item.type === 'memory-stream'));
    assert.equal(memory.revision, dependency.revision + 1);
    assert.notEqual(memory.generation.contextDigest, '');
});

test('model-composed surfaces pass through schema and catalog validation', async (t) => {
    const generator = {
        available: () => true,
        compose: async () => ({
            provider: 'test-provider',
            model: 'test-composer',
            candidate: {
                title: 'Capability decision',
                rationale: 'A capability proposal is waiting in the current workflow.',
                focus: 'Review the proposal.',
                layout: 'focus',
                components: [{
                    id: 'proposal-context',
                    type: 'proposal-list',
                    region: 'main',
                    width: 'full',
                    title: 'Proposal',
                    description: '',
                    binding: 'living.proposals',
                    limit: 8,
                    actions: ['proposal.validate', 'proposal.reject'],
                    props: {}
                }]
            }
        })
    };
    const { runtime, directory } = await runtimeFixture({ generator });
    t.after(() => rm(directory, { recursive: true, force: true }));

    const surface = await runtime.compose({ sessionId: 'person-b', utterance: 'Review capability growth.' });
    assert.equal(surface.generation.mode, 'model-composed');
    assert.equal(surface.generation.provider, 'test-provider');
    assert.equal(surface.components[0].type, 'proposal-list');
});

test('surface actions require current revision, declared action, and bound target', async (t) => {
    const { runtime, directory } = await runtimeFixture();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const surface = await runtime.compose({ sessionId: 'person-c', utterance: 'Show capability fitness and rollback.' });
    const node = surface.components.find((item) => item.type === 'capability-list');
    assert.ok(node);

    const authorized = await runtime.authorizeAction('person-c', {
        surfaceId: surface.id,
        revision: surface.revision,
        componentId: node.id,
        action: 'capability.run',
        targetId: 'continuity.snapshot'
    });
    assert.equal(authorized.targetId, 'continuity.snapshot');

    await assert.rejects(runtime.authorizeAction('person-c', {
        surfaceId: surface.id,
        revision: surface.revision - 1,
        componentId: node.id,
        action: 'capability.run',
        targetId: 'continuity.snapshot'
    }), /stale/);

    await assert.rejects(runtime.authorizeAction('person-c', {
        surfaceId: surface.id,
        revision: surface.revision,
        componentId: node.id,
        action: 'proposal.activate',
        targetId: 'continuity.snapshot'
    }), /not declared/);

    await assert.rejects(runtime.authorizeAction('person-c', {
        surfaceId: surface.id,
        revision: surface.revision,
        componentId: node.id,
        action: 'capability.run',
        targetId: 'invented.capability'
    }), /not bound/);
});

test('surface identity, conversation, and history survive restart', async (t) => {
    const { runtime, directory } = await runtimeFixture();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const first = await runtime.compose({ sessionId: 'person-d', utterance: 'Show the living world.' });

    const resumed = new SurfaceRuntime({ dataPath: path.join(directory, 'surfaces.json'), contextProvider: async () => context() });
    const current = await resumed.getCurrent('person-d');
    assert.equal(current.id, first.id);
    assert.equal(current.focus, first.focus);
    const persisted = JSON.parse(await readFile(path.join(directory, 'surfaces.json'), 'utf8'));
    assert.equal(persisted.sessions['person-d'].turns.at(-1).text, 'Show the living world.');
});
