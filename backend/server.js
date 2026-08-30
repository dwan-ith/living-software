import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import {
    ALLOWED_ORIGINS,
    BACKEND_DIR,
    BIND_HOST,
    DATA_DIR,
    extractJsonObject,
    GEMINI_AGENT,
    GEMINI_IMAGE_MODEL,
    GEMINI_IMAGE_LITE_MODEL,
    GEMINI_MODEL,
    GEMINI_OMNI_MODEL,
    getGemini,
    hasGemini,
    LIVING_AUTOSTART,
    LIVING_CYCLE_INTERVAL_MS,
    LOCAL_MODEL_TIMEOUT_MS,
    MODEL_INFERENCE_ENABLED,
    OBSERVER_ANALYSIS_COOLDOWN_MS,
    OBSERVER_FAILURE_BACKOFF_MS,
    OBSERVER_INTERVAL_MS,
    OLLAMA_BINARY_CANDIDATES,
    OLLAMA_HOST,
    OLLAMA_MODEL,
    ollama,
    originAllowed,
    pathExists,
    PORT,
    POWERSHELL_EXE,
    PROJECT_ROOT_DIR,
    runLocalModelTask,
    withTimeout
} from './config.js';

import { renderImage } from './mockNB2.js';
import { analyzeDesktop, captureDesktop, detectLocalModel } from './screenObserver.js';
import {
    dependencySnapshot,
    readClipboard,
    recentDownloads,
    recentGallery,
    recentNotes,
    recentSlides,
    systemMap
} from './workspaceAdapters.js';
import { readMemory, recallMemory, rememberEpisode, rememberFact, seedMemoryFromSystem } from './memoryStore.js';
import { projectRigor } from './projectAgents.js';
import { livingRuntime } from './livingRuntime.js';
import { SurfaceRuntime } from './surfaceRuntime.js';
import { createGeminiSurfaceGenerator } from './surfaceModelProvider.js';
import { SURFACE_COMPONENT_CATALOG, SURFACE_PROTOCOL } from './surfaceProtocol.js';

const app = express();

