import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { extractJsonObject, GEMINI_MODEL, getGemini, hasGemini, POWERSHELL_EXE } from './config.js';

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
        '-Sta',
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
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String).slice(0, 3) : [],
        actions: Array.isArray(parsed.actions) ? parsed.actions.map(String).slice(0, 3) : [],
        spoken: String(parsed.spoken || '').slice(0, 280)
    };
}

export async function analyzeDesktop(imageBase64, model = GEMINI_MODEL) {
    if (!hasGemini()) {
        throw new Error('Gemini API is not configured (missing GEMINI_API_KEY).');
    }

    const prompt = `You are the local perception layer of Persistent Computer. Inspect this Windows desktop screenshot carefully.
Return ONLY a JSON object with this exact schema (no markdown fences):
{
  "shouldIntervene": boolean,
  "severity": "quiet" | "notice" | "warning" | "critical",
  "application": "short app name",
  "title": "short factual headline",
  "reason": "what changed or appears risky, grounded only in visible evidence",
  "evidence": ["up to 3 visible facts from the screenshot"],
  "actions": ["up to 3 safe next actions"],
  "spoken": "one concise sentence to say aloud"
}

Trigger shouldIntervene: true for ANY of the following visible conditions:
- An error dialog, warning dialog, crash, or exception message
- A destructive action in progress (delete, overwrite, format, uninstall)
- Broken or stalled UI (frozen spinner, empty list that should have data, disabled buttons that should be active)
- In a presentation or slide editor (PowerPoint, Google Slides, Keynote, LibreOffice Impress): any slide that contains text that VISIBLY does not fit the rest of the deck — random words, gibberish, placeholder text like "click to add title" or "lorem ipsum", a sentence written in a completely different tone, topic, or language from the other visible slides, or text that is clearly a test input ("asdfghjkl", "test123", "random text here")
- In any document or code editor: a section that looks out of place, a function that clearly does nothing, or commented-out code that looks like forgotten work
- A cross-document conflict visible on screen (two open files with contradictory state)
- A clipboard paste that does not match the target document's context

If a presentation is visible, read the text on the currently active slide carefully and compare it to any other visible slide content, the deck title, or the file name visible in the title bar. Flag it if the text looks inconsistent with the presentation's theme.

Do not invent dependencies not visible on screen. If there is no grounded reason, set shouldIntervene false and severity quiet.`;

    try {
        const ai = getGemini();
        // Use models.generateContent — the correct API for multimodal vision
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

        const outputText = response.text
            || response.candidates?.[0]?.content?.parts?.[0]?.text
            || '';

        const parsed = extractJsonObject(outputText);
        if (!parsed) {
            return {
                ...QUIET_ANALYSIS,
                title: 'Unparsed model response',
                reason: outputText.slice(0, 400)
            };
        }
        return normalizeAnalysis(parsed);
    } catch (error) {
        throw new Error(`Gemini screen analysis failed: ${error.message}`);
    }
}
