import {
    extractJsonObject,
    GEMINI_MODEL,
    getGemini,
    hasGemini
} from './config.js';
import {
    surfaceCatalogForModel,
    SURFACE_RESPONSE_JSON_SCHEMA
} from './surfaceProtocol.js';

function compactTurns(turns = []) {
    return turns.slice(-8).map((turn) => ({ role: turn.role, text: String(turn.text || '').slice(0, 600) }));
}

export function createGeminiSurfaceGenerator() {
    return {
        available: () => hasGemini(),
        async compose({ session, utterance, focus, previousSurface, context }) {
            const ai = getGemini();
            const payload = {
                currentIntent: utterance || focus,
                focus,
                recentConversation: compactTurns(session?.turns),
                previousSurface,
                liveContext: context,
                componentCatalog: surfaceCatalogForModel()
            };
            const response = await ai.models.generateContent({
                model: GEMINI_MODEL,
                contents: [{
                    role: 'user',
                    parts: [{
                        text: `Compose the next task-specific interface from this live context.\n${JSON.stringify(payload)}`
                    }]
                }],
                config: {
                    temperature: 0.35,
                    maxOutputTokens: 5000,
                    responseMimeType: 'application/json',
                    responseJsonSchema: SURFACE_RESPONSE_JSON_SCHEMA,
                    systemInstruction: [
                        'You are the interface-composition runtime of a living computer.',
                        'Translate the user\'s present intent and changing context into the smallest useful interface.',
                        'Do not reproduce a general dashboard or fixed navigation.',
                        'Choose only registered components, bindings, and actions from the supplied catalog.',
                        'Bind components to supplied server data; never invent records, counts, capabilities, or outcomes.',
                        'Put proposals and approvals directly beside the context that makes them relevant.',
                        'Prefer 3-7 components. Include generation-trace so the phenotype is inspectable.',
                        'Return only the requested JSON structure. Do not reveal hidden reasoning.'
                    ].join(' ')
                }
            });
            const candidate = extractJsonObject(response.text);
            if (!candidate) throw new Error('Gemini returned no parseable surface document.');
            return { candidate, provider: 'gemini', model: GEMINI_MODEL };
        }
    };
}
