// ─────────────────────────────────────────────────────────────
//  Pull the first JSON object out of raw model text. Models wrap
//  JSON in prose and code fences; some add a second object or a
//  trailing comment. We scan for the first '{' and walk to its
//  matching '}' while respecting strings and escapes, so braces
//  inside string values do not confuse the match.
// ─────────────────────────────────────────────────────────────

/** @returns {{ ok: true, value: any } | { ok: false, error: string }} */
export function extractJson(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty response' }
    let from = 0
    let firstError = null
    while (true) {
        const start = text.indexOf('{', from)
        if (start < 0) return { ok: false, error: firstError ?? 'no JSON object in the response' }
        const end = matchBrace(text, start)
        if (end < 0) return { ok: false, error: firstError ?? 'unterminated JSON object' }
        try {
            const value = JSON.parse(text.slice(start, end + 1))
            if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value }
        } catch (e) {
            // Could be a brace in prose ("{like this}") before the real object: keep looking.
            firstError ??= `invalid JSON: ${e.message}`
        }
        from = start + 1
    }
}

function matchBrace(text, start) {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (inString) {
            if (ch === '\\') i++
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}') {
            depth--
            if (depth === 0) return i
        }
    }
    return -1
}
