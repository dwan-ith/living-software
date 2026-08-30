import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const BACKEND_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/tests$/, '');
const PORT = 37000 + (process.pid % 2000);
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForHealth(deadlineMs = 25_000) {
    const deadline = Date.now() + deadlineMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${BASE}/api/living/health`);
            if (response.ok) return response.json();
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Server did not become healthy: ${lastError?.message || 'timeout'}`);
}

test('live API: network boundary, consent gate, surface actions, idempotency', async (t) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'living-api-'));
    const child = spawn(process.execPath, ['server.js'], {
        cwd: BACKEND_DIR,
        env: {
            ...process.env,
            PORT: String(PORT),
            BIND_HOST: '127.0.0.1',
            LIVING_DATA_DIR: dataDir,
            LIVING_AUTOSTART: 'false',
            OBSERVER_INTERVAL_MS: '600000'
        },
        stdio: 'ignore'
    });
    t.after(() => {
        child.kill();
        return rm(dataDir, { recursive: true, force: true });
    });

    const health = await waitForHealth();
    assert.equal(health.audit.status, 'passed', 'fresh runtime boots with a clean audit');

    // 1. Browser-origin enforcement: a foreign Origin is refused outright...
    const evil = await fetch(`${BASE}/api/living/state`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);

    // ...while a local tool (no Origin header) gets through.
    const local = await fetch(`${BASE}/api/living/state`);
    assert.equal(local.status, 200);

    // 2. Clipboard reads require explicit consent even from allowed callers.
    const unconfirmedClipboard = await fetch(`${BASE}/api/workspace/clipboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    assert.equal(unconfirmedClipboard.status, 428);

    // 3. Surface lifecycle: compose, reject a stale action, run a declared one.
    const composed = await fetch(`${BASE}/api/surfaces/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'integration-habitat', utterance: 'show me runtime rigor', reason: 'integration-test' })
    });
    assert.equal(composed.status, 200);
    const { surface } = await composed.json();
    assert.equal(surface.protocol, 'living-surface/v1');
    const brief = surface.components.find((component) => component.type === 'intent-brief');
    assert.ok(brief, 'adaptive policy composes a lead intent component');

    const stale = await fetch(`${BASE}/api/surfaces/integration-habitat/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surfaceId: surface.id, revision: surface.revision + 5, componentId: brief.id, action: 'living.cycle' })
    });
    assert.equal(stale.status, 400);
    assert.match((await stale.json()).error, /stale/i);

    const actionBody = {
        surfaceId: surface.id,
        revision: surface.revision,
        componentId: brief.id,
        action: brief.actions.includes('living.cycle') ? 'living.cycle' : brief.actions[0]
    };
    const executed = await fetch(`${BASE}/api/surfaces/integration-habitat/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(actionBody)
    });
    assert.equal(executed.status, 200, 'declared action against current revision executes');

    // 4. Idempotency: the exact same request is a replay, not a second execution.
    const replay = await fetch(`${BASE}/api/surfaces/integration-habitat/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(actionBody)
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /already ran/, 'double-click cannot execute twice');

    // 5. Audit stays clean after the whole interaction.
    const auditAfter = await (await fetch(`${BASE}/api/living/audit`)).json();
    assert.equal(auditAfter.status, 'passed');
});