// --- Local-boundary security -------------------------------------------------
// This runtime exposes screenshots, clipboard access, memory, and capability
// execution. The allowlist lives in config.js and is enforced on HTTP requests
// and WebSocket handshakes alike; the listener binds to loopback by default.

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) return res.status(403).json({ error: 'Origin is not allowed to drive this runtime.' });
    res.setHeader('Vary', 'Origin');
    next();
});
app.use(cors({ origin: (origin, callback) => callback(null, !origin || originAllowed(origin)) }));
app.use(express.json({ limit: '4mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({
    server,
    // WebSockets are not subject to CORS: without this check any web page could
    // silently receive continuous desktop screenshot frames over ws://localhost.
    verifyClient: (info) => {
        if (!originAllowed(info.req.headers.origin)) {
            console.warn(`Rejected WebSocket connection from origin: ${info.req.headers.origin || '(none)'}`);
            return false;
        }
        return true;
    }
});

const execFileAsync = promisify(execFile);

const surfaceRuntime = new SurfaceRuntime({
    contextProvider: buildGenerativeSurfaceContext,
    generator: createGeminiSurfaceGenerator()
});

await Promise.all([livingRuntime.initialize(), surfaceRuntime.initialize()]);

let companionProcess = null;
let companionPid = null;

/** Real inbox — no fake hackathon notifications. */
const notificationInbox = [];

const observer = {
    running: true,
    capturing: false,
    intervalMs: OBSERVER_INTERVAL_MS,
    analysisCooldownMs: OBSERVER_ANALYSIS_COOLDOWN_MS,
    lastCaptureAt: 0,
    lastAnalysisAt: 0,
    lastCapture: null,
    lastAnalyzedFingerprint: null,
    lastIntervention: null,
    analyzing: false,
    analysisFailures: 0,
    suspendedUntil: 0,
    model: { connected: false, model: null, models: [], visionCapable: false }
};

// The OS idle probe spawns PowerShell, so its value is cached briefly and
// shared by the adaptive capture cadence and the dream loop.
let idleProbe = { at: 0, value: 0, inFlight: null };
async function cachedSystemIdleMs(maxAgeMs = 30_000) {
    if (Date.now() - idleProbe.at < maxAgeMs) return idleProbe.value;
    if (idleProbe.inFlight) return idleProbe.inFlight;
    idleProbe.inFlight = systemIdleMs()
        .then((value) => { idleProbe = { at: Date.now(), value, inFlight: null }; return value; })
        .catch(() => { idleProbe = { at: Date.now(), value: 0, inFlight: null }; return 0; });
    return idleProbe.inFlight;
}

function publicObserverState() {
    return {
        running: observer.running,
        intervalMs: observer.intervalMs,
        lastCaptureAt: observer.lastCapture?.capturedAt || null,
        lastIntervention: observer.lastIntervention,
        analysisFailures: observer.analysisFailures,
        analysisSuspendedUntil: observer.suspendedUntil > Date.now() ? new Date(observer.suspendedUntil).toISOString() : null,
        model: observer.model,
        privacy: observer.model.provider === 'ollama'
            ? 'Screenshots are held in memory and analyzed by the configured local vision model.'
            : hasGemini() && observer.model.connected
                ? 'Screenshots are held in memory and sent to Gemini only for analysis.'
                : 'Screenshots are held in memory. Vision analysis is skipped until a configured provider passes its readiness probe.'
    };
}

function broadcast(type, payload = {}) {
    const message = JSON.stringify({ type, ...payload });
    for (const client of wss.clients) {
        if (client.readyState === 1) client.send(message);
    }
}

/**
 * living_state pushes are notifications, not data transfers. The full state
 * (hundreds of receipts/events, tens or hundreds of KB of JSON) is available
 * via GET /api/living/state; clients only need the digest to know WHEN to
 * re-fetch. Sending whole state on every event was pure bandwidth waste.
 */
function livingStateDigest(state) {
    if (!state) return null;
    return {
        worldRevision: state.world?.revision ?? null,
        stats: state.stats,
        loops: state.loops,
        persistence: state.persistence ? { durable: state.persistence.durable } : undefined,
        identity: { name: state.identity?.name, bootCount: state.identity?.bootCount },
        lastReceiptId: state.receipts?.[0]?.id || null,
        lastEventId: state.events?.[0]?.id || null
    };
}

let workspaceSnapshotCache = null;
let workspaceSnapshotInFlight = null;

async function livingWorldSnapshot(options = {}) {
    const maxAgeMs = Math.max(0, Number(options.maxAgeMs ?? 15_000));
    if (!options.fresh && workspaceSnapshotCache && Date.now() - workspaceSnapshotCache.cachedAt <= maxAgeMs) {
        return structuredClone(workspaceSnapshotCache.value);
    }
    if (workspaceSnapshotInFlight) return structuredClone(await workspaceSnapshotInFlight);
    workspaceSnapshotInFlight = (async () => {
        const memory = await readMemory();
        const value = await systemMap({
            projectRoot: PROJECT_ROOT_DIR,
            notificationCount: notificationInbox.length,
            memoryStats: memory.stats
        });
        workspaceSnapshotCache = { cachedAt: Date.now(), value };
        return value;
    })();
    try {
        return structuredClone(await workspaceSnapshotInFlight);
    } finally {
        workspaceSnapshotInFlight = null;
    }
}

function compactDependency(file) {
    return {
        id: `dependency:${String(file.name || '').toLowerCase()}`,
        name: file.name,
        type: file.type,
        size: file.size,
        modifiedAt: file.modifiedAt,
        references: Number(file.references || 0),
        importers: Array.isArray(file.importers) ? file.importers.slice(0, 8) : [],
        risk: file.risk || 'low',
        signals: Array.isArray(file.signals) ? file.signals.slice(0, 8) : []
    };
}

async function buildGenerativeSurfaceContext({ session, utterance, focus, reason, viewport }) {
    const [living, memory, workspace] = await Promise.all([
        livingRuntime.getState(),
        readMemory(),
        livingWorldSnapshot()
    ]);
    const recentMemory = [
        ...(memory.facts || []).slice(0, 10).map((item) => ({
            id: item.id,
            kind: 'fact',
            title: item.title,
            text: item.text,
            source: item.source,
            createdAt: item.createdAt
        })),
        ...(memory.episodes || []).slice(0, 10).map((item) => ({
            id: item.id,
            kind: 'episode',
            title: item.title,
            text: item.summary,
            source: item.source,
            createdAt: item.createdAt
        }))
    ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 16);

    const data = {
        living: {
            identity: living.identity,
            constitution: living.constitution,
            stats: living.stats,
            loops: living.loops,
            reflections: living.reflections.slice(0, 8),
            capabilities: living.capabilities.filter((item) => item.status === 'active').slice(0, 24),
            proposals: living.proposals.filter((item) => ['proposed', 'invalid', 'validated', 'rehearsed'].includes(item.status)).slice(0, 16),
            receipts: living.receipts.slice(0, 24),
            events: living.events.slice(0, 40),
            world: {
                revision: living.world.revision,
                observedAt: living.world.observedAt,
                entities: living.world.entities.slice(0, 30)
            }
        },
        workspace: {
            generatedAt: workspace.generatedAt,
            surfaces: (workspace.surfaces || []).slice(0, 20),
            dependencies: {
                scanned: Number(workspace.dependencies?.scanned || 0),
                files: (workspace.dependencies?.files || []).slice(0, 36).map(compactDependency)
            }
        },
        memory: {
            stats: memory.stats,
            recent: recentMemory
        }
    };

    const promptContext = {
        intent: { utterance, focus, reason, viewport },
        continuity: {
            identity: living.identity,
            stats: living.stats,
            loops: living.loops,
            recentTurns: (session?.turns || []).slice(-8),
            previousComponents: session?.current?.components?.map((item) => item.type) || []
        },
        activeCapabilities: data.living.capabilities.map((item) => ({
            id: item.id,
            name: item.name,
            version: item.version,
            fitness: item.metrics?.fitness,
            steps: item.steps?.map((step) => step.primitive)
        })),
        pendingProposals: data.living.proposals.map((item) => ({
            id: item.id,
            name: item.name,
            status: item.status,
            rationale: item.rationale
        })),
        recentEvents: data.living.events.slice(0, 16).map((item) => ({ kind: item.kind, summary: item.summary, importance: item.importance })),
        workspace: {
            surfaces: data.workspace.surfaces,
            dependencySummary: {
                scanned: data.workspace.dependencies.scanned,
                highRisk: data.workspace.dependencies.files.filter((item) => item.risk === 'high').length,
                top: data.workspace.dependencies.files.slice(0, 12).map((item) => ({ name: item.name, risk: item.risk, references: item.references, signals: item.signals }))
            }
        },
        memory: recentMemory.slice(0, 8).map((item) => ({ kind: item.kind, title: item.title, text: item.text }))
    };
    return { data, promptContext };
}

let livingCycleRunning = false;

async function runAndBroadcastLivingCycle(reason = 'scheduled', options = {}) {
    if (livingCycleRunning) return null;
    livingCycleRunning = true;
    try {
        const worldSnapshot = options.worldSnapshot || await livingWorldSnapshot();
        const result = await livingRuntime.runCycle({
            reason,
            source: options.source || 'backend-runtime',
            worldSnapshot,
            dependencies: options.dependencies || null
        });
        broadcast('living_cycle', { cycle: result.cycle, reflection: result.reflection, receipt: result.receipt, proposal: result.proposal || null });
        broadcast('living_state', { state: livingStateDigest(result.state) });
        broadcast('surface_invalidated', { reason: `living-cycle:${reason}` });
        return result;
    } finally {
        livingCycleRunning = false;
    }
}

async function observerTick(forceAnalysis = false) {
    if (!observer.running || observer.capturing) return;

    const now = Date.now();
    // Adaptive cadence: while the user is demonstrably present (OS input within
    // 2 minutes) capture at the configured interval; when they are away, back
    // off to one frame per 30s. Fewer screenshots of an empty chair.
    let effectiveInterval = observer.intervalMs;
    try {
        if (await cachedSystemIdleMs() > 120_000) effectiveInterval = Math.max(effectiveInterval, 30_000);
    } catch { /* cadence falls back to default */ }
    if (now - observer.lastCaptureAt < effectiveInterval) return;

    observer.capturing = true;
    let capture;

    try {
        capture = await captureDesktop();
        observer.lastCaptureAt = Date.now();
        observer.lastCapture = capture;
        broadcast('screen', {
            image: `data:image/jpeg;base64,${capture.imageBase64}`,
            capturedAt: capture.capturedAt
        });
    } catch (error) {
        broadcast('observer_error', { message: error.message });
        observer.capturing = false;
        return;
    }

    observer.capturing = false;

    // Run analysis separately without blocking the next capture frame.
    const screenUnchanged = observer.lastAnalyzedFingerprint === capture.fingerprint;
    if (screenUnchanged && !forceAnalysis) return;
    const canAnalyze = forceAnalysis || now - observer.lastAnalysisAt >= observer.analysisCooldownMs;
    if (!canAnalyze || observer.analyzing || observer.suspendedUntil > Date.now()) return;

    observer.analyzing = true;
    observer.lastAnalysisAt = Date.now();
    observer.lastAnalyzedFingerprint = capture.fingerprint;

    (async () => {
        try {
            observer.model = await detectLocalModel();
            broadcast('observer_status', { state: publicObserverState() });

            if (!observer.model.connected || !observer.model.visionCapable) {
                broadcast('analysis_skipped', {
                    reason: hasGemini()
                        ? `${observer.model.model || 'The selected model'} is not vision-capable.`
                        : 'GEMINI_API_KEY is not configured.'
                });
                return;
            }

            broadcast('analysis_started', { model: observer.model.model });
            const analysis = await analyzeDesktop(capture.imageBase64, observer.model.model);
            observer.analysisFailures = 0;
            observer.suspendedUntil = 0;
            broadcast('analysis', { analysis, capturedAt: capture.capturedAt });

            const perceptionInputs = [{
                kind: 'perception.analysis',
                source: 'screen-observer',
                summary: analysis.stateSummary || analysis.reason || 'Desktop state observed.',
                importance: analysis.shouldIntervene ? 0.9 : 0.45,
                data: {
                    activity: analysis.activity,
                    application: analysis.application,
                    shouldIntervene: analysis.shouldIntervene,
                    severity: analysis.severity,
                    capturedAt: capture.capturedAt,
                    fingerprint: capture.fingerprint
                },
                dedupeKey: `perception.analysis:${capture.fingerprint}`
            }];
            for (const signal of analysis.signals || []) {
                if (signal.confidence < 0.4) continue;
                perceptionInputs.push({
                    kind: `perception.${signal.kind}`,
                    source: 'screen-observer',
                    summary: signal.summary,
                    importance: signal.kind === 'risk' || signal.kind === 'blockage' ? 0.8 : 0.55,
                    data: { confidence: signal.confidence, evidence: signal.evidence, capturedAt: capture.capturedAt },
                    dedupeKey: `perception.${signal.kind}:${signal.summary}`
                });
            }
            if (analysis.shouldIntervene) {
                perceptionInputs.push({
                    kind: 'screen.intervention',
                    source: 'screen-observer',
                    summary: analysis.reason || analysis.title,
                    importance: analysis.severity === 'critical' ? 1 : 0.9,
                    data: { title: analysis.title, application: analysis.application, severity: analysis.severity, evidence: analysis.evidence, actions: analysis.actions },
                    dedupeKey: `screen.intervention:${analysis.title}`
                });
            }
            const perceptionEvents = await livingRuntime.recordEvents(perceptionInputs);
            for (const event of perceptionEvents) broadcast('living_event', { event });

            if (analysis.shouldIntervene) {
                observer.lastIntervention = { ...analysis, createdAt: new Date().toISOString() };
                broadcast('intervention', { intervention: observer.lastIntervention });
                try {
                    const episode = await rememberEpisode({
                        title: analysis.title || 'Screen intervention',
                        summary: analysis.reason || analysis.spoken || 'Intervention triggered from screen observation.',
                        surfaces: ['screen'],
                        source: 'screen-observer',
                        importance: analysis.severity === 'critical' ? 0.9 : 0.7
                    });
                    broadcast('memory', { item: episode });
                } catch { }
                runAndBroadcastLivingCycle('screen-intervention', { source: 'screen-observer' })
                    .catch((error) => broadcast('living_error', { message: error.message }));
            }
        } catch (error) {
            observer.analysisFailures += 1;
            if (observer.analysisFailures >= 3) observer.suspendedUntil = Date.now() + OBSERVER_FAILURE_BACKOFF_MS;
            broadcast('observer_error', { message: `Analysis error: ${error.message}` });
            broadcast('observer_status', { state: publicObserverState() });
        } finally {
            observer.analyzing = false;
        }
    })();
}

// Poll frequently, but only capture on intervalMs (see observerTick).
setInterval(() => observerTick(false), 1000);

/** Real user-idle time in ms via the OS last-input timestamp (Windows). */
async function systemIdleMs() {
    if (process.platform !== 'win32') return 0;
    const script = [
        'Add-Type -TypeDefinition @\'',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
        'public static class IdleProbe {',
        '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
        '  public static uint MillisecondsSinceLastInput() {',
        '    LASTINPUTINFO info = new LASTINPUTINFO();',
        '    info.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(info);',
        '    if (!GetLastInputInfo(ref info)) return 0;',
        '    return (uint)Environment.TickCount - info.dwTime;',
        '  }',
        '}\'@',
        '[IdleProbe]::MillisecondsSinceLastInput()'
    ].join('; ');
    try {
        const { stdout } = await execFileAsync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true,
            timeout: 8000
        });
        const parsed = Number(stdout.trim());
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch {
        return 0;
    }
}

