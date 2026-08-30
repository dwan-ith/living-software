import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withTimeout } from '../config.js';
import { LivingRuntime } from '../livingRuntime.js';

async function fixture(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'living-evidence-'));
    const downloadsDir = path.join(directory, 'Downloads');
    await mkdir(downloadsDir, { recursive: true });
    t.after(() => rm(directory, { recursive: true, force: true }));
    return { directory, downloadsDir };
}

function makeRuntime(directory, extra = {}) {
    return new LivingRuntime({
        dataPath: path.join(directory, 'state.json'),
        downloadsDir: path.join(directory, 'Downloads'),
        ...extra
    });
}

test('integrity: a corrupt state file is quarantined, never silently destroyed', async (t) => {
    const { directory } = await fixture(t);
    const dataPath = path.join(directory, 'state.json');
    await writeFile(dataPath, '{ this is not json !!!', 'utf8');

    const runtime = makeRuntime(directory);
    await runtime.initialize();
    const state = await runtime.getState();

    assert.equal(state.identity.bootCount, 1, 'fresh seed after quarantine');
    assert.ok(state.events.some((event) => event.kind === 'runtime.state-quarantined'), 'incident recorded as evidence');
    const quarantined = state.events.find((event) => event.kind === 'runtime.state-quarantined');
    const preserved = await readFile(quarantined.data.quarantinedTo, 'utf8');
    assert.match(preserved, /not json/, 'corrupt original preserved beside itself');
});

test('integrity: receipts form a verifiable hash chain and tampering is detected', async (t) => {
    const { directory } = await fixture(t);
    const runtime = makeRuntime(directory);
    await runtime.initialize();

    await runtime.recordEvent({ kind: 'user.intent', source: 'test', summary: 'chain seed' });
    await runtime.executeCapability('continuity.snapshot');
    await runtime.executeCapability('context.reflect');

    const auditBefore = await runtime.audit();
    const ledgerCheck = auditBefore.checks.find((check) => check.id === 'receipt-ledger-integrity');
    assert.equal(ledgerCheck.passed, true);

    // Tamper with a mid-chain receipt: the successor's stored link must expose it.
    const victim = runtime.state.receipts[1];
    victim.outputs.push({ primitive: 'forged.step', output: { hacked: true } });

    const auditAfter = await runtime.audit();
    const broken = auditAfter.checks.find((check) => check.id === 'receipt-ledger-integrity');
    assert.equal(broken.passed, false, 'edited history must be detectable');
});

test('crash recovery: unresolved effect-journal intents are compensated on boot', async (t) => {
    const { directory, downloadsDir } = await fixture(t);
    const sourcePath = path.join(downloadsDir, 'invoice.pdf');
    await writeFile(sourcePath, 'important invoice bytes', 'utf8');
    const destPath = path.join(downloadsDir, 'Sorted Documents', 'invoice.pdf');

    // Simulate a crash AFTER a journaled move executed but BEFORE it resolved:
    // the mutation physically happened, the journal still says pending.
    await mkdir(path.dirname(destPath), { recursive: true });
    await rename(sourcePath, destPath);
    const dataPath = path.join(directory, 'state.json');
    const runtimeA = makeRuntime(directory);
    await runtimeA.initialize();
    await appendFile(runtimeA.effectJournalPath, `${JSON.stringify({
        id: 'intent-crash-1',
        state: 'pending',
        mutation: { action: 'move', from: sourcePath, to: destPath, compensation: { action: 'move', from: destPath, to: sourcePath } },
        at: new Date().toISOString()
    })}\n`, 'utf8');

    // Next boot reconciles the dangling intent through its recorded compensation.
    const runtimeB = makeRuntime(directory);
    await runtimeB.initialize();
    assert.equal(await readFile(sourcePath, 'utf8'), 'important invoice bytes', 'moved file restored');
    const remaining = await readdir(path.join(downloadsDir, 'Sorted Documents'));
    assert.equal(remaining.length, 0, 'destination no longer holds the moved file');

    const state = await runtimeB.getState();
    const incident = state.events.find((event) => event.kind === 'work.journal-reconciled');
    assert.ok(incident, 'recovery recorded as evidence');
    assert.equal(incident.data.outcome, 'resolved-compensated');
});

