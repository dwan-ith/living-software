import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readFileContent } from '../workspaceAdapters.js';

test('workspace text reads are prefix-bounded instead of loading whole artifacts', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'living-workspace-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'large-source.ts');
    await writeFile(filePath, `prefix:${'x'.repeat(1024 * 1024)}`, 'utf8');

    const content = await readFileContent(filePath, 32);

    assert.equal(Buffer.byteLength(content), 32);
    assert.match(content, /^prefix:/);
});
