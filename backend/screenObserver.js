import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { extractJsonObject, GEMINI_API_KEY, GEMINI_MODEL, getGemini, hasGemini, MODEL_INFERENCE_ENABLED, OBSERVER_PREFER_LOCAL_VISION, POWERSHELL_EXE } from './config.js';

const execFileAsync = promisify(execFile);

const CAPTURE_SCRIPT = [
    'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class DpiHelper { [DllImport(`\\"user32.dll\\"`)] public static extern bool SetProcessDPIAware(); }"',
    '[DpiHelper]::SetProcessDPIAware()',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$screen = [System.Windows.Forms.Screen]::PrimaryScreen',
    '$bounds = $screen.Bounds',
    '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)',
    '$stream = New-Object System.IO.MemoryStream',
    '$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)',
    '$graphics.Dispose()',
    '$bitmap.Dispose()',
    '[Convert]::ToBase64String($stream.ToArray())',
    '$stream.Dispose()'
].join('; ');

const QUIET_ANALYSIS = {
    shouldIntervene: false,
    severity: 'quiet',
    application: 'unknown',
    title: 'Desktop state observed',
    reason: 'No grounded reason to interrupt the user.',
    stateSummary: 'The visible desktop was observed without a high-confidence intervention.',
    activity: 'unknown',
    signals: [],
    evidence: [],
    actions: [],
    spoken: ''
};

let geminiVisionProbe = { checkedAt: 0, result: null };

async function probeGeminiVision() {
    if (geminiVisionProbe.result && Date.now() - geminiVisionProbe.checkedAt < 60000) {
        return geminiVisionProbe.result;
    }

    let result;
    try {
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
            headers: { 'x-goog-api-key': GEMINI_API_KEY },
            signal: AbortSignal.timeout(4000)
        });
        result = response.ok
            ? { connected: true, error: null }
            : { connected: false, error: `Gemini vision credentials were rejected (HTTP ${response.status}).` };
    } catch (error) {
        result = { connected: false, error: `Gemini vision probe failed: ${String(error.message || error).slice(0, 180)}` };
    }
    geminiVisionProbe = { checkedAt: Date.now(), result };
    return result;
}

export async function captureDesktop() {
    if (process.platform !== 'win32') {
        throw new Error('The current observer implementation requires Windows.');
    }

    const { stdout } = await execFileAsync(POWERSHELL_EXE, [
        '-NoProfile',
        '-Sta',
        '-ExecutionPolicy', 'Bypass',
        '-Command', CAPTURE_SCRIPT
    ], { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 20_000 });

    const imageBase64 = stdout.trim();
    if (!imageBase64 || imageBase64.length < 100) {
        throw new Error('Screen capture returned an empty image.');
    }

    return {
        imageBase64,
        fingerprint: createHash('sha256').update(imageBase64).digest('hex'),
        capturedAt: new Date().toISOString()
    };
}

export async function detectLocalModel() {
    if (!MODEL_INFERENCE_ENABLED) {
        return {
            connected: false,
            provider: 'inference-disabled',
            model: null,
            models: [],
            visionCapable: false,
            error: 'Model inference is disabled by runtime policy.'
        };
    }

    // Cloud vision is the safe default when configured. Loading a large local
    // vision projector can exhaust constrained desktops and starve text work.
    if (hasGemini() && !OBSERVER_PREFER_LOCAL_VISION) {
        const probe = await probeGeminiVision();
        return {
            connected: probe.connected,
            provider: 'google-genai',
            model: GEMINI_MODEL,
            models: [GEMINI_MODEL],
            visionCapable: probe.connected,
            error: probe.error
        };
    }

    // Local vision remains an explicit preference or an offline fallback.
    try {
        const { ollama, OLLAMA_MODEL } = await import('./config.js');
        const response = await fetch(`${process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'}/api/tags`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
            const data = await response.json();
            const models = (data.models || []).map((m) => m.name);
            if (models.some(m => m === OLLAMA_MODEL || m.startsWith(OLLAMA_MODEL))) {
                return {
                    connected: true,
                    provider: 'ollama',
                    model: OLLAMA_MODEL,
                    models,
                    visionCapable: true // Gemma 4 is natively multimodal
                };
            }
        }
    } catch {
        // Fallback to gemini detection
    }

    const connected = hasGemini();
    return {
        connected,
        provider: 'google-genai',
        model: GEMINI_MODEL,
        models: [GEMINI_MODEL],
        visionCapable: connected
    };
}

