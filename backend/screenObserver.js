import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { extractJsonObject, GEMINI_MODEL, getGemini, hasGemini, POWERSHELL_EXE } from './config.js';

const execFileAsync = promisify(execFile);

const CAPTURE_SCRIPT = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)',
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
    title: 'No intervention needed',
    reason: 'No grounded inconsistency was detected on screen.',
    evidence: [],
    actions: [],
    spoken: ''
};

export async function captureDesktop() {
    if (process.platform !== 'win32') {
        throw new Error('The current observer implementation requires Windows.');
    }

    const { stdout } = await execFileAsync(POWERSHELL_EXE, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', CAPTURE_SCRIPT
    ], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });

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
    const connected = hasGemini();
    return {
        connected,
        provider: 'google-interactions',
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
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String).slice(0, 3) : [],
        actions: Array.isArray(parsed.actions) ? parsed.actions.map(String).slice(0, 3) : [],
        spoken: String(parsed.spoken || '').slice(0, 280)
    };
}

export async function analyzeDesktop(imageBase64, model = GEMINI_MODEL) {
    if (!hasGemini()) {
        throw new Error('Gemini API is not configured (missing GEMINI_API_KEY).');
    }

    const prompt = `You are the local perception layer of Living Software. Inspect this Windows desktop screenshot.
Return only JSON with this schema:
{
  "shouldIntervene": boolean,
  "severity": "quiet" | "notice" | "warning" | "critical",
  "application": "short app name",
  "title": "short factual headline",
  "reason": "what changed or appears risky, grounded only in visible evidence",
  "evidence": ["up to 3 visible facts"],
  "actions": ["up to 3 safe next actions"],
  "spoken": "one concise sentence to say aloud"
}
Intervene only for a visible inconsistency, destructive action, error, broken workflow, or a clear cross-document question. Do not invent hidden dependencies. If there is no grounded reason, set shouldIntervene false and severity quiet.`;

    try {
        const ai = getGemini();
        const response = await ai.interactions.create({
            model: model || GEMINI_MODEL,
            input: [
                { type: 'text', text: prompt },
                { type: 'image', data: imageBase64, mime_type: 'image/jpeg' }
            ],
            store: false,
            generation_config: { temperature: 0.15 }
        });

        const parsed = extractJsonObject(response.output_text);
        if (!parsed) {
            // Model sometimes returns prose; treat as quiet rather than crashing the observer loop.
            return {
                ...QUIET_ANALYSIS,
                title: 'Unparsed model response',
                reason: String(response.output_text || '').slice(0, 400)
            };
        }
        return normalizeAnalysis(parsed);
    } catch (error) {
        throw new Error(`Gemini screen analysis failed: ${error.message}`);
    }
}
