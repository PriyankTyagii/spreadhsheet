// ─────────────────────────────────────────────────────────────
//  Raw model text → a validated action, or an error. Nothing may
//  reach the executor or the style system without passing here.
// ─────────────────────────────────────────────────────────────
import { ACTION_TYPES, QUERY_PLAN_SCHEMA, FORMAT_SHEET_SCHEMA, CLARIFY_SCHEMA } from './contract.js'
import { extractJson } from './parse.js'
import { validate } from './validate.js'

const SCHEMAS = {
    [ACTION_TYPES.QUERY]: QUERY_PLAN_SCHEMA,
    [ACTION_TYPES.FORMAT_SHEET]: FORMAT_SHEET_SCHEMA,
    [ACTION_TYPES.CLARIFY]: CLARIFY_SCHEMA,
}

/**
 * @param {string} text  raw provider output
 * @param {{ allow?: string[] }} [opts]  action types this caller accepts
 * @returns {{ ok: true, action: object } | { ok: false, error: string, detail: string, action?: object }}
 */
export function parseAction(text, opts = {}) {
    const parsed = extractJson(text)
    if (!parsed.ok) return { ok: false, error: 'INVALID_RESPONSE', detail: parsed.error }
    const action = parsed.value
    if (typeof action.type !== 'string') {
        return { ok: false, error: 'INVALID_RESPONSE', detail: '/type: is required', action }
    }
    const schema = SCHEMAS[action.type]
    // Any action we do not know — "mutation", "delete", "update" — is a
    // request to change data, and this assistant is read-only.
    if (!schema) return { ok: false, error: 'READ_ONLY', detail: `READ_ONLY:${action.type}`, action }
    if (opts.allow && !opts.allow.includes(action.type)) {
        return { ok: false, error: 'READ_ONLY', detail: `READ_ONLY:${action.type}`, action }
    }
    const problems = validate(schema, action)
    if (problems.length) {
        return { ok: false, error: 'INVALID_RESPONSE', detail: problems.join('; '), action }
    }
    return { ok: true, action }
}