function normalizeAnalysis(parsed) {
    if (!parsed || typeof parsed !== 'object') return { ...QUIET_ANALYSIS };

    const severity = ['quiet', 'notice', 'warning', 'critical'].includes(parsed.severity)
        ? parsed.severity
        : (parsed.shouldIntervene ? 'notice' : 'quiet');

    return {
        shouldIntervene: Boolean(parsed.shouldIntervene) && severity !== 'quiet',
        severity,
        application: String(parsed.application || 'unknown').slice(0, 80),
        title: String(parsed.title || 'Screen observation').slice(0, 160),
        reason: String(parsed.reason || '').slice(0, 600),
        stateSummary: String(parsed.stateSummary || parsed.reason || 'Visible desktop state observed.').slice(0, 800),
        activity: String(parsed.activity || 'unknown').slice(0, 160),
        signals: Array.isArray(parsed.signals) ? parsed.signals.slice(0, 6).map((signal) => ({
            kind: ['progress', 'change', 'intent', 'opportunity', 'risk', 'blockage', 'completion', 'unknown'].includes(signal?.kind) ? signal.kind : 'unknown',
            summary: String(signal?.summary || '').slice(0, 240),
            confidence: Math.max(0, Math.min(1, Number(signal?.confidence) || 0)),
            evidence: Array.isArray(signal?.evidence) ? signal.evidence.map(String).slice(0, 3) : []
        })).filter((signal) => signal.summary) : [],
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String).slice(0, 3) : [],
        actions: Array.isArray(parsed.actions) ? parsed.actions.map(String).slice(0, 3) : [],
        spoken: String(parsed.spoken || '').slice(0, 280)
    };
}

export async function analyzeDesktop(imageBase64, model = GEMINI_MODEL) {
    if (!MODEL_INFERENCE_ENABLED) throw new Error('Model inference is disabled by runtime policy.');
    const prompt = `You are the grounded perception organ of Living Software. Inspect this Windows desktop screenshot and describe the visible state of the user's world. Your job is broader than anomaly detection: identify visible progress, changes, apparent intent, opportunities, blockages, completions, and risks. Never invent hidden files, dependencies, prior actions, or user goals.

Return only one valid JSON object matching this schema:
{
  "stateSummary": "factual summary of the visible desktop",
  "activity": "what the user appears to be doing, or unknown",
  "application": "primary visible app",
  "signals": [
    {"kind": "progress|change|intent|opportunity|risk|blockage|completion|unknown", "summary": "grounded signal", "confidence": 0.0, "evidence": ["visible clue"]}
  ],
  "shouldIntervene": false,
  "severity": "quiet|notice|warning|critical",
  "title": "brief factual headline",
  "reason": "why interruption is or is not justified",
  "evidence": ["up to 3 visible facts supporting intervention"],
  "actions": ["up to 3 safe, reversible next steps"],
  "spoken": "one short sentence only when intervention is justified"
}
Observe ordinary useful state even when shouldIntervene is false. Intervene only with high-confidence visible evidence: an error/crash/warning, destructive action in progress, blocked or broken application, or a clear request for pushback. A change, opportunity, or inferred intent is normally a quiet signal, not an interruption. If uncertainty is high, say unknown and stay quiet.`;

    try {
        const local = await detectLocalModel();
        let outputText = '';

        if (local.provider === 'ollama') {
            const { ollama, OLLAMA_MODEL, runLocalModelTask, withTimeout, LOCAL_MODEL_TIMEOUT_MS } = await import('./config.js');
            const response = await runLocalModelTask(() => withTimeout(ollama.chat({
                model: OLLAMA_MODEL,
                messages: [{
                    role: 'user',
                    content: prompt,
                    images: [imageBase64]
                }],
                format: 'json',
                options: { temperature: 0.15, num_gpu: 0 }
            }), LOCAL_MODEL_TIMEOUT_MS, 'ollama-vision'));
            outputText = response.message?.content || '';
        } else {
            if (!hasGemini()) {
                throw new Error('Gemini API is not configured (missing GEMINI_API_KEY) and local model is unavailable.');
            }
            const ai = getGemini();
            const response = await ai.models.generateContent({
                model: model || 'gemini-3.5-flash',
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { text: prompt },
                            { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } }
                        ]
                    }
                ],
                config: { temperature: 0.15 }
            });
            outputText = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }

        const parsed = extractJsonObject(outputText);
        if (!parsed) {
            console.warn('[ScreenObserver] Unparsed response:', outputText.slice(0, 50));
            return {
                ...QUIET_ANALYSIS,
                title: 'Unparsed model response',
                reason: outputText.slice(0, 400)
            };
        }
        console.log('[ScreenObserver] Analyzed frame. shouldIntervene:', parsed.shouldIntervene, 'Reason:', parsed.reason?.slice(0, 80));
        return normalizeAnalysis(parsed);
    } catch (error) {
        console.error(`[ScreenObserver] Error during analysis: ${error.message}`);
        throw new Error(`Screen analysis failed: ${error.message}`);
    }
}
