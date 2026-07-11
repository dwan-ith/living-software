import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import { renderImage } from './mockNB2.js';
import ollama from 'ollama';
import { WebSocketServer } from 'ws';
import http from 'http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let companionProcess = null;

const observer = {
    running: true,
    capturing: false,
    intervalMs: 3500,
    analysisCooldownMs: 15000,
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
        privacy: 'Screenshots are held in memory and sent to Gemini only for analysis.'
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
    observer.capturing = true;

    try {
        const capture = await captureDesktop();
        observer.lastCapture = capture;
        broadcast('screen', {
            image: `data:image/jpeg;base64,${capture.imageBase64}`,
            capturedAt: capture.capturedAt
        });

        const now = Date.now();
        const canAnalyze = forceAnalysis || now - observer.lastAnalysisAt >= observer.analysisCooldownMs;
        if (!canAnalyze) return;

        observer.lastAnalysisAt = now;
        observer.model = await detectLocalModel();
        broadcast('observer_status', { state: publicObserverState() });

        if (!observer.model.connected || !observer.model.visionCapable) {
            broadcast('analysis_skipped', {
                reason: observer.model.connected
                    ? `${observer.model.model || 'The selected model'} does not expose vision capability.`
                    : 'The Gemini API is not configured.'
            });
            return;
        }

        broadcast('analysis_started', { model: observer.model.model });
        const analysis = await analyzeDesktop(capture.imageBase64, observer.model.model);
        broadcast('analysis', { analysis, capturedAt: capture.capturedAt });

        if (analysis.shouldIntervene) {
            observer.lastIntervention = { ...analysis, createdAt: new Date().toISOString() };
            broadcast('intervention', { intervention: observer.lastIntervention });
        }
    } catch (error) {
        broadcast('observer_error', { message: error.message });
    } finally {
        observer.capturing = false;
    }
}

setInterval(() => observerTick(), 1000);

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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1' } });

const notificationInbox = [
    { id: 'n1', source: 'Calendar', project: 'Living Software', text: 'Hackathon presentation in 30 minutes', createdAt: new Date().toISOString() },
    { id: 'n2', source: 'GitHub', project: 'Living Software', text: 'Frontend build completed', createdAt: new Date(Date.now() - 120000).toISOString() },
    { id: 'n3', source: 'Messages', project: 'Living Software', text: 'Did you finish the demo slides?', createdAt: new Date(Date.now() - 240000).toISOString() }
];

function companionState() {
    return {
        running: Boolean(companionProcess && !companionProcess.killed && companionProcess.exitCode === null),
        pid: companionProcess?.pid || null,
        mode: 'native-windows-overlay'
    };
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
        res.json(await dependencySnapshot(path.resolve(__dirname, '..')));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/workspace/system', async (_req, res) => {
    try {
        res.json(await systemMap());
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
    const item = { id: `n-${Date.now()}`, createdAt: new Date().toISOString(), ...req.body };
    notificationInbox.unshift(item);
    broadcast('notification', { notification: item });
    res.status(201).json(item);
});

app.get('/api/companion/status', (_req, res) => {
    res.json(companionState());
});

app.post('/api/companion/start', (_req, res) => {
    if (companionState().running) return res.json(companionState());

    const scriptPath = path.join(__dirname, 'nativeCompanion.ps1');
    companionProcess = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath
    ], {
        detached: true,
        windowsHide: false,
        stdio: 'ignore'
    });
    companionProcess.unref();
    res.status(202).json(companionState());
});

