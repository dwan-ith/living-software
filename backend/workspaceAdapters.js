import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
    const names = await readdir(directory);
    const records = await Promise.all(names.slice(0, 300).map(async (name) => {
        try {
            const metadata = await stat(path.join(directory, name));
            if (!metadata.isFile()) return null;
            return {
                name,
                path: path.join(directory, name),
                type: classifyFile(name),
                size: metadata.size,
                modifiedAt: metadata.mtime.toISOString()
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
            const target = path.join(current, name);
            try {
                const metadata = await stat(target);
                if (metadata.isDirectory()) {
                    if (!name.startsWith('.') && !['node_modules', 'AppData', '$RECYCLE.BIN'].includes(name)) await walk(target, depth + 1);
                    return;
                }
                if (!extensions.includes(path.extname(name).toLowerCase())) return;
                records.push({
                    name,
                    path: target,
                    type: classifyFile(name),
                    size: metadata.size,
                    modifiedAt: metadata.mtime.toISOString()
                });
            } catch {}
        }));
    }

    await walk(directory);
    return records.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
}

export async function recentSlides() {
    const roots = [path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop')];
    const lists = await Promise.all(roots.map((root) => recentFilesFrom(root, ['.pptx', '.ppt'], 10)));
    return lists.flat().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 18);
}

export async function recentNotes() {
    const roots = [path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Desktop')];
    const lists = await Promise.all(roots.map((root) => recentFilesFrom(root, ['.md', '.txt', '.rtf'], 10)));
    const notes = lists.flat().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 18);
    return Promise.all(notes.map(async (note) => {
        try {
            const text = await readFile(note.path, 'utf8');
            return { ...note, preview: text.replace(/\s+/g, ' ').slice(0, 220) };
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

export async function dependencySnapshot(root = process.cwd()) {
    const candidates = await recentFilesFrom(root, ['.js', '.ts', '.tsx', '.py', '.ipynb', '.md', '.json'], 80);
    const names = candidates.map((item) => item.name);
    const risky = candidates.slice(0, 24).map((file) => {
        const base = path.basename(file.name, path.extname(file.name));
        const references = names.filter((name) => name !== file.name && name.toLowerCase().includes(base.toLowerCase().slice(0, 8))).length;
        const signals = [];
        if (['server', 'app', 'main', 'index', 'train', 'model'].some((part) => base.toLowerCase().includes(part))) signals.push('entrypoint-like name');
        if (references) signals.push(`${references} nearby name match${references === 1 ? '' : 'es'}`);
        if (file.size > 50_000) signals.push('large source artifact');
        return {
            ...file,
            references,
            risk: signals.length > 1 ? 'high' : signals.length ? 'medium' : 'low',
            signals
        };
    });

    return {
        root,
        scanned: candidates.length,
        files: risky.sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.risk] - { high: 3, medium: 2, low: 1 }[a.risk]))
    };
}

export async function systemMap() {
    const [downloads, slides, notes, gallery, dependencies] = await Promise.all([
        recentDownloads(12),
        recentSlides(),
        recentNotes(),
        recentGallery(),
        dependencySnapshot()
    ]);

    return {
        generatedAt: new Date().toISOString(),
        surfaces: [
            { id: 'screen', label: 'Screen', authority: 'continuous screenshot perception', count: 1, status: 'live' },
            { id: 'files', label: 'Files', authority: 'metadata scan of Downloads and workspace', count: downloads.length + dependencies.scanned, status: 'read-only' },
            { id: 'clipboard', label: 'Clipboard', authority: 'explicit user-triggered read', count: 1, status: 'consent-gated' },
            { id: 'notifications', label: 'Notifications', authority: 'local inbox and app adapters', count: 3, status: 'demo-inbox' },
            { id: 'slides', label: 'Slides', authority: 'PowerPoint file watcher', count: slides.length, status: 'metadata-ready' },
            { id: 'notes', label: 'Notes', authority: 'text note semantic linker', count: notes.length, status: 'preview-ready' },
            { id: 'gallery', label: 'Gallery', authority: 'Pictures and screenshot watcher', count: gallery.length, status: 'metadata-ready' },
            { id: 'downloads', label: 'Downloads', authority: 'intent sorting queue', count: downloads.length, status: 'metadata-ready' },
            { id: 'dependencies', label: 'Dependency Graph', authority: 'workspace reference risk scan', count: dependencies.scanned, status: 'heuristic' }
        ]
    };
}

export async function readClipboard() {
    const { stdout } = await execFileAsync('powershell.exe', [
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