test('governance: execution-time authority gate refuses drifted packages', async (t) => {
    const { directory } = await fixture(t);
    const runtime = makeRuntime(directory);
    await runtime.initialize();

    const proposal = await runtime.proposeCapability({
        name: 'Legitimate Snapshotter',
        rationale: 'Starts constitutional, drifts later.',
        steps: [{ primitive: 'world.snapshot' }]
    });
    await runtime.validateProposal(proposal.id);
    await runtime.dryRunProposal(proposal.id);
    const installed = await runtime.installProposal(proposal.id);
    assert.equal(installed.capability.status, 'active');

    // Simulate constitution drift: someone hands the installed package a power
    // the runtime never grants. Install-time validation happened already, so
    // only the execution-time gate can catch this.
    const target = runtime.state.capabilities.find((item) => item.id === installed.capability.id);
    target.permissions = ['write:filesystem'];

    const receipt = await runtime.executeCapability(installed.capability.id);
    assert.equal(receipt.status, 'refused-authority');
    assert.equal(receipt.authority, 'refused');
    assert.equal(receipt.outputs.length, 0, 'no primitive ran under refused authority');
    assert.match(receipt.evidence.join(' '), /non-constitutional permissions/);
});

test('triggers: manifest threshold and cooldownMs are enforced, not decorative', async (t) => {
    const { directory } = await fixture(t);
    const runtime = makeRuntime(directory);
    await runtime.initialize();
    await runtime.observeWorld({ surfaces: [{ id: 'screen', label: 'Screen', count: 1, status: 'live' }] });

    const proposal = await runtime.proposeCapability({
        name: 'Intent Triplet Watch',
        rationale: 'Only fires after three intents and cools down afterwards.',
        automatic: true,
        triggerKinds: ['user.intent'],
        threshold: 3,
        cooldownMs: 60_000,
        steps: [{ primitive: 'world.snapshot' }]
    });
    await runtime.validateProposal(proposal.id);
    await runtime.dryRunProposal(proposal.id);
    const installed = await runtime.installProposal(proposal.id);

    // One match is below threshold: another capability answers instead.
    await runtime.recordEvent({ kind: 'user.intent', source: 'test', summary: 'first intent' });
    const early = await runtime.runCycle({ reason: 'threshold-test' });
    assert.notEqual(early.receipt?.capabilityId, installed.capability.id, 'sub-threshold trigger must not fire');

    // Reaching threshold selects the probe over the built-ins.
    await runtime.recordEvent({ kind: 'user.intent', source: 'test', summary: 'second intent' });
    await runtime.recordEvent({ kind: 'user.intent', source: 'test', summary: 'third intent' });
    const fired = await runtime.runCycle({ reason: 'threshold-test' });
    assert.equal(fired.receipt?.capabilityId, installed.capability.id, 'threshold reached: capability fires');

    // Inside the cooldown window the same capability cannot immediately refire.
    await runtime.recordEvent({ kind: 'user.intent', source: 'test', summary: 'fourth intent' });
    const cooled = await runtime.runCycle({ reason: 'cooldown-test' });
    assert.notEqual(cooled.receipt?.capabilityId ?? null, installed.capability.id, 'cooldown blocks immediate refire');
});

test('metabolic limits: hung provider calls are cut off, fast ones pass through', async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 30, 'hung-provider'), /timed out after 30ms/);
    assert.equal(await withTimeout(Promise.resolve(7), 1000, 'fast-provider'), 7);
});

test('concurrency: the inference phase does not block event ingestion', async (t) => {
    const { directory } = await fixture(t);
    const runtime = makeRuntime(directory);
    await runtime.initialize();
    await runtime.observeWorld({ surfaces: [{ id: 'screen', label: 'Screen', count: 1, status: 'live' }] });

    // Simulate a slow provider inside phase A (off-queue planning).
    const originalPlan = runtime._planCapability.bind(runtime);
    runtime._planCapability = async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return originalPlan(...args);
    };

    let executionSettled = false;
    const execution = runtime.executeCapability('continuity.snapshot')
        .then((receipt) => { executionSettled = true; return receipt; });

    await new Promise((resolve) => setTimeout(resolve, 60)); // let phase A enter the "inference"
    const t0 = Date.now();
    await runtime.recordEvent({ kind: 'user.intent', source: 'test', summary: 'ingested during simulated inference' });
    const ingestMs = Date.now() - t0;

    assert.equal(executionSettled, false, 'execution is still in its slow phase');
    assert.ok(ingestMs < 200, `event ingestion must not queue behind inference (took ${ingestMs}ms)`);
    const receipt = await execution;
    assert.ok(receipt.status === 'verified' || receipt.status === 'failed-verification');
    runtime._planCapability = originalPlan;
});

