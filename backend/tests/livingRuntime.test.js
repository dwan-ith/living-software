import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LivingRuntime } from '../livingRuntime.js';

async function runtimeFixture(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'living-runtime-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const runtime = new LivingRuntime({ dataPath: path.join(directory, 'state.json') });
    await runtime.initialize();
    return { runtime, directory };
}

const worldSnapshot = {
    generatedAt: '2026-08-11T00:00:00.000Z',
    surfaces: [
        { id: 'screen', label: 'Screen', authority: 'continuous screenshot perception', count: 1, status: 'live' },
        { id: 'notes', label: 'Notes', authority: 'content-grounded note adapter', count: 4, status: 'content-ready' },
        { id: 'memory', label: 'Memory', authority: 'persistent runtime memory', count: 8, status: 'persistent' }
    ]
};

test('initialization creates persistent identity, constitution, and built-in capabilities', async (t) => {
    const { runtime } = await runtimeFixture(t);
    const state = await runtime.getState();

    assert.equal(state.schemaVersion, 2);
    assert.equal(state.identity.name, 'Living Software');
    assert.equal(state.identity.bootCount, 1);
    assert.equal(state.constitution.autonomy, 'bounded');
    assert.ok(state.capabilities.some((item) => item.id === 'continuity.snapshot'));
    assert.ok(state.capabilities.every((item) => item.package?.digest));
    assert.ok(state.events.some((item) => item.kind === 'runtime.boot'));
});

test('world and work loops update durable state and emit verified receipts', async (t) => {
    const { runtime } = await runtimeFixture(t);
    const observation = await runtime.observeWorld(worldSnapshot, { source: 'test' });
    const result = await runtime.runCycle({ reason: 'test-cycle' });
    const state = await runtime.getState();

    assert.equal(observation.changed.length, 3);
    assert.equal(state.world.revision, 1);
    assert.equal(state.world.entities.length, 3);
    assert.equal(result.cycle.status, 'verified');
    assert.equal(result.receipt.status, 'verified');
    assert.ok(result.reflection.evidenceEventIds.length > 0);
    assert.equal(state.stats.verificationRate, 100);
});

test('evolution loop proposes, installs, executes, and verifies a capability', async (t) => {
    const { runtime } = await runtimeFixture(t);
    await runtime.observeWorld(worldSnapshot, { source: 'test' });
    // Four grounded repetitions are required before growth is proposed; three
    // is ordinary noise (see the noise-cap test below).
    for (let index = 0; index < 4; index += 1) {
        await runtime.recordEvent({
            kind: 'perception.opportunity',
            source: 'test',
            summary: `Repeated opportunity ${index + 1}`,
            importance: 0.6,
            data: { index, confidence: 0.8 }
        });
    }

    const cycle = await runtime.runCycle({ reason: 'evolution-test' });
    assert.ok(cycle.proposal);
    assert.equal(cycle.proposal.status, 'proposed');

    const validation = await runtime.validateProposal(cycle.proposal.id);
    assert.equal(validation.validation.status, 'passed');
    const rehearsal = await runtime.dryRunProposal(cycle.proposal.id);
    assert.equal(rehearsal.rehearsal.status, 'passed');

    const installed = await runtime.installProposal(cycle.proposal.id);
    assert.equal(installed.capability.status, 'active');
    assert.equal(installed.proposal.status, 'installed');

    const receipt = await runtime.executeCapability(installed.capability.id);
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.packageDigest, installed.capability.package.digest);
    assert.deepEqual(receipt.transaction.externalEffects, []);
    assert.ok(receipt.evidence.length >= 2);
});

test('uncertain perception telemetry cannot justify capability growth', async (t) => {
    const { runtime } = await runtimeFixture(t);
    for (let index = 0; index < 4; index += 1) {
        await runtime.recordEvent({
            kind: 'perception.unknown',
            source: 'test',
            summary: `Uncertain observation ${index + 1}`,
            importance: 0.55,
            data: { confidence: 0.9 }
        });
        await runtime.recordEvent({
            kind: 'perception.opportunity',
            source: 'test',
            summary: `Low-confidence opportunity ${index + 1}`,
            importance: 0.55,
            data: { confidence: 0.4 }
        });
    }

    const cycle = await runtime.runCycle({ reason: 'noise-restraint-test' });
    const state = await runtime.getState();

    assert.equal(cycle.proposal, null);
    assert.equal(state.stats.pendingProposals, 0);
});

test('explicit review can reject a proposal without installing a capability', async (t) => {
    const { runtime } = await runtimeFixture(t);
    const proposal = await runtime.proposeCapability({
        name: 'Evidence Continuity',
        rationale: 'Preserve an evidence-linked context snapshot.',
        steps: [{ primitive: 'world.snapshot' }, { primitive: 'context.reflect' }],
        synthesis: { source: 'deterministic-safe-fallback', degraded: true }
    });

    const rejected = await runtime.rejectProposal(proposal.id, 'Provider fallback needs a better review result.');
    const state = await runtime.getState();

    assert.equal(rejected.proposal.status, 'rejected');
    assert.match(rejected.proposal.rejectionReason, /better review/);
    assert.ok(!state.capabilities.some((item) => item.proposalId === proposal.id));
    assert.ok(state.events.some((item) => item.kind === 'evolution.rejected'));
});

test('the work loop rests instead of emitting redundant continuity receipts', async (t) => {
    const { runtime } = await runtimeFixture(t);
    await runtime.observeWorld(worldSnapshot, { source: 'test' });

    const first = await runtime.runCycle({ reason: 'triggered' });
    assert.equal(first.cycle.status, 'verified');
    assert.ok(first.receipt);

    // No new trigger-matching events arrived and continuity is fresh: a second
    // immediate cycle must rest rather than spam an identical receipt.
    const second = await runtime.runCycle({ reason: 'scheduled' });
    assert.equal(second.receipt, null);
    assert.equal(second.cycle.status, 'rested');
    const state = await runtime.getState();
    assert.ok(state.events.some((event) => event.kind === 'work.rest'));
});

test('feedback changes capability evidence without rewriting prior outcomes', async (t) => {
    const { runtime } = await runtimeFixture(t);
    const receipt = await runtime.executeCapability('continuity.snapshot');
    const feedback = await runtime.recordFeedback({ receiptId: receipt.id, verdict: 'rejected', note: 'The snapshot lacked the context I needed.' });
    const state = await runtime.getState();
    const capability = state.capabilities.find((item) => item.id === 'continuity.snapshot');

    assert.equal(feedback.receipt.status, 'verified');
    assert.equal(feedback.receipt.feedback.verdict, 'rejected');
    assert.equal(capability.metrics.rejected, 1);
    assert.ok(state.events.some((item) => item.kind === 'work.feedback'));
});

test('a new process resumes the same identity and event history', async (t) => {
    const { runtime, directory } = await runtimeFixture(t);
    await runtime.recordEvent({ kind: 'user.intent', source: 'test', summary: 'Preserve this across process restarts.' });

    const resumed = new LivingRuntime({ dataPath: path.join(directory, 'state.json') });
    await resumed.initialize();
    const state = await resumed.getState();

    assert.equal(state.identity.bootCount, 2);
    assert.ok(state.events.some((item) => item.summary.includes('Preserve this across process restarts')));
    assert.ok(state.events.filter((item) => item.kind === 'runtime.boot').length >= 2);
});