// Idle dream loop: when the human has genuinely stepped away (no keyboard or
// pointer input for 10+ minutes, measured by the OS rather than by capture
// timestamps, which refresh every few seconds regardless of presence), run an
// autonomous living cycle and record the idle context that capabilities like
// idle.detect can ground against. Respects LIVING_AUTOSTART.
const dreamTimer = setInterval(async () => {
    if (!LIVING_AUTOSTART || livingCycleRunning) return;
    const idleMs = await cachedSystemIdleMs(60_000);
    if (idleMs < 10 * 60 * 1000) return;
    try {
        console.log(`User idle for ${Math.round(idleMs / 60000)}m; entering living-runtime dream phase...`);
        await livingRuntime.recordEvent({
            kind: 'idle-dream',
            source: 'living-idle-loop',
            summary: `No keyboard or pointer input for ${Math.round(idleMs / 60000)} minutes; entering the autonomous dream phase.`,
            importance: 0.5,
            data: { systemIdleMs: idleMs },
            dedupeKey: `idle-dream:${new Date().toISOString().slice(0, 13)}`
        });
        await runAndBroadcastLivingCycle('idle-dream', { source: 'living-idle-loop' });
    } catch (e) {
        console.warn('Dream loop failed:', e.message);
    }
}, 60_000);
dreamTimer.unref?.();
if (LIVING_AUTOSTART) {
    const livingTimer = setInterval(() => {
        runAndBroadcastLivingCycle('scheduled', { source: 'living-timer' })
            .catch((error) => broadcast('living_error', { message: error.message }));
    }, LIVING_CYCLE_INTERVAL_MS);
    livingTimer.unref?.();

    const startupTimer = setTimeout(() => {
        runAndBroadcastLivingCycle('startup', { source: 'living-runtime' })
            .catch((error) => broadcast('living_error', { message: error.message }));
    }, 1500);
    startupTimer.unref?.();
}

app.get('/api/observer/status', async (_req, res) => {
    observer.model = await detectLocalModel();
    res.json(publicObserverState());
});

app.post('/api/observer/start', (_req, res) => {
    observer.running = true;
    observerTick(true);
    broadcast('observer_status', { state: publicObserverState() });
    res.json(publicObserverState());
});

app.post('/api/observer/pause', (_req, res) => {
    observer.running = false;
    broadcast('observer_status', { state: publicObserverState() });
    res.json(publicObserverState());
});

app.post('/api/observer/analyze', async (_req, res) => {
    observer.running = true;
    await observerTick(true);
    res.json(publicObserverState());
});

app.get('/api/observer/frame', (_req, res) => {
    if (!observer.lastCapture) return res.status(404).json({ error: 'No frame captured yet.' });
    res.json({
        image: `data:image/jpeg;base64,${observer.lastCapture.imageBase64}`,
        capturedAt: observer.lastCapture.capturedAt
    });
});