test('predictive evolution: dream cycles act on below-threshold coverage gaps', async (t) => {
    const { directory } = await fixture(t);
    const runtime = makeRuntime(directory);
    await runtime.initialize();

    for (let index = 0; index < 3; index += 1) {
        await runtime.recordEvent({
            kind: 'perception.opportunity',
            source: 'test',
            summary: `Quiet-period opportunity ${index + 1}`,
            importance: 0.6,
            data: { index, confidence: 0.8 }
        });
    }

    // Reactive threshold is 4: a scheduled cycle must NOT propose from three.
    const scheduled = await runtime.runCycle({ reason: 'scheduled' });
    assert.equal(scheduled.proposal, null);

    // A dream cycle treats quiet time as the moment for anticipatory coverage.
    const dream = await runtime.runCycle({ reason: 'idle-dream' });
    assert.ok(dream.proposal, 'speculative proposal formed during the dream phase');
    assert.equal(dream.proposal.synthesis.source, 'speculative-simulation');
    assert.match(dream.proposal.rationale, /anticipatory coverage/);

    // And it still cannot skip governance: it needs validation and rehearsal.
    await assert.rejects(runtime.installProposal(dream.proposal.id), /validation and dry-run/);
});

test('governance semantics: refusals are policy outcomes, not verification failures', async (t) => {
    const { directory } = await fixture(t);
    const runtime = makeRuntime(directory);
    await runtime.initialize();

    await runtime.recordEvent({ kind: 'user.intent', source: 'test', summary: 'seed' });
    const goodReceipt = await runtime.executeCapability('continuity.snapshot');
    assert.equal(goodReceipt.status, 'verified');
    const healthyBefore = (await runtime.health()).status;

    // A drifted package is refused: governance worked exactly as designed.
    const target = runtime.state.capabilities.find((item) => item.id === 'context.reflect');
    target.permissions = ['write:filesystem'];
    const refused = await runtime.executeCapability('context.reflect');
    assert.equal(refused.status, 'refused-authority');

    const health = await runtime.health();
    assert.equal(health.status, healthyBefore, 'a refusal must not degrade health');
    assert.equal(health.refusedReceipts, 1);

    const state = await runtime.getState();
    assert.equal(state.stats.refusedReceipts, 1);
    assert.equal(state.stats.verificationRate, 100, 'verification rate ignores refusals');

    const audit = await runtime.audit();
    assert.equal(audit.checks.find((check) => check.id === 'verification').passed, true);
});

test('ledger anchor: wholesale deletion of receipts is detectable', async (t) => {
    const { directory } = await fixture(t);
    const runtime = makeRuntime(directory);
    await runtime.initialize();
    await runtime.executeCapability('continuity.snapshot');

    const cleanAudit = await runtime.audit();
    assert.equal(cleanAudit.checks.find((check) => check.id === 'ledger-anchor').passed, true);

    // Simulate an attacker (or a bug) wiping the ledger: the in-state chain is
    // vacuously intact on an empty array, but the durable anchor disagrees.
    runtime.state.receipts.length = 0;
    const tamperedAudit = await runtime.audit();
    const anchor = tamperedAudit.checks.find((check) => check.id === 'ledger-anchor');
    assert.equal(anchor.passed, false, 'erased history must be flagged');
    assert.match(anchor.evidence, /live ledger is empty/);

    // Tampering with the newest receipt's content is also caught by the anchor.
    await runtime.executeCapability('continuity.snapshot');
    runtime.state.receipts[0].outputs.push({ primitive: 'forged', output: {} });
    const forgedAudit = await runtime.audit();
    assert.equal(forgedAudit.checks.find((check) => check.id === 'ledger-anchor').passed, false);
});

test('archive hygiene: append-only journals rotate at a bounded size', async (t) => {
    const { directory } = await fixture(t);
    const dataPath = path.join(directory, 'state.json');
    const runtime = new LivingRuntime({ dataPath, downloadsDir: path.join(directory, 'Downloads'), archiveRotateBytes: 512 });
    await runtime.initialize();

    const bigChunk = `${'x'.repeat(400)}\n`;
    runtime._scheduleArchiveAppend('receipts-archive.jsonl', bigChunk);
    runtime._scheduleArchiveAppend('receipts-archive.jsonl', bigChunk);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const names = await readdir(directory);
    const rotated = names.filter((name) => name.startsWith('receipts-archive.jsonl.') && name.endsWith('.rotated'));
    assert.equal(rotated.length, 1, 'oversized archive rotates instead of growing forever');
    const active = await readFile(path.join(directory, 'receipts-archive.jsonl'), 'utf8');
    assert.ok(active.length <= 1024);
});
