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
    BACKEND_DIR,
    DATA_DIR,
    extractJsonObject,
    GEMINI_AGENT,
    GEMINI_IMAGE_MODEL,
    GEMINI_IMAGE_LITE_MODEL,
    GEMINI_MODEL,
    GEMINI_OMNI_MODEL,
    getGemini,
    hasGemini,
    OBSERVER_ANALYSIS_COOLDOWN_MS,
    OBSERVER_INTERVAL_MS,
    OLLAMA_BINARY_CANDIDATES,
    OLLAMA_HOST,
    OLLAMA_MODEL,
    ollama,
    pathExists,
    PORT,
    POWERSHELL_EXE,
    PROJECT_ROOT_DIR
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

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const execFileAsync = promisify(execFile);

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
    lastIntervention: null,
    model: { connected: false, model: null, models: [], visionCapable: false }
};

function publicObserverState() {
    return {
        running: observer.running,
        intervalMs: observer.intervalMs,
        lastCaptureAt: observer.lastCapture?.capturedAt || null,
        lastIntervention: observer.lastIntervention,
        model: observer.model,
        privacy: hasGemini()
            ? 'Screenshots are held in memory and sent to Gemini only for analysis.'
            : 'Screenshots are held in memory. Gemini is not configured, so analysis is skipped.'
    };
}

function broadcast(type, payload = {}) {
    const message = JSON.stringify({ type, ...payload });
    for (const client of wss.clients) {
        if (client.readyState === 1) client.send(message);
    }
}

async function observerTick(forceAnalysis = false) {
    if (!observer.running || observer.capturing) return;

    const now = Date.now();
    if (!forceAnalysis && observer.lastCaptureAt && now - observer.lastCaptureAt < observer.intervalMs) {
        return;
    }

    observer.capturing = true;
    observer.lastCaptureAt = now;

    try {
        const capture = await captureDesktop();
        observer.lastCapture = capture;
        broadcast('screen', {
            image: `data:image/jpeg;base64,${capture.imageBase64}`,
            capturedAt: capture.capturedAt
        });

        const canAnalyze = forceAnalysis || now - observer.lastAnalysisAt >= observer.analysisCooldownMs;
        if (!canAnalyze) return;

        observer.lastAnalysisAt = now;
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
        broadcast('analysis', { analysis, capturedAt: capture.capturedAt });

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
        }
    } catch (error) {
        broadcast('observer_error', { message: error.message });
    } finally {
        observer.capturing = false;
    }
}

