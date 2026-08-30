import { execFile } from 'node:child_process';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { POWERSHELL_EXE, PROJECT_ROOT_DIR } from './config.js';

const execFileAsync = promisify(execFile);

/** Safely read the first maxBytes of a text file. Returns empty string on failure. */
export async function readFileContent(filePath, maxBytes = 8192) {
    let handle;
    try {
        const ext = path.extname(filePath).toLowerCase();
        // Skip binary formats
        if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mov', '.zip', '.7z', '.rar', '.tar', '.gz', '.exe', '.dll', '.pptx', '.docx', '.xlsx', '.pdf'].includes(ext)) return '';
        const boundedBytes = Math.max(1, Math.min(Number(maxBytes) || 8192, 256 * 1024));
        handle = await open(filePath, 'r');
        const buffer = Buffer.allocUnsafe(boundedBytes);
        const { bytesRead } = await handle.read(buffer, 0, boundedBytes, 0);
        const slice = buffer.subarray(0, bytesRead);
        // Unknown binary formats would otherwise enter prompts as mojibake:
        // a NUL byte in the prefix is a reliable binary signature.
        if (slice.includes(0)) return '';
        return slice.toString('utf8');
    } catch {
        return '';
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/** Extract text content from a PPTX file by reading slide XML entries. */
async function extractPptxText(filePath, maxBytes = 8192) {
    try {
        // PPTX is a ZIP file. Use PowerShell to extract slide text.
    const { stdout } = await execFileAsync(POWERSHELL_EXE, [
        '-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `$zip = [System.IO.Compression.ZipFile]::OpenRead('${filePath.replace(/'/g, "''")}'); ` +
        `$slides = $zip.Entries | Where-Object { $_.FullName -match 'ppt/slides/slide\\d+\\.xml' } | Sort-Object FullName; ` +
        `foreach ($s in $slides) { ` +
        `  $reader = New-Object System.IO.StreamReader($s.Open()); ` +
        `  $xml = $reader.ReadToEnd(); $reader.Close(); ` +
        `  $slideTextMatches = [regex]::Matches($xml, '<a:t>([^<]+)</a:t>'); ` +
        `  foreach ($m in $slideTextMatches) { Write-Output $m.Groups[1].Value } ` +
        `  Write-Output '---' ` +
        `} ` +
        `$zip.Dispose()`
    ], { windowsHide: true, timeout: 10000, maxBuffer: 512 * 1024 });
        return stdout.trim().slice(0, maxBytes);
    } catch {
        return '';
    }
}

const SKIP_DIRS = new Set([
    'node_modules', 'dist', '.git', 'data', 'AppData', '$RECYCLE.BIN',
    '.venv', 'venv', '__pycache__', '.next', 'coverage', 'build'
]);

function classifyFile(name) {
    const extension = path.extname(name).toLowerCase();
    if (['.ppt', '.pptx', '.doc', '.docx', '.pdf', '.md', '.txt'].includes(extension)) return 'Document';
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mov'].includes(extension)) return 'Media';
    if (['.py', '.js', '.ts', '.tsx', '.ipynb', '.json', '.csv'].includes(extension)) return 'Project';
    if (['.zip', '.7z', '.rar', '.tar', '.gz'].includes(extension)) return 'Archive';
    return 'Other';
}

export async function recentDownloads(limit = 24) {
    const directory = path.join(os.homedir(), 'Downloads');
    let names = [];
    try {
        names = await readdir(directory);
    } catch (error) {
        throw new Error(`Cannot read Downloads: ${error.message}`);
    }

    const records = await Promise.all(names.slice(0, 300).map(async (name) => {
        try {
            const metadata = await stat(path.join(directory, name));
            if (!metadata.isFile()) return null;
            const filePath = path.join(directory, name);
            const content = await readFileContent(filePath);
            return {
                name,
                path: filePath,
                type: classifyFile(name),
                size: metadata.size,
                modifiedAt: metadata.mtime.toISOString(),
                content: content || undefined
            };
        } catch {
            return null;
        }
    }));

    return records.filter(Boolean).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
}

async function recentFilesFrom(directory, extensions, limit = 16) {
    const records = [];
    async function walk(current, depth = 0) {
        if (depth > 2 || records.length > 600) return;
        let names = [];
        try {
            names = await readdir(current);
        } catch {
            return;
        }

        await Promise.all(names.slice(0, 180).map(async (name) => {
            if (SKIP_DIRS.has(name) || name.startsWith('.')) return;
            const target = path.join(current, name);
            try {
                const metadata = await stat(target);
                if (metadata.isDirectory()) {
                    await walk(target, depth + 1);
                    return;
                }
                if (!extensions.includes(path.extname(name).toLowerCase())) return;
                const content = await readFileContent(target);
                records.push({
                    name,
                    path: target,
                    type: classifyFile(name),
                    size: metadata.size,
                    modifiedAt: metadata.mtime.toISOString(),
                    content: content || undefined
                });
            } catch { }
        }));
    }

    await walk(directory);
    return records.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
}

export async function recentSlides() {
    const roots = [path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop')];
    const lists = await Promise.all(roots.map((root) => recentFilesFrom(root, ['.pptx', '.ppt'], 10)));
    const slides = lists.flat().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 18);
    // Extract text content from PPTX files
    return Promise.all(slides.map(async (slide) => {
        if (slide.name.endsWith('.pptx')) {
            const text = await extractPptxText(slide.path);
            return { ...slide, content: text || undefined, preview: text ? text.replace(/---/g, ' | ').replace(/\s+/g, ' ').slice(0, 220) : undefined };
        }
        return slide;
    }));
}

export async function recentNotes() {
    const roots = [path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Desktop')];
    const lists = await Promise.all(roots.map((root) => recentFilesFrom(root, ['.md', '.txt', '.rtf'], 10)));
    const notes = lists.flat().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 18);
    return Promise.all(notes.map(async (note) => {
        try {
            const text = await readFile(note.path, 'utf8');
            return { ...note, preview: text.replace(/\s+/g, ' ').slice(0, 220), content: text.slice(0, 8192) };
        } catch {
            return { ...note, preview: 'Preview unavailable.' };
        }
    }));
}

export async function recentGallery() {
    const roots = [
        path.join(os.homedir(), 'Pictures'),
        path.join(os.homedir(), 'Pictures', 'Screenshots'),
        path.join(os.homedir(), 'Downloads')
    ];
    const lists = await Promise.all(roots.map((root) => recentFilesFrom(root, ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov'], 12)));
    return lists.flat().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 24);
}

function extractImportHints(sourceText) {
    const hints = new Set();
    const patterns = [
        /from\s+['"]([^'"]+)['"]/g,
        /import\s+['"]([^'"]+)['"]/g,
        /require\(\s*['"]([^'"]+)['"]\s*\)/g,
        /(?:include|import)\s+['"]([^'"]+)['"]/g
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(sourceText)) !== null) {
            const raw = match[1];
            if (!raw || raw.startsWith('http') || raw.startsWith('node:')) continue;
            const base = path.basename(raw).replace(/\.(js|ts|tsx|jsx|mjs|cjs|py)$/i, '');
            if (base) hints.add(base.toLowerCase());
            hints.add(raw.toLowerCase());
        }
    }
    return [...hints];
}

export async function dependencySnapshot(root = PROJECT_ROOT_DIR) {
    const candidates = await recentFilesFrom(root, ['.js', '.ts', '.tsx', '.jsx', '.py', '.ipynb', '.md', '.json'], 100);
    const sourceCandidates = candidates.filter((file) => {
        const ext = path.extname(file.name).toLowerCase();
        return ['.js', '.ts', '.tsx', '.jsx', '.py', '.ipynb'].includes(ext);
    });

    const importIndex = new Map(); // basenames referenced by other files
    await Promise.all(sourceCandidates.slice(0, 60).map(async (file) => {
        try {
            const sample = await readFileContent(file.path, 80_000);
            for (const hint of extractImportHints(sample)) {
                if (!importIndex.has(hint)) importIndex.set(hint, []);
                importIndex.get(hint).push(file.name);
            }
        } catch { }
    }));

    const risky = sourceCandidates.slice(0, 40).map((file) => {
        const base = path.basename(file.name, path.extname(file.name));
        const baseLower = base.toLowerCase();
        const importers = new Set([
            ...(importIndex.get(baseLower) || []),
            ...(importIndex.get(file.name.toLowerCase()) || [])
        ]);
        importers.delete(file.name);

        // Fallback name-similarity only for short, distinctive stems.
        let nameMatches = 0;
        if (baseLower.length >= 4) {
            nameMatches = candidates.filter((other) => {
                if (other.name === file.name) return false;
                const otherBase = path.basename(other.name, path.extname(other.name)).toLowerCase();
                return otherBase.includes(baseLower) || baseLower.includes(otherBase.slice(0, Math.min(8, otherBase.length)));
            }).length;
        }

        const references = importers.size || nameMatches;
        const signals = [];
        if (['server', 'app', 'main', 'index', 'train', 'model'].some((part) => baseLower.includes(part))) {
            signals.push('entrypoint-like name');
        }
        if (importers.size) signals.push(`${importers.size} import reference${importers.size === 1 ? '' : 's'}`);
        else if (nameMatches) signals.push(`${nameMatches} nearby name match${nameMatches === 1 ? '' : 'es'}`);
        if (file.size > 50_000) signals.push('large source artifact');

        return {
            ...file,
            references,
            importers: [...importers].slice(0, 8),
            risk: signals.length > 1 || importers.size >= 2 ? 'high' : signals.length ? 'medium' : 'low',
            signals
        };
    });

    return {
        root,
        scanned: candidates.length,
        files: risky.sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.risk] - { high: 3, medium: 2, low: 1 }[a.risk]))
    };
}

export async function systemMap(options = {}) {
    const projectRoot = options.projectRoot || PROJECT_ROOT_DIR;
    const notificationCount = Number(options.notificationCount) || 0;
    const memoryStats = options.memoryStats || { facts: 0, episodes: 0, associations: 0 };

    const [downloads, slides, notes, gallery, dependencies] = await Promise.all([
        recentDownloads(12),
        recentSlides(),
        recentNotes(),
        recentGallery(),
        dependencySnapshot(projectRoot)
    ]);

    const memoryCount = (memoryStats.facts || 0) + (memoryStats.episodes || 0) + (memoryStats.associations || 0);

    return {
        generatedAt: new Date().toISOString(),
        dependencies,
        surfaces: [
            { id: 'screen', label: 'Screen', authority: 'continuous screenshot perception', count: 1, status: 'live' },
            { id: 'files', label: 'Files', authority: 'metadata scan of Downloads and workspace', count: downloads.length + dependencies.scanned, status: 'read-only' },
            { id: 'clipboard', label: 'Clipboard', authority: 'explicit user-triggered read', count: 1, status: 'consent-gated' },
            { id: 'notifications', label: 'Notifications', authority: 'local inbox', count: notificationCount, status: notificationCount ? 'live-inbox' : 'empty' },
            { id: 'slides', label: 'Slides', authority: 'PowerPoint file watcher', count: slides.length, status: 'metadata-ready' },
            { id: 'notes', label: 'Notes', authority: 'text note semantic linker', count: notes.length, status: 'preview-ready' },
            { id: 'gallery', label: 'Gallery', authority: 'Pictures and screenshot watcher', count: gallery.length, status: 'metadata-ready' },
            { id: 'downloads', label: 'Downloads', authority: 'intent sorting queue', count: downloads.length, status: 'metadata-ready' },
            { id: 'dependencies', label: 'Dependency Graph', authority: 'workspace reference risk scan', count: dependencies.scanned, status: 'heuristic' },
            { id: 'memory', label: 'Memory', authority: 'persistent facts, episodes, and cross-surface associations', count: memoryCount, status: 'persistent' }
        ]
    };
}

export async function readClipboard() {
    const { stdout } = await execFileAsync(POWERSHELL_EXE, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Clipboard -Raw -Format Text -ErrorAction SilentlyContinue'
    ], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });

    const text = stdout.trim().slice(0, 8000);
    return {
        text,
        length: text.length,
        kind: /10\.\d{4,9}\//.test(text) ? 'DOI' : /https?:\/\//.test(text) ? 'URL' : /\n/.test(text) ? 'Rich text' : 'Text'
    };
}
