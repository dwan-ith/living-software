import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LivingRuntime } from '../livingRuntime.js';

async function benchRuntime(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'living-bench-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const runtime = new LivingRuntime({ dataPath: path.join(directory, 'state.json') });
    await runtime.initialize();
    await runtime.observeWorld({
        surfaces: [
            { id: 'screen', label: 'Screen', authority: 'local pixels', count: 1, status: 'captured' },
            { id: 'notes', label: 'Notes', authority: 'read-only evidence', count: 3, status: 'content-ready' }
        ]
    });
    await runtime.runCycle({ reason: 'bench-seed' });
    return runtime;
}

async function rehearseAndInstall(runtime, proposalId) {
    const validation = await runtime.validateProposal(proposalId);
    assert.equal(validation.validation.status, 'passed');
    const rehearsal = await runtime.dryRunProposal(proposalId);
    assert.equal(rehearsal.rehearsal.status, 'passed');
    return runtime.installProposal(proposalId);
}

test('LivingBench governance: activation is impossible before validation and rehearsal', async (t) => {
    const runtime = await benchRuntime(t);
    const proposal = await runtime.proposeCapability({
        name: 'Evidence Continuity',
        rationale: 'Preserve an evidence-linked snapshot and reflection.',
        triggerKinds: ['artifact.analysis'],
        steps: [{ primitive: 'world.snapshot' }, { primitive: 'context.reflect' }]
    });

    await assert.rejects(runtime.installProposal(proposal.id), /validation and dry-run/);
    await runtime.validateProposal(proposal.id);
    await assert.rejects(runtime.installProposal(proposal.id), /validation and dry-run/);
    await runtime.dryRunProposal(proposal.id);
    const installed = await runtime.installProposal(proposal.id);
    await runtime.executeCapability(installed.capability.id);
    const audit = await runtime.audit();

    assert.equal(installed.capability.status, 'active');
    assert.equal(installed.capability.version, 1);
    assert.match(installed.capability.package.digest, /^[a-f0-9]{64}$/);
    assert.equal(audit.status, 'passed');
    assert.equal(audit.score, 100);
});

test('LivingBench constitution: unsafe primitives fail package validation', async (t) => {
    const runtime = await benchRuntime(t);
    const proposal = await runtime.proposeCapability({
        name: 'Unsafe Mutation',
        rationale: 'Attempt an unauthorized action.',
        steps: [{ primitive: 'shell.execute' }],
        permissions: ['external:network']
    });
    const result = await runtime.validateProposal(proposal.id);

    assert.equal(result.validation.status, 'failed');
    assert.equal(result.proposal.status, 'invalid');
    assert.ok(result.validation.checks.some((check) => check.id === 'safe-primitives' && !check.passed));
    assert.ok(result.validation.checks.some((check) => check.id === 'safe-permissions' && !check.passed));
});

test('LivingBench effect honesty: artifact-changing capabilities cannot be automatic and rehearsal never commits', async (t) => {
    const runtime = await benchRuntime(t);
    const unsafeAutomatic = await runtime.proposeCapability({
        name: 'Automatic Proposal Writer',
        rationale: 'Attempt an automatic artifact write.',
        automatic: true,
        permissions: ['write:proposals'],
        steps: [{ primitive: 'write.proposal' }]
    });
    const failed = await runtime.validateProposal(unsafeAutomatic.id);
    assert.equal(failed.validation.status, 'failed');
    assert.ok(failed.validation.checks.some((item) => item.id === 'automatic-artifact-effects' && !item.passed));

    const reviewed = await runtime.proposeCapability({
        name: 'Reviewed Proposal Writer',
        rationale: 'Write only after explicit activation and execution.',
        automatic: false,
        permissions: ['write:proposals'],
        steps: [{ primitive: 'write.proposal' }]
    });
    const validation = await runtime.validateProposal(reviewed.id);
    assert.equal(validation.validation.status, 'passed');
    const rehearsal = await runtime.dryRunProposal(reviewed.id, { draft: 'No file should exist after this rehearsal.' });
    assert.equal(rehearsal.rehearsal.status, 'passed');
    assert.equal(rehearsal.rehearsal.plan.mode, 'rehearsal');
    assert.equal(rehearsal.rehearsal.plan.userArtifactMutations.length, 0);
    assert.equal(rehearsal.rehearsal.plan.declaredEffects[0].kind, 'user-artifact-write');
});

test('LivingBench evolution: a package upgrades in place and rolls back to its prior version', async (t) => {
    const runtime = await benchRuntime(t);
    const first = await runtime.proposeCapability({
        name: 'Research Continuity',
        rationale: 'Capture the current research habitat.',
        steps: [{ primitive: 'world.snapshot' }]
    });
    const installedV1 = await rehearseAndInstall(runtime, first.id);

    const upgrade = await runtime.proposeCapability({
        targetCapabilityId: installedV1.capability.id,
        name: 'Research Continuity',
        rationale: 'Capture the habitat and add an evidence-linked reflection.',
        steps: [{ primitive: 'world.snapshot' }, { primitive: 'context.reflect' }]
    });
    const installedV2 = await rehearseAndInstall(runtime, upgrade.id);

    assert.equal(installedV2.capability.id, installedV1.capability.id);
    assert.equal(installedV2.capability.version, 2);
    assert.equal(installedV2.capability.packageHistory.length, 1);

    const rollback = await runtime.rollbackCapability(installedV2.capability.id, 'Version 2 did not improve the workflow.');
    assert.equal(rollback.capability.status, 'active');
    assert.equal(rollback.capability.version, 1);
    assert.equal(rollback.capability.lifecycle.rollbackCount, 1);
    assert.equal(rollback.capability.retiredPackages.length, 1);
});

test('LivingBench fitness: verified execution and explicit feedback update capability utility', async (t) => {
    const runtime = await benchRuntime(t);
    const proposal = await runtime.proposeCapability({
        name: 'Context Packet',
        rationale: 'Produce a reversible context packet.',
        steps: [{ primitive: 'world.snapshot' }, { primitive: 'context.reflect' }]
    });
    const installed = await rehearseAndInstall(runtime, proposal.id);
    const first = await runtime.executeCapability(installed.capability.id);
    const second = await runtime.executeCapability(installed.capability.id);
    await runtime.recordFeedback({ receiptId: first.id, verdict: 'useful', note: 'Preserved the right evidence.' });
    await runtime.recordFeedback({ receiptId: second.id, verdict: 'rejected', note: 'Too broad for this context.' });
    const state = await runtime.getState();
    const capability = state.capabilities.find((item) => item.id === installed.capability.id);

    assert.equal(capability.metrics.runs, 2);
    assert.equal(capability.metrics.verified, 2);
    assert.equal(capability.metrics.useful, 1);
    assert.equal(capability.metrics.rejected, 1);
    assert.ok(capability.metrics.fitness.score >= 65 && capability.metrics.fitness.score <= 100);
});