app.post('/api/interactions/ask', async (req, res) => {
    try {
        const interaction = await ai.interactions.create({
            model: 'gemini-3.5-flash',
            input: req.body.input,
            system_instruction: req.body.systemInstruction || 'You are the reasoning layer for Living Software. Be concise, grounded, and propose only reversible actions.',
            previous_interaction_id: req.body.previousInteractionId,
            store: true
        });
        res.json({ id: interaction.id, output: interaction.output_text, steps: interaction.steps || [] });
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

app.post('/api/interactions/delegate', async (req, res) => {
    try {
        const interaction = await ai.interactions.create({
            agent: 'antigravity-preview-05-2026',
            input: req.body.input,
            environment: 'remote',
            background: true,
            store: true
        });
        res.status(202).json({ id: interaction.id, environmentId: interaction.environment_id, status: interaction.status, steps: interaction.steps || [] });
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
            newOrganisms: [{ id: `critic-${Date.now()}`, title: `Critic of ${curious.title}`, type: 'Critic' }]
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
                { id: `future-proof-${Date.now()}`, title: `${curious.title}: Proof Future`, type: 'Future' },
                { id: `future-build-${Date.now()}`, title: `${curious.title}: Build Future`, type: 'Implementation' }
            ]
        };
    }

    return {
        action: 'synthesize',
        targetId: curious.id,
        reasoning: 'The local runtime found a bridge concept that reduces fragmentation.',
        newOrganisms: [{ id: `synthesis-${Date.now()}`, title: 'Living Computing Runtime', type: 'Theory' }]
    };
}

app.post('/api/local-evolve', async (req, res) => {
    const { organisms = [], events = [], preferredAction } = req.body;

    try {
        const prompt = `You are an autonomous Living Software ecosystem brain running entirely on-device.
Your goal is to evolve the user's software or research concepts while they are away.
Current Objects in Workspace: ${JSON.stringify(organisms)}
Recent Events: ${JSON.stringify(events)}
Preferred Action, if present: ${preferredAction || 'none'}

Decision Framework (Sense -> Decide -> Act):
1. SENSE: Look at active concepts, stale ideas, contradictions, and missing bridges.
2. DECIDE: Choose one action: synthesize, fork, challenge, repair, prune, or wait.
3. ACT: Define the target and any new organisms.

Reply strictly in JSON format matching this schema:
{
  "action": "synthesize" | "fork" | "challenge" | "repair" | "prune" | "wait",
  "targetId": "existing organism id if relevant",
  "reasoning": "Brief decision logic.",
  "newOrganisms": [{ "id": "string", "title": "New concept name", "type": "Theory" | "Implementation" | "Future" | "Critic" }]
}`;

        const response = await ollama.chat({
            model: process.env.OLLAMA_MODEL || 'gemma',
            messages: [{ role: 'user', content: prompt }],
            format: 'json'
        });

        const decisionTree = JSON.parse(response.message.content);
        res.json({ success: true, decisions: [decisionTree], source: 'gemma-local' });
    } catch (error) {
        console.error('Local evolution failed:', error);
        res.json({
            success: true,
            decisions: [chooseLocalDecision(organisms, preferredAction)],
            source: 'deterministic-local',
            warning: error.message
        });
    }
});

app.post('/api/dream/image', async (req, res) => {
    try {
        const { prompt } = req.body;
        let resultImageBase64 = '';

        try {
            const response = await ai.models.generateImages({
                model: 'nano-banana-2-lite',
                prompt: `Abstract visual identity for a living software organism named "${prompt}". Dark interface asset, crisp geometry, readable composition, no text.`,
                number_of_images: 1,
                aspect_ratio: '16:9'
            });

            if (response.generatedImages && response.generatedImages.length > 0) {
                resultImageBase64 = response.generatedImages[0].image.imageBytes;
            }
        } catch {
            resultImageBase64 = renderImage(prompt);
        }

        res.json({ success: true, imageBase64: resultImageBase64 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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
                ws.send(JSON.stringify({
                    type: 'system_response',
                    message: `Interrupt acknowledged. Processing new thought vector: "${data.payload}"`,
                    newConcept: {
                        id: `live-${Date.now()}`,
                        title: data.payload,
                        type: 'User Directive',
                        health: 100,
                        curiosity: 100
                    }
                }));
            }
        } catch (error) {
            console.error(error);
        }
    });

    ws.on('close', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Living Software Backend running on http://localhost:${PORT}`);
    console.log('WebSocket Live API channel open.');
});