// Poll frequently, but only capture on intervalMs (see observerTick).
setInterval(() => observerTick(false), 1000);

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
        res.json(await dependencySnapshot(PROJECT_ROOT_DIR));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/workspace/system', async (_req, res) => {
    try {
        const memory = await readMemory();
        res.json(await systemMap({
            projectRoot: PROJECT_ROOT_DIR,
            notificationCount: notificationInbox.length,
            memoryStats: memory.stats
        }));
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

app.get('/api/workspace/clipboard', async (_req, res) => {
    try {
        res.json(await readClipboard());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/workspace/notifications', (_req, res) => {
    res.json({ notifications: notificationInbox });
});

app.post('/api/workspace/notifications', (req, res) => {
    const body = req.body || {};
    if (!body.text && !body.title) {
        return res.status(400).json({ error: 'text or title is required' });
    }
    const item = {
        id: `n-${randomUUID()}`,
        createdAt: new Date().toISOString(),
        source: body.source || 'Local',
        project: body.project || 'Inbox',
        text: body.text || body.title,
        ...body
    };
    notificationInbox.unshift(item);
    if (notificationInbox.length > 200) notificationInbox.length = 200;
    broadcast('notification', { notification: item });
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
        const response = await ollama.chat({
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: 'Reply with exactly: local-gemma-ready' }],
            options: { temperature: 0 }
        });
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

app.post('/api/interactions/ask', async (req, res) => {
    try {
        if (!hasGemini()) {
            return res.status(503).json({ error: 'GEMINI_API_KEY is not configured.' });
        }
        const input = req.body?.input;
        if (!input || !String(input).trim()) {
            return res.status(400).json({ error: 'input is required' });
        }

        const memoryMatches = req.body.withMemory ? await recallMemory(String(input), 6) : [];
        const composed = memoryMatches.length
            ? `${input}\n\nRelevant Living Memory:\n${memoryMatches.map((item) => `- [${item.kind}] ${item.title}: ${item.text || item.summary}`).join('\n')}`
            : String(input);

        const sysInstruction = req.body.systemInstruction || 'You are the reasoning layer for Persistent Computer. Be concise, grounded, and propose only reversible actions.';

        const ai = getGemini();
        const response = await ai.models.generateContent({
            model: GEMINI_MODEL || 'gemini-3.5-flash',
            contents: [{ role: 'user', parts: [{ text: composed }] }],
            generationConfig: { temperature: 0.2 },
            systemInstruction: sysInstruction
        });

        const outputText = response.text
            || response.candidates?.[0]?.content?.parts?.[0]?.text
            || '';

        res.json({
            id: `interaction-${Date.now()}`,
            output: outputText,
            steps: [],
            memory: memoryMatches
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
                // gemini-omni-flash-preview: video/multimodal preview — uses Interactions API
                const prompt = `Create a dark dependency graph diagram showing a broken file relationship. Title: "${title}". Context: ${reason}. Style: dark UI, red error nodes, amber warning lines, minimal labels.`;
                const interaction = await ai.interactions.create({
                    model: GEMINI_OMNI_MODEL || 'gemini-omni-flash-preview',
                    input: prompt,
                    store: false
                });
                // Extract any image from the Omni Flash response
                const imageStep = (interaction.steps || []).find((s) => s.type === 'model_output');
                const imagePart = (imageStep?.content || []).find((b) => b.type === 'image' && b.data);
                if (imagePart) {
                    return res.json({
                        success: true,
                        imageBase64: imagePart.data,
                        mimeType: imagePart.mime_type || 'image/png',
                        source: 'gemini-omni-flash-preview'
                    });
                }
                // Fall through to Nano Banana image gen if Omni returned no image
            } catch (omniError) {
                console.warn('Omni Flash broken-future failed, trying Nano Banana:', omniError.message);
            }

            try {
                const ai = getGemini();
                const imgPrompt = `Abstract dark dependency fracture diagram: "${title}". Red error nodes, amber broken edges, dark background.`;
                const response = await ai.models.generateContent({
                    model: GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
                    contents: [{ role: 'user', parts: [{ text: imgPrompt }] }],
                    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
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
        const { renderImage } = await import('./mockNB2.js');
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
            const response = await ollama.chat({
                model: OLLAMA_MODEL,
                messages: [{ role: 'user', content: evolvePrompt(organisms, events, preferredAction) }],
                format: 'json'
            });
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
                model: GEMINI_MODEL || 'gemini-2.5-flash',
                contents: [{ role: 'user', parts: [{ text: evolvePrompt(organisms, events, preferredAction) }] }],
                generationConfig: { temperature: 0.3 },
                systemInstruction: 'Return only valid JSON for the ecosystem decision schema. No markdown.'
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
                const visualPrompt = `Abstract visual identity for a living software organism named "${String(prompt).slice(0, 120)}". Dark interface asset, crisp geometry, readable composition, no text overlays.`;
                const response = await ai.models.generateContent({
                    model: GEMINI_IMAGE_MODEL || 'gemini-2.0-flash-preview-image-generation',
                    contents: [{ role: 'user', parts: [{ text: visualPrompt }] }],
                    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
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

    if (hasGemini()) {
        try {
            const memoryMatches = await recallMemory(text, 4);
            const ai = getGemini();
            const response = await ai.models.generateContent({
                model: GEMINI_MODEL || 'gemini-2.5-flash',
                contents: [{
                    role: 'user',
                    parts: [{
                        text: memoryMatches.length
                            ? `User interrupt: ${text}\n\nMemory:\n${memoryMatches.map((m) => `- ${m.title}: ${m.text || m.summary}`).join('\n')}`
                            : `User interrupt: ${text}`
                    }]
                }],
                generationConfig: { temperature: 0.4 },
                systemInstruction: 'Acknowledge the interrupt in one short sentence, then name a single new living software concept title derived from it. Format: ACK: ... | CONCEPT: ...'
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
        } catch (error) {
            console.error('WebSocket message error:', error.message);
        }
    });

    ws.on('close', () => { });
});

server.listen(PORT, () => {
    console.log(`Living Software Backend running on http://localhost:${PORT}`);
    console.log(`Gemini: ${hasGemini() ? `configured (${GEMINI_MODEL})` : 'NOT configured'}`);
    console.log(`Ollama: ${OLLAMA_HOST} model=${OLLAMA_MODEL}`);
    console.log('WebSocket Live API channel open.');
});
