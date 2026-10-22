// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
//
//  The app never talks to a model directly — it talks to a
//  `provider`. A provider is any object with:
//
//      complete({ system, user, history }) => Promise<{ text, provider }>
//
//  `text` is the raw model output. You are expected to extract and
//  validate JSON from it yourself: models wrap JSON in prose, in code
//  fences, or return something that is not JSON at all.
//
//  Two providers ship with the repo:
//    • mock  — deterministic, offline, answers the prompts listed in
//              fixtures/ai-eval/*.json. Used by graders. The default.
//    • http  — YOURS. Call any LLM API you like (Anthropic, OpenAI,
//              Gemini, Ollama, …) with plain fetch(). Read the endpoint,
//              key and model from the VITE_AI_* env vars (.env.example).
//
//  Do not hard-code a vendor anywhere else: everything outside this
//  file must behave identically with either provider.
// ─────────────────────────────────────────────────────────────
import { createMockProvider } from './mockProvider.js'

/**
 * @typedef {{ role: 'user' | 'assistant', content: string }} ChatTurn
 * @typedef {{ system: string, user: string, history?: ChatTurn[] }} CompletionRequest
 * @typedef {{ text: string, provider: string }} CompletionResponse
 * @typedef {{ name: string, complete: (req: CompletionRequest) => Promise<CompletionResponse> }} Provider
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

/**
 * Any OpenAI-compatible chat-completions endpoint (Groq, OpenAI, OpenRouter,
 * Ollama, ...). Groq by default because it has a free tier and allows
 * browser requests (CORS).
 * @returns {Provider}
 */
export function createHttpProvider(config = {}) {
    const endpoint = config.endpoint || env.VITE_AI_ENDPOINT || 'https://api.groq.com/openai/v1/chat/completions'
    const apiKey = config.apiKey ?? env.VITE_AI_API_KEY
    const model = config.model || env.VITE_AI_MODEL || 'openai/gpt-oss-120b'
    const fetchImpl = config.fetch ?? ((...args) => fetch(...args))

    return {
        name: 'http',
        model,
        async complete(request) {
            if (!apiKey) throw providerError('auth', 'No API key: set VITE_AI_API_KEY in .env.local and restart the dev server.')
            const messages = [
                { role: 'system', content: request.system },
                ...(request.history || []),
                { role: 'user', content: request.user },
            ]
            let res
            try {
                res = await fetchImpl(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                    body: JSON.stringify({ model, messages, temperature: 0 }),
                })
            } catch (e) {
                throw providerError('network', `Network error: could not reach ${new URL(endpoint).host} (${e.message}).`)
            }
            if (!res.ok) {
                const body = await res.text().catch(() => '')
                let message = body
                try { message = JSON.parse(body)?.error?.message ?? body } catch { /* plain-text error body */ }
                if (res.status === 401 || res.status === 403) {
                    throw providerError('auth', `Authentication failed (${res.status}): ${message || 'check VITE_AI_API_KEY'}`)
                }
                if (res.status === 429) {
                    const retry = res.headers.get('retry-after')
                    throw providerError('rate_limit', `Rate limited (429)${retry ? `; retry after ${retry}s` : ''}: ${message}`)
                }
                throw providerError('http', `Provider returned ${res.status}: ${message.slice(0, 300)}`)
            }
            let data
            try {
                data = await res.json()
            } catch {
                throw providerError('http', 'Provider returned a response that is not JSON.')
            }
            const text = data?.choices?.[0]?.message?.content
            if (typeof text !== 'string') throw providerError('http', 'Provider response has no message content.')
            return { text, provider: 'http' }
        },
    }
}

/** Errors carry a `kind` (network | auth | rate_limit | http) the panel shows. */
function providerError(kind, message) {
    const e = new Error(message)
    e.kind = kind
    return e
}

/**
 * Pick a provider from VITE_AI_PROVIDER. Unknown values fall back to mock
 * so the app always boots.
 * @returns {Provider}
 */
export function createProvider(kind = env.VITE_AI_PROVIDER || 'mock') {
    if (kind === 'http') return createHttpProvider()
    return createMockProvider()
}
