import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ALLOWED_ORIGINS, originAllowed } from '../config.js';
import { FORBIDDEN_PRIMITIVES, SAFE_PRIMITIVES } from '../capabilityKernel.js';
import { LivingRuntime } from '../livingRuntime.js';

async function fixture(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'living-security-'));
    const downloadsDir = path.join(directory, 'Downloads');
    const workspaceRoot = path.join(directory, 'workspace');
    await mkdir(downloadsDir, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    t.after(() => rm(directory, { recursive: true, force: true }));
    const runtime = new LivingRuntime({
        dataPath: path.join(directory, 'state.json'),
        downloadsDir,
        workspaceRoot
    });
    await runtime.initialize();
    return { runtime, directory, downloadsDir, workspaceRoot };
}

test('constitution: model-authored code execution can never be packaged', () => {
    for (const primitive of ['system.eval', 'shell.execute', 'fs.write-raw']) {
        assert.ok(FORBIDDEN_PRIMITIVES.has(primitive), `${primitive} is constitution-denied`);
        assert.equal(SAFE_PRIMITIVES.has(primitive), false, `${primitive} must not be safe`);
    }
});

async function fixtureOnly(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'living-forbidden-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const runtime = new LivingRuntime({ dataPath: path.join(directory, 'state.json') });
    await runtime.initialize();
    return runtime;
}

test('constitution: a system.eval proposal fails validation and cannot reach rehearsal', async (t) => {
    const runtime = await fixtureOnly(t);
    const proposal = await runtime.proposeCapability({
        name: 'Autopoietic Kernel',
        rationale: 'Attempt to reintroduce generated-code execution.',
        steps: [{ primitive: 'world.snapshot' }, { primitive: 'system.eval' }]
    });
    const validation = await runtime.validateProposal(proposal.id);
    assert.equal(validation.validation.status, 'failed');
    assert.equal(validation.proposal.status, 'invalid');
    assert.ok(validation.validation.checks.some((check) => check.id === 'forbidden-primitives' && !check.passed));
    await assert.rejects(runtime.dryRunProposal(proposal.id), /Validated proposal not found/);
});

test('network boundary: browser origins must match the local allowlist', () => {
    assert.equal(originAllowed(undefined), true);            // curl / Electron / same-origin tools
    assert.equal(originAllowed('http://localhost:5173'), true);
    assert.equal(originAllowed('http://127.0.0.1:5174'), true);
    assert.equal(originAllowed('http://evil.example'), false);
    assert.equal(originAllowed('http://localhost:5173.evil.example'), false);
    assert.equal(originAllowed('not a url'), false);
    assert.ok(ALLOWED_ORIGINS.size >= 1);
});

test('artifact effects: file.sort never overwrites and recorded compensations actually revert', async (t) => {
    const { runtime, downloadsDir } = await fixture(t);

    // The newest download, plus an older same-named file already sorted away.
    const sourcePath = path.join(downloadsDir, 'report.txt');
    await writeFile(sourcePath, 'newly downloaded report body', 'utf8');
    const victimDir = path.join(downloadsDir, 'Sorted Documents');
    await mkdir(victimDir, { recursive: true });
    const victimPath = path.join(victimDir, 'report.txt');
    await writeFile(victimPath, 'IRREPLACEABLE earlier report', 'utf8');

    const proposal = await runtime.proposeCapability({
        name: 'Downloads Tidy',
        rationale: 'Move the newest download into its classified folder.',
        steps: [{ primitive: 'workspace.read' }, { primitive: 'file.sort' }],
        triggerKinds: ['file.sort-requested']
    });
    await runtime.validateProposal(proposal.id);

    // Rehearsal must not touch a single byte.
    const rehearsal = await runtime.dryRunProposal(proposal.id);
    assert.equal(rehearsal.rehearsal.status, 'passed');
    assert.equal(rehearsal.rehearsal.plan.userArtifactMutations.length, 0);
    assert.equal(await readFile(sourcePath, 'utf8'), 'newly downloaded report body');

    await runtime.installProposal(proposal.id);
    const installed = (await runtime.getState()).capabilities.find((item) => item.name === 'Downloads Tidy');
    assert.equal(installed.status, 'active');
    const receipt = await runtime.executeCapability(installed.id);
    assert.equal(receipt.status, 'verified');
    assert.equal(receipt.transaction.mode, 'declared-artifact-effects');
    assert.equal(receipt.reversible, true);

    // The pre-existing victim file survived; the move landed under a unique name.
    assert.equal(await readFile(victimPath, 'utf8'), 'IRREPLACEABLE earlier report');
    assert.equal(await readdir(downloadsDir).then((names) => names.includes('report.txt')), false);
    const movedName = (await readdir(victimDir)).find((name) => name !== 'report.txt');
    assert.match(movedName, /^report \(\d+\)\.txt$/);
    assert.equal(await readFile(path.join(victimDir, movedName), 'utf8'), 'newly downloaded report body');

    // Reverting applies the recorded compensations for real.
    const reverted = await runtime.applyCompensation(receipt.id);
    assert.equal(reverted.failed.length, 0);
    assert.equal(await readFile(sourcePath, 'utf8'), 'newly downloaded report body');
    assert.equal(await readFile(victimPath, 'utf8'), 'IRREPLACEABLE earlier report');
    assert.ok(reverted.receipt.compensationAppliedAt);

    await assert.rejects(runtime.applyCompensation(receipt.id), /already reverted/);
});

test('artifact effects: proposals that mutate files cannot be automatic even offline', async (t) => {
    const runtime = await fixtureOnly(t);
    const proposal = await runtime.proposeCapability({
        name: 'Silent Mover',
        rationale: 'Try to ship an automatic Downloads mover.',
        automatic: true,
        steps: [{ primitive: 'file.sort' }]
    });
    const validation = await runtime.validateProposal(proposal.id);
    assert.equal(validation.validation.status, 'failed');
    assert.ok(validation.validation.checks.some((check) => check.id === 'automatic-artifact-effects' && !check.passed));
});

test('audit: bounded-authority uses permission-set membership, not gerrymandered regexes', async (t) => {
    const runtime = await fixtureOnly(t);
    const audit = await runtime.audit();
    const authority = audit.checks.find((check) => check.id === 'bounded-authority');
    const autopoiesis = audit.checks.find((check) => check.id === 'no-autopoietic-execution');
    assert.ok(authority, 'bounded-authority check exists');
    assert.equal(authority.passed, true);
    assert.ok(autopoiesis, 'no-autopoietic-execution check exists');
    assert.equal(autopoiesis.passed, true);
});
