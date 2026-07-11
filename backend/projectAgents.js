import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { GEMINI_MODEL, hasGemini } from './config.js';

async function exists(target) {
    try {
        await access(target);
        return true;
    } catch {
        return false;
    }
}

async function countFiles(root, extensions) {
    let count = 0;
    async function walk(current, depth = 0) {
        if (depth > 3) return;
        let names = [];
        try {
            names = await readdir(current);
        } catch {
            return;
        }

        await Promise.all(names.slice(0, 180).map(async (name) => {
            if (['node_modules', 'dist', '.git', 'data'].includes(name)) return;
            const target = path.join(current, name);
            try {
                const metadata = await stat(target);
                if (metadata.isDirectory()) return walk(target, depth + 1);
                if (extensions.includes(path.extname(name))) count += 1;
            } catch {}
        }));
    }
    await walk(root);
    return count;
}

function grade(evidence, gaps) {
    const score = Math.max(0, Math.min(100, 35 + evidence.length * 16 - gaps.length * 12));
    if (score >= 82) return { score, maturity: 'operational' };
    if (score >= 62) return { score, maturity: 'prototype' };
    if (score >= 42) return { score, maturity: 'thin-slice' };
    return { score, maturity: 'concept' };
}

export async function projectRigor(root) {
    const backend = path.join(root, 'backend');
    const src = path.join(root, 'src');
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const backendPackage = JSON.parse(await readFile(path.join(backend, 'package.json'), 'utf8'));
    const sourceCount = await countFiles(root, ['.js', '.ts', '.tsx', '.ps1']);

    const probes = {
        screenObserver: await exists(path.join(backend, 'screenObserver.js')),
        memoryStore: await exists(path.join(backend, 'memoryStore.js')),
        nativeCompanion: await exists(path.join(backend, 'nativeCompanion.ps1')),
        workspaceAdapters: await exists(path.join(backend, 'workspaceAdapters.js')),
        frontendApp: await exists(path.join(src, 'App.tsx')),
        styles: await exists(path.join(src, 'styles', 'AppLayout.css')),
        buildScript: Boolean(packageJson.scripts?.build),
        lintScript: Boolean(packageJson.scripts?.lint),
        ollamaDependency: Boolean(backendPackage.dependencies?.ollama),
        googleGenAi: Boolean(backendPackage.dependencies?.['@google/genai'])
    };

    const specs = [
        {
            id: 'perception-agent',
            label: 'Perception Agent',
            mission: 'Continuously interpret the visible desktop and decide whether pushback is warranted.',
            evidence: [
                probes.screenObserver && 'Windows screenshot capture',
                probes.googleGenAi && `Gemini vision (${GEMINI_MODEL})`,
                hasGemini() && 'API key present',
                'WebSocket screen stream'
            ].filter(Boolean),
            gaps: [
                ...(hasGemini() ? [] : ['GEMINI_API_KEY missing']),
                'No OCR/document-level state diff yet',
                'No app-specific event hooks yet'
            ],
            next: 'Add structured screen frame memory with app/window/title/object extraction.'
        },
        {
            id: 'memory-agent',
            label: 'Memory Agent',
            mission: 'Persist facts, episodes, and associations so later actions can say "I have seen this before."',
            evidence: [probes.memoryStore && 'Persistent JSON memory store under backend/data', 'Recall endpoint', 'Gemini memory injection'].filter(Boolean),
            gaps: ['No embeddings/vector index yet', 'No forgetting/importance decay policy yet'],
            next: 'Add embedding-backed recall and promotion rules from screen events.'
        },
        {
            id: 'local-model-agent',
            label: 'Local Model Agent',
            mission: 'Use Ollama for private local reasoning whenever available, with Gemini fallback.',
            evidence: [probes.ollamaDependency && 'Ollama JS client dependency', 'Local-evolve with Ollama -> Gemini -> deterministic cascade'].filter(Boolean),
            gaps: ['Ollama service not guaranteed running'],
            next: 'Run ollama pull for OLLAMA_MODEL and verify /api/local-model/test.'
        },
        {
            id: 'artifact-agent',
            label: 'Artifact Repair Agent',
            mission: 'Repair slides, notes, files, and reports after detecting semantic inconsistency.',
            evidence: [probes.workspaceAdapters && 'Slides/notes/gallery metadata adapters'].filter(Boolean),
            gaps: ['No PPT parser/editor loop yet', 'No reversible patch artifacts yet'],
            next: 'Implement PPTX parse -> inconsistency detect -> rewrite selected slide -> export copy.'
        },
        {
            id: 'dependency-agent',
            label: 'Dependency Graph Agent',
            mission: 'Explain downstream breakage before delete/move/rename actions.',
            evidence: [probes.workspaceAdapters && 'Import-aware dependency snapshot (JS/TS/Python)'].filter(Boolean),
            gaps: ['No full AST graph yet', 'Notebook cell imports only partially covered'],
            next: 'Build full AST/import graph plus document mention index.'
        },
        {
            id: 'safety-agent',
            label: 'Authority & Safety Agent',
            mission: 'Keep destructive actions reversible and require visible approval.',
            evidence: ['Read-only metadata adapters', 'Clipboard consent gate', 'Pushback inspector'],
            gaps: ['No quarantine/fork/remove-reference execution layer yet', 'No policy ledger for approvals yet'],
            next: 'Add an approval ledger and reversible action receipts.'
        },
        {
            id: 'evaluation-agent',
            label: 'Evaluation Agent',
            mission: 'Continuously test whether agents are real, grounded, and demo-ready.',
            evidence: [probes.buildScript && 'Build script', probes.lintScript && 'Lint script', `${sourceCount} implementation files`].filter(Boolean),
            gaps: ['No automated browser regression suite', 'No benchmark tasks for each agent'],
            next: 'Add smoke tests for each API and a demo checklist endpoint.'
        },
        {
            id: 'companion-agent',
            label: 'Companion Agent',
            mission: 'Stay present as a tiny second cursor, then expand only when it has evidence.',
            evidence: [probes.nativeCompanion && 'Native Windows overlay', probes.styles && 'Browser companion style'].filter(Boolean),
            gaps: ['No alert-state bridge into native overlay yet', 'No click-to-fix command channel yet'],
            next: 'Add native overlay states: quiet, warning, speaking, fixing.'
        }
    ];

    const agents = specs.map((agent) => ({ ...agent, ...grade(agent.evidence, agent.gaps) }));
    const average = Math.round(agents.reduce((sum, agent) => sum + agent.score, 0) / agents.length);

    return {
        generatedAt: new Date().toISOString(),
        sourceCount,
        average,
        verdict: average >= 70 ? 'demo-shaped but needs deeper execution loops' : 'promising but still too surface-heavy',
        agents
    };
}
