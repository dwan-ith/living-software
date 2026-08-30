import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SAVE_RETRIES = 3;
const RETRY_DELAY_MS = 120;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Atomic JSON-state write. Windows rename-over-existing can fail transiently
 * with EPERM/EBUSY while an antivirus or indexer holds the target, so the
 * replace is retried a few times before giving up.
 */
export async function atomicWriteFile(targetPath, contents) {
    const temporary = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    let lastError = null;
    for (let attempt = 0; attempt <= SAVE_RETRIES; attempt += 1) {
        try {
            await writeFile(temporary, contents, 'utf8');
            await rename(temporary, targetPath);
            return;
        } catch (error) {
            lastError = error;
            const code = error?.code || '';
            if (!['EPERM', 'EACCES', 'EBUSY', 'ENOENT'].includes(code)) throw error;
            await delay(RETRY_DELAY_MS * (attempt + 1));
        }
    }
    throw lastError;
}

/**
 * Load a persisted JSON state file without silent amnesia. A file that exists
 * but cannot be parsed is QUARANTINED beside itself so history is never
 * destroyed by the next save; the caller seeds fresh state and can record an
 * incident.
 */
export async function loadJsonWithQuarantine(dataPath) {
    let raw;
    try {
        raw = await readFile(dataPath, 'utf8');
    } catch {
        // Genuinely missing: first boot, not corruption.
        return { data: null, quarantinedTo: null };
    }
    try {
        return { data: JSON.parse(raw), quarantinedTo: null };
    } catch {
        const quarantine = `${dataPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await mkdir(path.dirname(dataPath), { recursive: true });
        await copyFile(dataPath, quarantine);
        return { data: null, quarantinedTo: quarantine };
    }
}
