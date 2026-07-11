import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const memoryDir = DATA_DIR;
const memoryPath = path.join(memoryDir, 'memory.json');

const seedMemory = {
    facts: [
        {
            id: 'fact-living-software-thesis',
            title: 'Living Software thesis',
            text: 'Software should understand why objects exist, what depends on them, and when user actions create semantic inconsistency.',
            tags: ['living-software', 'thesis', 'hackathon'],
            confidence: 0.92,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            source: 'system-seed'
        },
        {
            id: 'fact-user-demo-priority',
            title: 'Demo must show pushback',
            text: 'The strongest demo is not a pretty graph; it is the computer noticing a risky or inconsistent action and offering a reversible fix.',
            tags: ['demo', 'pushback', 'product'],
            confidence: 0.9,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            source: 'system-seed'
        }
    ],
    episodes: [
        {
            id: 'episode-agent-workbench',
            title: 'Agent workbench expanded',
            summary: 'The workspace added screen, system, slides, notes, gallery, files, downloads, graph, clipboard, and notifications agents.',
            surfaces: ['screen', 'system', 'slides', 'notes', 'gallery', 'files', 'downloads', 'dependencies', 'clipboard', 'notifications'],
            createdAt: new Date().toISOString(),
            importance: 0.82,
            source: 'system-seed'
        }
    ],
    associations: [
        {
            id: 'assoc-notes-slides',
            from: 'notes',
            to: 'slides',
            relation: 'Notes can define concepts that slides later violate or fail to explain.',
            strength: 0.76,
            createdAt: new Date().toISOString()
        },
        {
            id: 'assoc-files-dependencies',
            from: 'files',
            to: 'dependencies',
            relation: 'A file deletion must be evaluated against imports, notebooks, reports, and project memory.',
            strength: 0.86,
            createdAt: new Date().toISOString()
        }
    ]
};

function tokenize(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s.-]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length > 2);
}

function scoreMemory(item, queryTokens) {
    const text = [item.title, item.text, item.summary, item.source, ...(item.tags || []), ...(item.surfaces || [])].join(' ');
    const tokens = tokenize(text);
    const matches = queryTokens.filter((token) => tokens.some((candidate) => candidate.includes(token) || token.includes(candidate)));
    return matches.length / Math.max(queryTokens.length, 1);
}

async function ensureMemory() {
    await mkdir(memoryDir, { recursive: true });
    try {
        const parsed = JSON.parse(await readFile(memoryPath, 'utf8'));
        return {
            facts: Array.isArray(parsed.facts) ? parsed.facts : [],
            episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
            associations: Array.isArray(parsed.associations) ? parsed.associations : []
        };
    } catch {
        await writeFile(memoryPath, `${JSON.stringify(seedMemory, null, 2)}\n`, 'utf8');
        return structuredClone(seedMemory);
    }
}

async function saveMemory(memory) {
    await mkdir(memoryDir, { recursive: true });
    await writeFile(memoryPath, `${JSON.stringify(memory, null, 2)}\n`, 'utf8');
    return memory;
}

export async function readMemory() {
    const memory = await ensureMemory();
    return {
        ...memory,
        stats: {
            facts: memory.facts.length,
            episodes: memory.episodes.length,
            associations: memory.associations.length,
            path: memoryPath
        }
    };
}

export async function rememberFact({ title, text, tags = [], source = 'user', confidence = 0.75 }) {
    if (!title || !text) throw new Error('title and text are required');
    const memory = await ensureMemory();
    const now = new Date().toISOString();
    const id = `fact-${randomUUID()}`;
    const fact = {
        id,
        title: String(title),
        text: String(text),
        tags: Array.isArray(tags) ? tags.map(String) : [],
        confidence: Number(confidence) || 0.75,
        source: String(source),
        createdAt: now,
        updatedAt: now
    };
    memory.facts.unshift(fact);
    await saveMemory(memory);
    return fact;
}

export async function rememberEpisode({ title, summary, surfaces = [], source = 'runtime', importance = 0.6 }) {
    if (!title || !summary) throw new Error('title and summary are required');
    const memory = await ensureMemory();
    const episode = {
        id: `episode-${randomUUID()}`,
        title: String(title),
        summary: String(summary),
        surfaces: Array.isArray(surfaces) ? surfaces.map(String) : [],
        source: String(source),
        importance: Number(importance) || 0.6,
        createdAt: new Date().toISOString()
    };
    memory.episodes.unshift(episode);
    await saveMemory(memory);
    return episode;
}

export async function recallMemory(query, limit = 8) {
    const memory = await ensureMemory();
    const queryTokens = tokenize(query);
    const facts = memory.facts
        .map((item) => ({ ...item, kind: 'fact', score: scoreMemory(item, queryTokens) }))
        .filter((item) => item.score > 0 || queryTokens.length === 0);
    const episodes = memory.episodes
        .map((item) => ({ ...item, kind: 'episode', score: scoreMemory(item, queryTokens) }))
        .filter((item) => item.score > 0 || queryTokens.length === 0);

    return [...facts, ...episodes]
        .sort((a, b) => b.score - a.score || String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.max(1, Number(limit) || 8));
}

export async function seedMemoryFromSystem(system) {
    const memory = await ensureMemory();
    const now = new Date().toISOString();
    const surfaces = Array.isArray(system?.surfaces) ? system.surfaces : [];
    const episode = {
        id: `episode-system-${randomUUID()}`,
        title: 'System snapshot',
        summary: `Observed ${surfaces.length} living surfaces: ${surfaces.map((surface) => `${surface.label}=${surface.count}`).join(', ')}.`,
        surfaces: surfaces.map((surface) => surface.id),
        source: 'system-map',
        importance: 0.68,
        createdAt: now
    };

    const existingIds = new Set(memory.associations.map((item) => `${item.from}:${item.to}`));
    const newAssociations = [];
    for (const surface of surfaces) {
        if (surface.id === 'screen') continue;
        const key = `screen:${surface.id}`;
        if (existingIds.has(key)) continue;
        newAssociations.push({
            id: `assoc-${surface.id}-${randomUUID()}`,
            from: 'screen',
            to: surface.id,
            relation: `Screen context can explain when ${String(surface.label || surface.id).toLowerCase()} objects become relevant.`,
            strength: 0.55,
            createdAt: now
        });
    }

    memory.episodes.unshift(episode);
    memory.associations.unshift(...newAssociations);
    await saveMemory(memory);
    return { episode, associations: newAssociations };
}
