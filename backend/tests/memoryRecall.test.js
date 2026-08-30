// LIVING_DATA_DIR must be set before the memoryStore module captures DATA_DIR,
// so each test imports a fresh module instance scoped to its own directory.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

let moduleScope = 0;

async function withMemoryStore(t, directory) {
    process.env.LIVING_DATA_DIR = directory;
    const module = await import(`../memoryStore.js?scope=${++moduleScope}`);
    t.after(() => { delete process.env.LIVING_DATA_DIR; });
    return module;
}

test('retrieval: exact-token relevance outranks substring coincidence', async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'living-memory-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { rememberFact, recallMemory } = await withMemoryStore(t, directory);

    await rememberFact({ title: 'Thesis', text: 'Living software maintains identity and grows capabilities.', source: 'test' });
    // Contains "the" inside "theory" only via substring — the old scorer matched it.
    await rememberFact({ title: 'Reading list', text: 'Theoretical physics papers on renormalization.', source: 'test' });

    const matches = await recallMemory('identity capabilities', 5);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].title, 'Thesis', 'exact token overlap must win');
});

test('retrieval: empty query falls back to recency and importance ordering', async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'living-memory-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { rememberEpisode, recallMemory } = await withMemoryStore(t, directory);

    // Equal importance: recency must decide between the two episodes.
    await rememberEpisode({ title: 'Older peer', summary: 'earlier event', importance: 0.6 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rememberEpisode({ title: 'Newer peer', summary: 'latest event', importance: 0.6 });

    const matches = await recallMemory('', 5);
    const peers = matches.filter((item) => item.summary === 'earlier event' || item.summary === 'latest event');
    assert.equal(peers.length, 2);
    assert.equal(peers[0].title, 'Newer peer', 'recency breaks importance ties');
});
