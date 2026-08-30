import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { MODEL_INFERENCE_ENABLED } from './config.js';

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
        livingRuntime: await exists(path.join(backend, 'livingRuntime.js')),
        capabilityKernel: await exists(path.join(backend, 'capabilityKernel.js')),
        livingRuntimeTests: await exists(path.join(backend, 'tests', 'livingRuntime.test.js')),
        livingBenchTests: await exists(path.join(backend, 'tests', 'livingBench.test.js')),
        memoryStore: await exists(path.join(backend, 'memoryStore.js')),
        nativeCompanion: await exists(path.join(backend, 'nativeCompanion.ps1')),
        workspaceAdapters: await exists(path.join(backend, 'workspaceAdapters.js')),
        frontendApp: await exists(path.join(src, 'App.tsx')),
        styles: await exists(path.join(src, 'styles', 'AppLayout.css')),
        buildScript: Boolean(packageJson.scripts?.build),
        lintScript: Boolean(packageJson.scripts?.lint),
        modelDependenciesPresent: Boolean(backendPackage.dependencies?.ollama || backendPackage.dependencies?.['@google/genai'])
    };

    const specs = [
        {
            id: 'living-runtime',
            label: 'Living Runtime',
            mission: 'Maintain identity, a world model, event history, bounded work, verification receipts, feedback, and approval-gated capability growth across process restarts.',
            evidence: [
                probes.livingRuntime && 'Persistent schema-versioned Living Runtime',
                probes.livingRuntime && 'World, work, and evolution loops',
                probes.capabilityKernel && 'Versioned capability packages with manifest digests',
                probes.capabilityKernel && 'Constitutional validation, dry-run, fitness, and rollback',
                probes.livingRuntime && 'Verification receipts and feedback',
                probes.livingRuntimeTests && 'Automated persistence and evolution tests',
                probes.livingBenchTests && 'LivingBench governance and rollback scenarios'
            ].filter(Boolean),
            gaps: ['Capability packages remain declarative rather than isolated source-code extensions', 'No operating-system process watcher or file-system event stream yet'],
            next: 'Add a subprocess sandbox and signed package loader before allowing implementation-bearing extensions.'
        },
        {
            id: 'perception-agent',
            label: 'Perception Agent',
            mission: 'Continuously interpret the visible desktop and decide whether pushback is warranted.',
            evidence: [
                probes.screenObserver && 'DPI-aware Windows screenshot capture',
                !MODEL_INFERENCE_ENABLED && 'Explicit no-model perception boundary',
                'WebSocket screen stream'
            ].filter(Boolean),
            gaps: [
                'No OCR/document-level state diff yet',
                'No app-specific event hooks yet'
            ],
            next: 'Add deterministic Win32 window metadata and OCR as provenance-tagged world evidence.'
        },
        {
            id: 'memory-agent',
            label: 'Memory Agent',
            mission: 'Persist facts, episodes, and associations so later actions can say "I have seen this before."',
            evidence: [probes.memoryStore && 'Persistent JSON memory store under backend/data', 'Recall endpoint', 'Deterministic grounded-analysis memory context'].filter(Boolean),
            gaps: ['No embeddings/vector index yet', 'No forgetting/importance decay policy yet'],
            next: 'Add embedding-backed recall and promotion rules from screen events.'
        },
        {
            id: 'deterministic-kernel',
            label: 'Deterministic Capability Kernel',
            mission: 'Keep the system useful, inspectable, and evolvable without external or local model inference.',
            evidence: [probes.capabilityKernel && 'Schema-validated package compiler', !MODEL_INFERENCE_ENABLED && 'Model inference disabled by default', probes.modelDependenciesPresent && 'Optional model dependencies remain dormant'].filter(Boolean),
            gaps: ['Need compiler is policy/rule based rather than semantic', 'No WASM or subprocess extension sandbox yet'],
            next: 'Add signed extension bundles executed in a resource-limited subprocess after package rehearsal.'
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
            evidence: ['Read-only metadata adapters', 'Clipboard consent gate', probes.capabilityKernel && 'Manifest validation and runtime-state-only rollback', 'Approval-gated activation'].filter(Boolean),
            gaps: ['No quarantine/fork/remove-reference execution layer yet', 'Approval identities are local-user only'],
            next: 'Add a durable approval ledger with actor, scope, expiry, and revocation.'
        },
        {
            id: 'evaluation-agent',
            label: 'Evaluation Agent',
            mission: 'Continuously test whether agents are real, grounded, and demo-ready.',
            evidence: [probes.buildScript && 'Build script', probes.lintScript && 'Lint script', probes.livingRuntimeTests && 'Node test suite for identity, world, work, evolution, feedback, and persistence', probes.livingBenchTests && 'LivingBench scenarios for governance, unsafe packages, fitness, upgrades, and rollback', `${sourceCount} implementation files`].filter(Boolean),
            gaps: ['No automated browser regression suite', 'No benchmark for transactional artifact editing yet'],
            next: 'Add browser regression and transactional-artifact LivingBench scenarios.'
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
