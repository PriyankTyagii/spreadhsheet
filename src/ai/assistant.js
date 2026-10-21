// ─────────────────────────────────────────────────────────────
//  One round trip: context → provider → parse → validate. Returns
//  a plain result object; the caller decides what to execute.
//  No React, and the only thing that knows the vendor is the
//  provider passed in.
// ─────────────────────────────────────────────────────────────
import { buildContext } from './context.js'
import { buildSystemPrompt } from './prompt.js'
import { parseAction } from './actions.js'

/**
 * @returns {Promise<
 *   | { ok: true, action: object, raw: string, context: object }
 *   | { ok: false, error: string, detail: string, kind?: string, raw?: string, action?: object }>}
 */
export async function ask({ provider, prompt, table, selection, history = [] }) {
    const context = buildContext(table, selection)
    const system = buildSystemPrompt(context)
    let response
    try {
        response = await provider.complete({ system, user: prompt, history })
    } catch (e) {
        return { ok: false, error: 'PROVIDER_ERROR', kind: e.kind ?? 'network', detail: e.message || String(e) }
    }
    const parsed = parseAction(response.text)
    if (!parsed.ok) return { ok: false, error: parsed.error, detail: parsed.detail, raw: response.text, action: parsed.action }
    return { ok: true, action: parsed.action, raw: response.text, context }
}