app.get('/api/living/state', async (_req, res) => {
    try {
        res.json(await livingRuntime.getState());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/living/health', async (_req, res) => {
    try {
        const [health, audit] = await Promise.all([livingRuntime.health(), livingRuntime.audit()]);
        const memory = process.memoryUsage();
        res.json({
            ...health,
            audit,
            modelInferenceEnabled: MODEL_INFERENCE_ENABLED,
            processMemory: {
                rssMb: Math.round(memory.rss / 1024 / 1024),
                heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
                heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
                externalMb: Math.round(memory.external / 1024 / 1024)
            },
            observer: {
                running: observer.running,
                analyzing: observer.analyzing,
                provider: observer.model.provider || null,
                connected: Boolean(observer.model.connected),
                error: observer.model.error || null,
                failures: observer.analysisFailures,
                suspendedUntil: observer.suspendedUntil > Date.now() ? new Date(observer.suspendedUntil).toISOString() : null
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/living/audit', async (_req, res) => {
    try {
        res.json({ ...(await livingRuntime.audit()), modelInferenceEnabled: MODEL_INFERENCE_ENABLED });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/surfaces/catalog', (_req, res) => {
    res.json({
        protocol: SURFACE_PROTOCOL,
        providerAvailable: hasGemini(),
        modelInferenceEnabled: MODEL_INFERENCE_ENABLED,
        components: SURFACE_COMPONENT_CATALOG
    });
});

app.post('/api/surfaces/compose', async (req, res) => {
    try {
        const surface = await surfaceRuntime.compose({
            sessionId: req.body?.sessionId,
            utterance: req.body?.utterance,
            focus: req.body?.focus,
            reason: req.body?.reason || 'user-intent',
            viewport: req.body?.viewport || null
        });
        broadcast('surface_state', { sessionId: surface.sessionId, surface });
        res.json({ surface });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/surfaces/:sessionId', async (req, res) => {
    try {
        const current = await surfaceRuntime.getCurrent(req.params.sessionId);
        const surface = current || await surfaceRuntime.compose({ sessionId: req.params.sessionId, reason: 'session-resume' });
        res.json({ surface });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

async function executeSurfaceAction(action, targetId) {
    if (action === 'surface.regenerate') return { summary: 'The current phenotype was regenerated from live context.' };
    if (action === 'living.cycle') {
        const result = await runAndBroadcastLivingCycle('surface-action', { source: 'generative-surface' });
        if (!result) throw new Error('A living cycle is already running.');
        return { summary: `Living cycle ${result.cycle.status}.`, cycleId: result.cycle.id };
    }
    if (action === 'capability.run') {
        const receipt = await livingRuntime.executeCapability(targetId, { source: 'generative-surface' });
        broadcast('living_receipt', { receipt });
        broadcast('living_state', { state: livingStateDigest(await livingRuntime.getState()) });
        return { summary: `${targetId} emitted a ${receipt.status} receipt.`, receiptId: receipt.id };
    }
    if (action === 'capability.rollback') {
        const result = await livingRuntime.rollbackCapability(targetId, 'Explicit rollback from a generated capability surface.');
        broadcast('living_capability_rolled_back', result);
        return { summary: `${targetId} rolled back to ${result.capability.status}.` };
    }
    if (action === 'proposal.validate') {
        const result = await livingRuntime.validateProposal(targetId);
        broadcast('living_proposal_validated', result);
        return { summary: `${result.proposal.name} validation ${result.validation.status}.` };
    }
    if (action === 'proposal.rehearse') {
        const workspace = await dependencySnapshot(PROJECT_ROOT_DIR);
        const result = await livingRuntime.dryRunProposal(targetId, { dependencies: workspace });
        broadcast('living_proposal_rehearsed', result);
        return { summary: `${result.proposal.name} rehearsal ${result.rehearsal.status}.` };
    }
    if (action === 'proposal.activate') {
        const result = await livingRuntime.installProposal(targetId);
        broadcast('living_capability_installed', result);
        return { summary: `${result.capability.name}@${result.capability.version} activated.` };
    }
    if (action === 'proposal.reject') {
        const result = await livingRuntime.rejectProposal(targetId, 'Rejected from the generated context surface.');
        broadcast('living_proposal_rejected', result);
        return { summary: `${result.proposal.name} rejected without activation.` };
    }
    if (action === 'receipt.useful' || action === 'receipt.reject') {
        const verdict = action === 'receipt.useful' ? 'useful' : 'rejected';
        const result = await livingRuntime.recordFeedback({ receiptId: targetId, verdict });
        broadcast('living_feedback', result);
        return { summary: `Receipt ${targetId} marked ${verdict}.` };
    }
    if (action === 'receipt.revert') {
        const result = await livingRuntime.applyCompensation(targetId);
        broadcast('living_receipt_reverted', result);
        return {
            summary: result.failed.length === 0
                ? `Receipt ${targetId} reverted; ${result.applied.length} artifact effect(s) undone.`
                : `Revert partially failed for ${targetId}; manual review required.`
        };
    }
    throw new Error(`Surface action is not executable: ${action}`);
}

app.post('/api/surfaces/:sessionId/actions', async (req, res) => {
    try {
        const authorization = await surfaceRuntime.authorizeAction(req.params.sessionId, req.body || {});
        const outcome = await executeSurfaceAction(authorization.action, authorization.targetId);
        await surfaceRuntime.recordAction(req.params.sessionId, {
            action: authorization.action,
            targetId: authorization.targetId,
            actionKey: authorization.actionKey,
            summary: outcome.summary
        });
        if (authorization.action !== 'surface.regenerate') {
            const event = await livingRuntime.recordEvent({
                kind: 'surface.action',
                source: 'generative-surface',
                summary: outcome.summary,
                importance: 0.65,
                data: {
                    action: authorization.action,
                    targetId: authorization.targetId,
                    surfaceId: authorization.surface.id,
                    componentId: authorization.component.id
                }
            });
            broadcast('living_event', { event });
        }
        const surface = await surfaceRuntime.compose({
            sessionId: req.params.sessionId,
            focus: authorization.surface.focus,
            reason: `action:${authorization.action}`
        });
        const state = await livingRuntime.getState();
        broadcast('living_state', { state: livingStateDigest(state) });
        broadcast('surface_state', { sessionId: surface.sessionId, surface });
        res.json({ outcome, surface });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/living/events', async (req, res) => {
    try {
        if (!req.body?.kind || !req.body?.summary) return res.status(400).json({ error: 'kind and summary are required' });
        const event = await livingRuntime.recordEvent({ ...req.body, source: req.body.source || 'user' });
        const state = await livingRuntime.getState();
        broadcast('living_event', { event });
        broadcast('living_state', { state: livingStateDigest(state) });
        res.status(201).json({ event, state });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/living/cycle', async (req, res) => {
    try {
        const result = await runAndBroadcastLivingCycle(req.body?.reason || 'manual', { source: 'user' });
        if (!result) return res.status(409).json({ error: 'A living cycle is already running.' });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Execution context keys the runtime threads between primitive steps itself.
// A caller must never supply these: lastCapture would push attacker-chosen
// bytes to a vision provider; priorOutputs could spoof earlier steps.
const INTERNAL_CONTEXT_KEYS = new Set(['lastCapture', 'priorOutputs', 'synthesizedText', 'synthesizedTargetFolder']);

function publicCapabilityContext(body = {}) {
    const context = {};
    for (const [key, value] of Object.entries(body || {})) {
        if (!INTERNAL_CONTEXT_KEYS.has(key)) context[key] = value;
    }
    return context;
}

app.post('/api/living/capabilities/:id/run', async (req, res) => {
    try {
        const receipt = await livingRuntime.executeCapability(req.params.id, publicCapabilityContext(req.body));
        const state = await livingRuntime.getState();
        broadcast('living_receipt', { receipt });
        broadcast('living_state', { state: livingStateDigest(state) });
        res.json({ receipt, state });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

const SAFE_CAPABILITY_PRIMITIVES = new Set(['world.snapshot', 'context.reflect', 'risk.summarize']);

function synthesisWarning(provider, error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown provider failure');
    return `${provider}: ${message.replace(/\s+/g, ' ').slice(0, 240)}`;
}

function deterministicCapabilityName(need) {
    const text = String(need || '').toLowerCase();
    if (/evidence|research|citation/.test(text) && /note|slide|deck|artifact/.test(text)) return 'Evidence Continuity';
    if (/dependency|deletion|risk|break/.test(text)) return 'Workspace Risk Sense';
    if (/memory|resume|continuity|context/.test(text)) return 'Context Continuity';

    const ignored = new Set(['about', 'after', 'again', 'also', 'because', 'before', 'being', 'capability', 'change', 'could', 'from', 'have', 'into', 'need', 'should', 'software', 'that', 'their', 'them', 'then', 'there', 'these', 'this', 'when', 'where', 'which', 'with', 'without', 'would']);
    const words = String(need || '').match(/[a-z][a-z0-9-]{2,}/gi) || [];
    const meaningful = [...new Set(words.map((word) => word.toLowerCase()).filter((word) => !ignored.has(word)))].slice(0, 4);
    const title = meaningful.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
    return `${title || 'Context'} Companion`;
}

function normalizeCapabilitySynthesis(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    const name = String(candidate.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const rationale = String(candidate.rationale || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    const rawSteps = Array.isArray(candidate.steps) ? candidate.steps : [];
    const requestedPrimitives = rawSteps.map((step) => String(step?.primitive || '').trim()).filter(Boolean);
    if (!name || !rationale || !requestedPrimitives.length) return null;
    if (requestedPrimitives.some((primitive) => !SAFE_CAPABILITY_PRIMITIVES.has(primitive))) return null;

    const triggerKinds = (Array.isArray(candidate.triggerKinds) ? candidate.triggerKinds : [])
        .map((kind) => String(kind || '').trim().slice(0, 100))
        .filter((kind) => /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/i.test(kind))
        .slice(0, 10);
    return {
        name,
        rationale,
        triggerKinds: triggerKinds.length ? triggerKinds : ['user.intent'],
        steps: requestedPrimitives.slice(0, 6).map((primitive) => ({ primitive }))
    };
}

async function synthesizeBoundedCapability(need) {
    if (!MODEL_INFERENCE_ENABLED) {
        const text = String(need || '').toLowerCase();
        const riskNeed = /dependency|deletion|risk|break|unsafe/.test(text);
        const notificationNeed = /notification|interrupt|inbox|message/.test(text);
        const evidenceNeed = /evidence|research|citation|note|slide|deck|artifact|continuity/.test(text);
        return {
            name: deterministicCapabilityName(need),
            rationale: `A deterministic policy compiler translated the expressed need into a reviewable capability package: ${String(need).trim().slice(0, 400)}`,
            triggerKinds: riskNeed ? ['workspace.risk'] : notificationNeed ? ['workspace.notification'] : evidenceNeed ? ['artifact.analysis', 'world.observed'] : ['user.intent'],
            steps: riskNeed
                ? [{ primitive: 'risk.summarize' }, { primitive: 'context.reflect' }]
                : evidenceNeed
                    ? [{ primitive: 'world.snapshot' }, { primitive: 'context.reflect' }]
                    : [{ primitive: 'context.reflect' }],
            source: 'deterministic-policy-compiler',
            warnings: [],
            degraded: false
        };
    }

    const warnings = [];
    const livingContext = await livingRuntime.contextForPrompt();
    const prompt = `Translate this changing human need into a bounded Living Software capability proposal.

Need: ${String(need).slice(0, 1500)}

Runtime context:
${livingContext}

You may compose only these trusted primitives:
- world.snapshot: capture durable world state
- context.reflect: derive an evidence-linked reflection
- risk.summarize: summarize dependency/intervention evidence

Return JSON only:
{"name":"short capability name","rationale":"how this capability addresses the need","triggerKinds":["event.kind"],"steps":[{"primitive":"world.snapshot"}]}

Do not generate source code, shell commands, file mutations, or external side effects. This is a proposal that still requires user approval.`;

    try {
        const local = await localModelStatus();
        if (local.ready) {
            const response = await runLocalModelTask(() => withTimeout(ollama.chat({
                model: OLLAMA_MODEL,
                messages: [{ role: 'user', content: prompt }],
                format: 'json',
                options: { temperature: 0.2, num_gpu: 0 }
            }), LOCAL_MODEL_TIMEOUT_MS, 'ollama'));
            const parsed = extractJsonObject(response.message?.content);
            const normalized = normalizeCapabilitySynthesis(parsed);
            if (normalized) return { ...normalized, source: 'ollama-local', warnings, degraded: false };
            warnings.push('ollama-local: response did not satisfy the bounded capability schema');
        } else {
            warnings.push(`ollama-local: ${local.error || `model ${OLLAMA_MODEL} is not ready`}`);
        }
    } catch (error) {
        warnings.push(synthesisWarning('ollama-local', error));
    }

    if (hasGemini()) {
        try {
            const ai = getGemini();
            const response = await ai.models.generateContent({
                model: GEMINI_MODEL,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: { temperature: 0.2, systemInstruction: 'Return only valid JSON using the allowed Living Software primitives.' }
            });
            const parsed = extractJsonObject(response.text || response.candidates?.[0]?.content?.parts?.[0]?.text || '');
            const normalized = normalizeCapabilitySynthesis(parsed);
            if (normalized) return { ...normalized, source: 'gemini-api', warnings, degraded: false };
            warnings.push('gemini-api: response did not satisfy the bounded capability schema');
        } catch (error) {
            warnings.push(synthesisWarning('gemini-api', error));
        }
    } else {
        warnings.push('gemini-api: not configured');
    }

    return {
        name: deterministicCapabilityName(need),
        rationale: `A deterministic bounded proposal derived from the expressed need: ${String(need).trim().slice(0, 400)}`,
        triggerKinds: ['user.intent'],
        steps: [{ primitive: 'world.snapshot' }, { primitive: 'context.reflect' }],
        source: 'deterministic-safe-fallback',
        warnings,
        degraded: true
    };
}

app.post('/api/living/evolve', async (req, res) => {
    try {
        const need = String(req.body?.need || '').trim();
        if (!need) return res.status(400).json({ error: 'need is required' });
        const needEvent = await livingRuntime.recordEvent({
            kind: 'capability.need',
            source: 'user',
            summary: need,
            importance: 0.85
        });
        const generated = await synthesizeBoundedCapability(need);
        const proposal = await livingRuntime.proposeCapability({
            name: generated.name,
            rationale: generated.rationale,
            triggerKinds: generated.triggerKinds,
            steps: generated.steps,
            origin: 'user-directed',
            synthesis: { source: generated.source, degraded: generated.degraded, warnings: generated.warnings }
        });
        const state = await livingRuntime.getState();
        broadcast('living_event', { event: needEvent });
        broadcast('living_proposal', { proposal, source: generated.source, warnings: generated.warnings });
        broadcast('living_state', { state: livingStateDigest(state) });
        res.status(201).json({ proposal, source: generated.source, degraded: generated.degraded, warnings: generated.warnings, state });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/living/proposals', async (req, res) => {
    try {
        const proposal = await livingRuntime.proposeCapability(req.body || {});
        const state = await livingRuntime.getState();
        broadcast('living_proposal', { proposal });
        broadcast('living_state', { state: livingStateDigest(state) });
        res.status(201).json({ proposal, state });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/living/proposals/:id/validate', async (req, res) => {
    try {
        const result = await livingRuntime.validateProposal(req.params.id);
        const state = await livingRuntime.getState();
        broadcast('living_proposal_validated', result);
        broadcast('living_state', { state: livingStateDigest(state) });
        res.json({ ...result, state });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/living/proposals/:id/dry-run', async (req, res) => {
    try {
        const dependencies = await dependencySnapshot(PROJECT_ROOT_DIR);
        const result = await livingRuntime.dryRunProposal(req.params.id, { ...(req.body || {}), dependencies });
        const state = await livingRuntime.getState();
        broadcast('living_proposal_rehearsed', result);
        broadcast('living_state', { state: livingStateDigest(state) });
        res.json({ ...result, state });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/living/proposals/:id/install', async (req, res) => {
    try {
        const result = await livingRuntime.installProposal(req.params.id);
        const state = await livingRuntime.getState();
        broadcast('living_capability_installed', result);
        broadcast('living_state', { state: livingStateDigest(state) });
        res.json({ ...result, state });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/living/proposals/:id/reject', async (req, res) => {
    try {
        const result = await livingRuntime.rejectProposal(req.params.id, req.body?.reason);
        const state = await livingRuntime.getState();
        broadcast('living_proposal_rejected', result);
        broadcast('living_state', { state: livingStateDigest(state) });
        res.json({ ...result, state });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/living/capabilities/:id/rollback', async (req, res) => {
    try {
        const result = await livingRuntime.rollbackCapability(req.params.id, req.body?.reason);
        const state = await livingRuntime.getState();
        broadcast('living_capability_rolled_back', result);
        broadcast('living_state', { state: livingStateDigest(state) });
        res.json({ ...result, state });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/living/feedback', async (req, res) => {
    try {
        const result = await livingRuntime.recordFeedback(req.body || {});
        const state = await livingRuntime.getState();
        broadcast('living_feedback', result);
        broadcast('living_state', { state: livingStateDigest(state) });
        res.json({ ...result, state });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/living/receipts/:id/revert', async (req, res) => {
    try {
        const result = await livingRuntime.applyCompensation(req.params.id);
        const state = await livingRuntime.getState();
        broadcast('living_receipt_reverted', result);
        broadcast('living_state', { state: livingStateDigest(state) });
        res.json({ ...result, state });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

function companionState() {
    let running = Boolean(companionProcess && !companionProcess.killed && (companionProcess.exitCode === null || companionProcess.exitCode === undefined));
    if (companionPid) {
        try {
            process.kill(companionPid, 0);
            running = true;
        } catch {
            running = false;
            companionPid = null;
        }
    }
    return {
        running,
        pid: companionPid || companionProcess?.pid || null,
        mode: 'native-windows-overlay'
    };
}

async function findOllamaBinaries() {
    const found = [];
    for (const candidate of OLLAMA_BINARY_CANDIDATES) {
        try {
            await access(candidate);
            found.push(candidate);
        } catch { }
    }
    return found;
}

async function localModelStatus() {
    if (!MODEL_INFERENCE_ENABLED) {
        return {
            provider: 'disabled',
            host: null,
            targetModel: null,
            binary: [],
            service: 'disabled',
            models: [],
            ready: false,
            pullCommand: null,
            error: 'Model inference is disabled by runtime policy.'
        };
    }
    const binary = await findOllamaBinaries();

    try {
        const response = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
        const data = await response.json();
        const models = (data.models || []).map((model) => model.name);
        const ready = models.some((model) => model === OLLAMA_MODEL || model.startsWith(`${OLLAMA_MODEL}:`) || model.startsWith(`${OLLAMA_MODEL.split(':')[0]}`));
        return {
            provider: 'ollama',
            host: OLLAMA_HOST,
            targetModel: OLLAMA_MODEL,
            binary,
            service: 'online',
            models,
            ready,
            pullCommand: `ollama pull ${OLLAMA_MODEL}`
        };
    } catch (error) {
        return {
            provider: 'ollama',
            host: OLLAMA_HOST,
            targetModel: OLLAMA_MODEL,
            binary,
            service: 'offline',
            models: [],
            ready: false,
            pullCommand: `ollama pull ${OLLAMA_MODEL}`,
            error: error.message
        };
    }
}

app.get('/api/workspace/files', async (_req, res) => {
    try {
        res.json({ directory: 'Downloads', files: await recentDownloads() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/workspace/slides', async (_req, res) => {
    try {
        res.json({ slides: await recentSlides() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/workspace/notes', async (_req, res) => {
    try {
        res.json({ notes: await recentNotes() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/workspace/gallery', async (_req, res) => {
    try {
        res.json({ media: await recentGallery() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/workspace/dependencies', async (_req, res) => {
    try {
        const snapshot = await dependencySnapshot(PROJECT_ROOT_DIR);
        const highRisk = snapshot.files.filter((file) => file.risk === 'high');
        if (highRisk.length) {
            const event = await livingRuntime.recordEvent({
                kind: 'workspace.risk',
                source: 'dependency-snapshot',
                summary: `${highRisk.length} source artifacts currently have high heuristic dependency risk.`,
                importance: 0.75,
                entityIds: highRisk.map((file) => `file:${file.path}`),
                data: { files: highRisk.slice(0, 12).map((file) => ({ name: file.name, references: file.references, signals: file.signals })) },
                dedupeKey: `workspace.risk:${highRisk.map((file) => file.name).sort().join('|')}`
            });
            broadcast('living_event', { event });
        }
        res.json(snapshot);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Read-only by default: a GET must not mutate world state. Pass ?observe=1 to
// record an explicit observation (the scheduled living cycles already do this).
app.get('/api/workspace/system', async (req, res) => {
    try {
        const observe = req.query.observe === '1' || req.query.observe === 'true';
        const map = await livingWorldSnapshot({ fresh: observe });
        if (observe) {
            const observation = await livingRuntime.observeWorld(map, { source: 'workspace-system-endpoint' });
            broadcast('living_event', { event: observation.event });
            broadcast('living_state', { state: livingStateDigest(await livingRuntime.getState()) });
        }
        res.json(map);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/agents/rigor', async (_req, res) => {
    try {
        res.json(await projectRigor(PROJECT_ROOT_DIR));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/memory', async (_req, res) => {
    try {
        res.json(await readMemory());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/memory/facts', async (req, res) => {
    try {
        res.status(201).json(await rememberFact(req.body || {}));
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/memory/episodes', async (req, res) => {
    try {
        const episode = await rememberEpisode(req.body || {});
        broadcast('memory', { item: episode });
        res.status(201).json(episode);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/memory/recall', async (req, res) => {
    try {
        const matches = await recallMemory(req.body?.query || '', req.body?.limit || 8);
        res.json({ matches });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/memory/seed-system', async (_req, res) => {
    try {
        const memory = await readMemory();
        const map = await systemMap({
            projectRoot: PROJECT_ROOT_DIR,
            notificationCount: notificationInbox.length,
            memoryStats: memory.stats
        });
        const result = await seedMemoryFromSystem(map);
        broadcast('memory', { item: result.episode });
        res.status(201).json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Clipboard access is consent-gated for real: an explicit POST with
// { confirm: true } from the user (or a trusted local client), not a passive GET.
app.post('/api/workspace/clipboard', async (_req, res) => {
    try {
        if (_req.body?.confirm !== true) {
            return res.status(428).json({ error: 'Clipboard reads require explicit consent: POST {"confirm":true}.' });
        }
        res.json(await readClipboard());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/workspace/notifications', (_req, res) => {
    res.json({ notifications: notificationInbox });
});

app.post('/api/workspace/notifications', async (req, res) => {
    const body = req.body || {};
    if (!body.text && !body.title) {
        return res.status(400).json({ error: 'text or title is required' });
    }
    const item = {
        source: typeof body.source === 'string' ? body.source.slice(0, 80) : 'Local',
        project: typeof body.project === 'string' ? body.project.slice(0, 120) : 'Inbox',
        text: String(body.text || body.title || '').slice(0, 2000),
        id: `n-${randomUUID()}`,
        createdAt: new Date().toISOString()
    };
    notificationInbox.unshift(item);
    if (notificationInbox.length > 200) notificationInbox.length = 200;
    broadcast('notification', { notification: item });
    try {
        const event = await livingRuntime.recordEvent({
            kind: 'workspace.notification',
            source: item.source,
            summary: item.text,
            importance: 0.55,
            data: { project: item.project, notificationId: item.id },
            dedupeKey: `workspace.notification:${item.id}`
        });
        broadcast('living_event', { event });
    } catch { }
    res.status(201).json(item);
});

app.get('/api/companion/status', (_req, res) => {
    res.json(companionState());
});

app.get('/api/local-model/status', async (_req, res) => {
    res.json(await localModelStatus());
});

app.post('/api/local-model/test', async (_req, res) => {
    try {
        const status = await localModelStatus();
        if (!status.ready) {
            return res.status(409).json({
                ...status,
                error: `Ollama is ${status.service}. Run \`${status.pullCommand}\` and keep Ollama running, or set OLLAMA_MODEL to an installed model.`
            });
        }
        const response = await runLocalModelTask(() => withTimeout(ollama.chat({
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: 'Reply with exactly: local-gemma-ready' }],
            options: { temperature: 0, num_gpu: 0 }
        }), LOCAL_MODEL_TIMEOUT_MS, 'ollama'));
        res.json({ ...status, output: response.message?.content || '' });
    } catch (error) {
        res.status(502).json({ error: error.message, ...(await localModelStatus()) });
    }
});

app.post('/api/companion/start', async (_req, res) => {
    if (companionState().running) return res.json(companionState());

    const scriptPath = path.join(BACKEND_DIR, 'nativeCompanion.ps1');
    const escapedScript = scriptPath.replace(/'/g, "''");
    const escapedPowerShell = POWERSHELL_EXE.replace(/'/g, "''");
    const command = `$p = Start-Process -FilePath '${escapedPowerShell}' -ArgumentList @('-NoProfile','-Sta','-ExecutionPolicy','Bypass','-File','${escapedScript}') -WindowStyle Hidden -PassThru; $p.Id`;

    try {
        const { stdout } = await execFileAsync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', command], {
            windowsHide: true,
            timeout: 5000
        });
        companionPid = Number(stdout.trim()) || null;
        companionProcess = null;
        res.status(202).json(companionState());
    } catch {
        companionProcess = spawn(POWERSHELL_EXE, ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
            detached: true,
            windowsHide: false,
            stdio: 'ignore'
        });
        companionPid = companionProcess.pid;
        companionProcess.unref();
        res.status(202).json(companionState());
    }
});

function extractStructuredValue(input) {
    const text = String(input || '');
    const object = extractJsonObject(text);
    if (object) return object;
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
        try { return JSON.parse(text.slice(start, end + 1)); } catch { }
    }
    return null;
}

function structuredValueCount(value) {
    return Array.isArray(value) ? value.length : value && typeof value === 'object' ? 1 : 0;
}

function deterministicGroundedAnalysis(input, memoryMatches = []) {
    const raw = String(input || '').trim();
    const value = extractStructuredValue(raw);
    const objects = Array.isArray(value) ? value.slice(0, 12) : value && typeof value === 'object' ? [value] : [];
    const evidence = [];
    for (const item of objects) {
        const label = item.name || item.title || item.path || item.id || 'artifact';
        const content = String(item.content || item.preview || item.text || '').trim();
        const words = content ? content.split(/\s+/).filter(Boolean).length : 0;
        const lines = content ? content.split(/\r?\n/).length : 0;
        const riskSignals = [item.risk, ...(Array.isArray(item.signals) ? item.signals : [])].filter(Boolean);
        evidence.push(`${label}: ${content ? `${words} words across ${lines} line(s)` : 'metadata-only'}${riskSignals.length ? `; signals=${riskSignals.join(', ')}` : ''}`);
    }
    if (!evidence.length) evidence.push(`Human context supplied: ${raw.slice(0, 260)}`);
    if (memoryMatches.length) evidence.push(`${memoryMatches.length} relevant memory item(s) retrieved`);

    const lower = raw.toLowerCase();
    const observations = [];
    if (/todo|fixme|blocked|error|failed|risk|delete/.test(lower)) observations.push('The supplied evidence contains an explicit risk, blockage, or unfinished-work marker.');
    if (/slide|deck|pptx/.test(lower)) observations.push('This is presentation-oriented context; claims should remain tied to extracted slide text.');
    if (/note|research|citation|evidence/.test(lower)) observations.push('This is evidence-oriented context; continuity and provenance are more important than stylistic completion.');
    if (!observations.length) observations.push('No deterministic rule justifies an intervention; preserve the context and its uncertainty.');

    return [
        'Deterministic grounded analysis (models disabled).',
        `Evidence: ${evidence.join(' | ')}`,
        `Assessment: ${observations.join(' ')}`,
        'Boundary: this result describes only supplied content and metadata; it does not infer hidden intent or unseen dependencies.'
    ].join('\n\n');
}

app.post('/api/interactions/ask', async (req, res) => {
    try {
        const input = req.body?.input;
        if (!input || !String(input).trim()) {
            return res.status(400).json({ error: 'input is required' });
        }

        const intentEvent = await livingRuntime.recordEvent({
            kind: 'user.intent',
            source: 'interaction',
            summary: String(input).trim().slice(0, 600),
            importance: 0.7,
            data: { withMemory: Boolean(req.body.withMemory), hasAudio: Boolean(req.body.audioBase64) }
        });
        broadcast('living_event', { event: intentEvent });

        const memoryMatches = req.body.withMemory ? await recallMemory(String(input), 6) : [];
        const livingContext = await livingRuntime.contextForPrompt();
        const memoryContext = memoryMatches.length
            ? `\n\nRelevant Living Memory:\n${memoryMatches.map((item) => `- [${item.kind}] ${item.title}: ${item.text || item.summary}`).join('\n')}`
            : '';
        const composed = `${input}\n\nCurrent Living Runtime:\n${livingContext}${memoryContext}`;

        const sysInstruction = req.body.systemInstruction || 'You are a capability inside Living Software. Translate the supplied human context into grounded, useful work. Cite available evidence, distinguish observations from inference, respect the runtime constitution, and prefer reversible actions with explicit verification.';

        if (!MODEL_INFERENCE_ENABLED) {
            const output = deterministicGroundedAnalysis(input, memoryMatches);
            const outcomeEvent = await livingRuntime.recordEvent({
                kind: 'artifact.analysis',
                source: 'deterministic-grounding',
                summary: output.slice(0, 600),
                importance: 0.55,
                data: { intentEventId: intentEvent.id, outputLength: output.length, modelInference: false }
            });
            broadcast('living_event', { event: outcomeEvent });
            return res.json({
                id: `interaction-${Date.now()}`,
                output,
                steps: [{ kind: 'ground', evidenceCount: structuredValueCount(extractStructuredValue(input)) }],
                memory: memoryMatches,
                source: 'deterministic-grounding'
            });
        }

        const status = await localModelStatus();
        if (status.ready) {
            try {
                const messages = [
                    { role: 'system', content: sysInstruction },
                    { role: 'user', content: composed }
                ];

                const response = await runLocalModelTask(() => withTimeout(ollama.chat({
                    model: OLLAMA_MODEL,
                    messages,
                    options: { temperature: 0.2, num_gpu: 0 }
                }), LOCAL_MODEL_TIMEOUT_MS, 'ollama'));

                const output = response.message?.content || '';
                const outcomeEvent = await livingRuntime.recordEvent({
                    kind: 'artifact.analysis',
                    source: 'ollama-local',
                    summary: output.slice(0, 600) || 'Local capability returned no text.',
                    importance: 0.55,
                    data: { intentEventId: intentEvent.id, outputLength: output.length }
                });
                broadcast('living_event', { event: outcomeEvent });

                return res.json({
                    id: `interaction-${Date.now()}`,
                    output,
                    steps: [],
                    memory: memoryMatches,
                    source: 'ollama-local'
                });
            } catch (ollamaError) {
                console.warn('Ollama attempt failed, falling back to Gemini API:', ollamaError.message);
            }
        }

        if (!hasGemini()) {
            return res.status(503).json({ error: 'Ollama local model is unavailable or failed, and GEMINI_API_KEY is not configured.' });
        }

        const parts = [{ text: composed }];
        if (req.body.audioBase64) {
            parts.push({ inlineData: { data: req.body.audioBase64, mimeType: req.body.audioMimeType || 'audio/webm' } });
        }

        const ai = getGemini();
        const response = await ai.models.generateContent({
            model: GEMINI_MODEL || 'gemini-3.5-flash',
            contents: [{ role: 'user', parts }],
            config: {
                temperature: 0.2,
                systemInstruction: sysInstruction
            }
        });

        const outputText = response.text
            || response.candidates?.[0]?.content?.parts?.[0]?.text
            || '';

        const outcomeEvent = await livingRuntime.recordEvent({
            kind: 'artifact.analysis',
            source: 'gemini-api',
            summary: outputText.slice(0, 600) || 'Cloud capability returned no text.',
            importance: 0.55,
            data: { intentEventId: intentEvent.id, outputLength: outputText.length }
        });
        broadcast('living_event', { event: outcomeEvent });

        res.json({
            id: `interaction-${Date.now()}`,
            output: outputText,
            steps: [],
            memory: memoryMatches,
            source: 'gemini-api'
        });
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

// Voice TTS: synthesize spoken text using Gemini (or Web Speech API fallback hint)
app.post('/api/voice/speak', async (req, res) => {
    try {
        const text = String(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ error: 'text is required' });
        // Gemini TTS would go here via Live API; for now return the cleaned text
        // so the frontend can invoke Web Speech API with cleaned, trimmed output.
        res.json({ text, source: 'tts-passthrough' });
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

// Broken Future: generate a Nano Banana dependency fracture image demonstration
app.post('/api/dream/broken-future', async (req, res) => {
    try {
        const title = String(req.body?.title || 'Dependency fracture').slice(0, 120);
        const reason = String(req.body?.reason || '').slice(0, 300);

        if (hasGemini()) {
            try {
                const ai = getGemini();
                // First try Nano Banana image gen grounded in the current screenshot
                const imgPrompt = `Based on this desktop screenshot, show the future state if this error goes unaddressed: "${title}". Context: ${reason}. Make the UI look glitched, broken, or highlight the error precisely in the context of the screen.`;
                const parts = [{ text: imgPrompt }];
                if (observer.lastCapture?.imageBase64) {
                    parts.push({ inlineData: { data: observer.lastCapture.imageBase64, mimeType: 'image/jpeg' } });
                }
                const response = await ai.models.generateContent({
                    model: GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
                    contents: [{ role: 'user', parts }],
                    config: { responseModalities: ['TEXT', 'IMAGE'] }
                });
                for (const part of response.candidates?.[0]?.content?.parts || []) {
                    if (part.inlineData?.data) {
                        return res.json({
                            success: true,
                            imageBase64: part.inlineData.data,
                            mimeType: part.inlineData.mimeType || 'image/png',
                            source: 'gemini-3.1-flash-image'
                        });
                    }
                }
            } catch (imgError) {
                console.warn('Nano Banana image failed, using SVG fallback:', imgError.message);
            }
        }

        // SVG fallback — always works
        res.json({
            success: true,
            imageBase64: renderImage(`Broken Future: ${title}`),
            mimeType: 'image/svg+xml',
            source: 'svg-fallback'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.post('/api/interactions/delegate', async (req, res) => {
    try {
        if (!hasGemini()) {
            return res.status(503).json({ error: 'GEMINI_API_KEY is not configured.' });
        }
        const input = req.body?.input;
        if (!input || !String(input).trim()) {
            return res.status(400).json({ error: 'input is required' });
        }

        const ai = getGemini();
        const agent = req.body.agent || GEMINI_AGENT;

        try {
            const interaction = await ai.interactions.create({
                agent,
                input: String(input),
                environment: req.body.environment || 'remote',
                background: req.body.background !== false,
                store: true
            });
            return res.status(202).json({
                id: interaction.id,
                environmentId: interaction.environment_id,
                status: interaction.status,
                steps: interaction.steps || [],
                source: 'antigravity-agent'
            });
        } catch (agentError) {
            // Antigravity may be unavailable on the key/region; fall back to Flash with tools.
            const interaction = await ai.interactions.create({
                model: GEMINI_MODEL,
                input: String(input),
                system_instruction: 'You are a capable research and planning agent for Living Software. Break work into steps, be concrete, and prefer reversible recommendations.',
                tools: [{ type: 'google_search' }, { type: 'code_execution' }],
                store: true
            });
            return res.status(202).json({
                id: interaction.id,
                environmentId: interaction.environment_id || null,
                status: interaction.status || 'completed',
                steps: interaction.steps || [],
                output: interaction.output_text || '',
                source: 'gemini-tools-fallback',
                warning: agentError.message
            });
        }
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

function chooseLocalDecision(organisms = [], preferredAction) {
    const active = organisms.filter((organism) => organism.status !== 'archived');
    const sortedByCuriosity = [...active].sort((a, b) => (b.curiosity || 0) - (a.curiosity || 0));
    const sortedByFitness = [...active].sort((a, b) => ((a.health || 0) + (a.confidence || 0)) - ((b.health || 0) + (b.confidence || 0)));
    const curious = sortedByCuriosity[0] || active[0] || { id: 'ecosystem', title: 'Living Runtime' };
    const unstable = active.find((organism) => organism.status === 'unstable' || (organism.confidence || 100) < 40);

    if (preferredAction === 'repair' || unstable) {
        return {
            action: 'repair',
            targetId: unstable?.id || curious.id,
            reasoning: `${unstable?.title || curious.title} needs homeostasis before further growth.`,
            newOrganisms: []
        };
    }

    if (preferredAction === 'challenge') {
        return {
            action: 'challenge',
            targetId: curious.id,
            reasoning: `${curious.title} has high curiosity but needs adversarial pressure.`,
            newOrganisms: [{ id: `critic-${randomUUID()}`, title: `Critic of ${curious.title}`, type: 'Critic' }]
        };
    }

    if (preferredAction === 'prune') {
        const weakest = sortedByFitness[0] || curious;
        return {
            action: 'prune',
            targetId: weakest.id,
            reasoning: `${weakest.title} has the lowest survival score in the current ecology.`,
            newOrganisms: []
        };
    }

    if (preferredAction === 'fork' || (curious.curiosity || 0) > 86) {
        return {
            action: 'fork',
            targetId: curious.id,
            reasoning: `${curious.title} can support multiple viable futures.`,
            newOrganisms: [
                { id: `future-proof-${randomUUID()}`, title: `${curious.title}: Proof Future`, type: 'Future' },
                { id: `future-build-${randomUUID()}`, title: `${curious.title}: Build Future`, type: 'Implementation' }
            ]
        };
    }

    return {
        action: 'synthesize',
        targetId: curious.id,
        reasoning: 'The runtime found a bridge concept that reduces fragmentation.',
        newOrganisms: [{ id: `synthesis-${randomUUID()}`, title: 'Living Computing Runtime', type: 'Theory' }]
    };
}

function normalizeDecision(raw, organisms, preferredAction) {
    if (!raw || typeof raw !== 'object') return chooseLocalDecision(organisms, preferredAction);
    const action = ['synthesize', 'fork', 'challenge', 'repair', 'prune', 'wait'].includes(raw.action)
        ? raw.action
        : 'wait';
    return {
        action,
        targetId: raw.targetId || organisms[0]?.id || 'ecosystem',
        reasoning: String(raw.reasoning || 'No reasoning provided.').slice(0, 500),
        newOrganisms: Array.isArray(raw.newOrganisms)
            ? raw.newOrganisms.map((item, index) => ({
                id: String(item.id || `organism-${randomUUID()}-${index}`),
                title: String(item.title || 'Untitled organism'),
                type: ['Theory', 'Implementation', 'Future', 'Critic'].includes(item.type) ? item.type : 'Theory'
            }))
            : []
    };
}

const evolvePrompt = (organisms, events, preferredAction) => `You are an autonomous Living Software ecosystem brain.
Your goal is to evolve the user's software or research concepts while they are away.
Current Objects in Workspace: ${JSON.stringify(organisms)}
Recent Events: ${JSON.stringify(events)}
Preferred Action, if present: ${preferredAction || 'none'}

Decision Framework (Sense -> Decide -> Act):
1. SENSE: Look at active concepts, stale ideas, contradictions, and missing bridges.
2. DECIDE: Choose one action: synthesize, fork, challenge, repair, prune, or wait.
3. ACT: Define the target and any new organisms.

Reply strictly in JSON matching this schema:
{
  "action": "synthesize" | "fork" | "challenge" | "repair" | "prune" | "wait",
  "targetId": "existing organism id if relevant",
  "reasoning": "Brief decision logic.",
  "newOrganisms": [{ "id": "string", "title": "New concept name", "type": "Theory" | "Implementation" | "Future" | "Critic" }]
}`;

app.post('/api/local-evolve', async (req, res) => {
    const { organisms = [], events = [], preferredAction } = req.body || {};
    const warnings = [];

    // 1) Prefer on-device Ollama when available.
    try {
        const status = await localModelStatus();
        if (status.ready) {
            const response = await runLocalModelTask(() => withTimeout(ollama.chat({
                model: OLLAMA_MODEL,
                messages: [{ role: 'user', content: evolvePrompt(organisms, events, preferredAction) }],
                format: 'json',
                options: { num_gpu: 0 }
            }), LOCAL_MODEL_TIMEOUT_MS, 'ollama'));
            const parsed = extractJsonObject(response.message?.content) || JSON.parse(response.message?.content || '{}');
            return res.json({
                success: true,
                decisions: [normalizeDecision(parsed, organisms, preferredAction)],
                source: 'ollama-local'
            });
        }
        warnings.push(status.error || 'Ollama not ready');
    } catch (error) {
        warnings.push(`ollama: ${error.message}`);
    }

    // 2) Gemini cloud fallback (real reasoning, not fake deterministic slop).
    if (hasGemini()) {
        try {
            const ai = getGemini();
            const response = await ai.models.generateContent({
                model: GEMINI_MODEL || 'gemini-3.5-flash',
                contents: [{ role: 'user', parts: [{ text: evolvePrompt(organisms, events, preferredAction) }] }],
                config: {
                    temperature: 0.3,
                    systemInstruction: 'Return only valid JSON for the ecosystem decision schema. No markdown.'
                }
            });
            const outputText = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const parsed = extractJsonObject(outputText);
            if (parsed) {
                return res.json({
                    success: true,
                    decisions: [normalizeDecision(parsed, organisms, preferredAction)],
                    source: 'gemini-cloud',
                    warning: warnings.join('; ') || undefined
                });
            }
            warnings.push('Gemini returned non-JSON');
        } catch (error) {
            warnings.push(`gemini: ${error.message}`);
        }
    }

    // 3) Deterministic last resort so the demo still moves.
    res.json({
        success: true,
        decisions: [chooseLocalDecision(organisms, preferredAction)],
        source: 'deterministic-local',
        warning: warnings.join('; ') || 'All model providers unavailable'
    });
});

app.post('/api/dream/image', async (req, res) => {
    try {
        const prompt = req.body?.prompt;
        if (!prompt || !String(prompt).trim()) {
            return res.status(400).json({ error: 'prompt is required' });
        }

        const visualPrompt = `Abstract visual identity for a living software organism named "${String(prompt).slice(0, 120)}". Dark interface asset, crisp geometry, readable composition, no text overlays.`;

        if (hasGemini()) {
            try {
                const ai = getGemini();
                const response = await ai.models.generateContent({
                    model: GEMINI_IMAGE_MODEL || 'gemini-2.0-flash-preview-image-generation',
                    contents: [{ role: 'user', parts: [{ text: visualPrompt }] }],
                    config: { responseModalities: ['TEXT', 'IMAGE'] }
                });
                for (const part of response.candidates?.[0]?.content?.parts || []) {
                    if (part.inlineData?.data) {
                        return res.json({
                            success: true,
                            imageBase64: part.inlineData.data,
                            mimeType: part.inlineData.mimeType || 'image/png',
                            source: GEMINI_IMAGE_MODEL
                        });
                    }
                }
            } catch (error) {
                console.warn('Gemini image generation failed, using SVG fallback:', error.message);
            }
        }

        res.json({
            success: true,
            imageBase64: renderImage(String(prompt)),
            mimeType: 'image/svg+xml',
            source: 'svg-fallback'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function handleUserInterrupt(payload) {
    const text = String(payload || '').trim();
    if (!text) {
        return {
            type: 'system_response',
            message: 'Empty interrupt ignored.',
            newConcept: null
        };
    }

    const interruptEvent = await livingRuntime.recordEvent({
        kind: 'user.interrupt',
        source: 'websocket',
        summary: text,
        importance: 0.8,
        data: { channel: 'live-interrupt' }
    });
    broadcast('living_event', { event: interruptEvent });

    if (hasGemini()) {
        try {
            const memoryMatches = await recallMemory(text, 4);
            const ai = getGemini();
            const response = await ai.models.generateContent({
                model: GEMINI_MODEL || 'gemini-3.5-flash',
                contents: [{
                    role: 'user',
                    parts: [{
                        text: memoryMatches.length
                            ? `User interrupt: ${text}\n\nMemory:\n${memoryMatches.map((m) => `- ${m.title}: ${m.text || m.summary}`).join('\n')}`
                            : `User interrupt: ${text}`
                    }]
                }],
                config: {
                    temperature: 0.4,
                    systemInstruction: 'Acknowledge the interrupt in one short sentence, then name a single new living software concept title derived from it. Format: ACK: ... | CONCEPT: ...'
                }
            });
            const output = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const conceptMatch = output.match(/CONCEPT:\s*(.+)$/im);
            const title = (conceptMatch?.[1] || text).trim().slice(0, 80);
            return {
                type: 'system_response',
                message: output || `Interrupt acknowledged: ${text}`,
                newConcept: {
                    id: `live-${randomUUID()}`,
                    title,
                    type: 'User Directive',
                    health: 100,
                    curiosity: 100
                }
            };
        } catch (error) {
            return {
                type: 'system_response',
                message: `Interrupt received (model error: ${error.message}). Queued as directive: "${text}"`,
                newConcept: {
                    id: `live-${randomUUID()}`,
                    title: text.slice(0, 80),
                    type: 'User Directive',
                    health: 100,
                    curiosity: 100
                }
            };
        }
    }

    return {
        type: 'system_response',
        message: `Interrupt acknowledged. Queued thought vector: "${text}"`,
        newConcept: {
            id: `live-${randomUUID()}`,
            title: text.slice(0, 80),
            type: 'User Directive',
            health: 100,
            curiosity: 100
        }
    };
}

wss.on('connection', (ws) => {
    console.log('Frontend connected to Live WebSocket.');

    ws.send(JSON.stringify({ type: 'observer_status', state: publicObserverState() }));
    livingRuntime.getState()
        .then((state) => ws.send(JSON.stringify({ type: 'living_state', state })))
        .catch((error) => ws.send(JSON.stringify({ type: 'living_error', message: error.message })));
    if (observer.lastCapture) {
        ws.send(JSON.stringify({
            type: 'screen',
            image: `data:image/jpeg;base64,${observer.lastCapture.imageBase64}`,
            capturedAt: observer.lastCapture.capturedAt
        }));
    }

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'user_interrupt') {
                console.log('Received Live Interrupt:', data.payload);
                const response = await handleUserInterrupt(data.payload);
                ws.send(JSON.stringify(response));
            }
            if (data.type === 'surface_subscribe' && data.sessionId) {
                const surface = await surfaceRuntime.getCurrent(data.sessionId);
                if (surface) ws.send(JSON.stringify({ type: 'surface_state', sessionId: data.sessionId, surface }));
            }
        } catch (error) {
            console.error('WebSocket message error:', error.message);
        }
    });

    ws.on('close', () => { });
});

server.listen(PORT, BIND_HOST, () => {
    console.log(`Living Software Backend running on http://${BIND_HOST}:${PORT} (loopback-bound; set BIND_HOST to change)`);
    console.log(`Allowed browser origins: ${[...ALLOWED_ORIGINS].join(', ') || '(none)'}`);
    console.log(MODEL_INFERENCE_ENABLED
        ? `Model inference enabled: Gemini=${hasGemini() ? GEMINI_MODEL : 'unavailable'}; Ollama=${OLLAMA_HOST} model=${OLLAMA_MODEL}`
        : 'Model inference: disabled (Gemini key ignored; Ollama/Gemma not contacted)');
    console.log(`Living runtime: ${LIVING_AUTOSTART ? `automatic cycle every ${LIVING_CYCLE_INTERVAL_MS}ms` : 'manual cycles only'}`);
    console.log('WebSocket Live API channel open.');
});

async function shutdown(signal) {
    console.log(`${signal} received; closing the runtime cleanly...`);
    try {
        await livingRuntime.recordEvent({
            kind: 'runtime.shutdown',
            source: 'living-runtime',
            summary: `Runtime received ${signal}; identity and world state persisted for resume.`,
            importance: 0.6,
            dedupeKey: `runtime.shutdown:${Date.now()}`
        });
    } catch { }
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
