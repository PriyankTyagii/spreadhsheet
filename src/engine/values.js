// ─────────────────────────────────────────────────────────────
//  Value coercion shared by the engine, sort, filter, fill and
//  the AI executor. One definition so "$1,200.00" means the same
//  number everywhere. Rules follow AI_CONTRACT.md §3.2.
// ─────────────────────────────────────────────────────────────

const STRICT_NUMBER = /^-?\d+(\.\d+)?$/
const LITERAL_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december']

/** Text key: trimmed, lower-cased. */
export function norm(v) {
    if (v === null || v === undefined) return ''
    return String(v).trim().toLowerCase()
}

/**
 * Number coercion: `$1,200.00` → 1200, `10%` → 0.1, `$ 49.99` → 49.99,
 * `N/A` / `` → null. Numbers pass through.
 */
export function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (v === null || v === undefined || typeof v === 'boolean') return null
    const s = String(v).trim()
    if (s === '') return null
    const percent = s.endsWith('%')
    const stripped = s.replace(/[$,%\s]/g, '')
    if (!STRICT_NUMBER.test(stripped)) return null
    const n = parseFloat(stripped)
    return percent ? n / 100 : n
}

/**
 * What a typed literal is stored as. Only plain numerals become numbers;
 * "2024-01-15", "$1,200" and "12 units" stay text (the old parseFloat
 * turned "2024-01-15" into 2024).
 */
export function parseLiteral(raw) {
    const s = raw.trim()
    if (LITERAL_NUMBER.test(s)) return Number(s)
    return raw
}

function pad2(n) { return n < 10 ? '0' + n : String(n) }

function validYmd(y, m, d) {
    if (m < 1 || m > 12 || d < 1) return false
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return d <= dim
}

function monthFromName(name) {
    const n = name.toLowerCase()
    if (n.length < 3) return -1
    return MONTHS.findIndex(m => m.startsWith(n))
}

/**
 * Parse one of the three sample date formats. Returns
 * { y, m, d, format } where format describes how to print it back,
 * or null.
 */
export function parseDateParts(v) {
    if (typeof v !== 'string') return null
    const s = v.trim()
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (m) {
        const y = +m[1], mo = +m[2], d = +m[3]
        if (!validYmd(y, mo, d)) return null
        return { y, m: mo, d, format: { kind: 'iso', padded: m[2].length === 2 && m[3].length === 2 } }
    }
    // For M/D/YYYY and D Mon YYYY, two-digit parts without a leading zero
    // (12/15, 30 Jan) don't say whether single digits are padded; only a
    // leading zero does. ISO is padded unless a part is a single digit.
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (m) {
        const mo = +m[1], d = +m[2], y = +m[3]
        if (!validYmd(y, mo, d)) return null
        return { y, m: mo, d, format: { kind: 'us', padded: m[1][0] === '0' || m[2][0] === '0' } }
    }
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/)
    if (m) {
        const mo = monthFromName(m[2]) + 1
        const d = +m[1], y = +m[3]
        if (mo === 0 || !validYmd(y, mo, d)) return null
        return { y, m: mo, d, format: { kind: 'dmy', monthText: m[2], padded: m[1][0] === '0' } }
    }
    return null
}

/** ISO day `YYYY-MM-DD` or null. */
export function toDate(v) {
    const p = parseDateParts(v)
    return p ? `${p.y}-${pad2(p.m)}-${pad2(p.d)}` : null
}

/** Days since epoch for date arithmetic (UTC, no DST surprises). */
export function partsToDay(p) {
    return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000)
}

function applyCase(sample, word) {
    if (sample === sample.toUpperCase()) return word.toUpperCase()
    if (sample === sample.toLowerCase()) return word.toLowerCase()
    return word[0].toUpperCase() + word.slice(1).toLowerCase()
}

/** Print a day number back in a seed's date format. */
export function formatDay(day, format) {
    const dt = new Date(day * 86400000)
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate()
    if (format.kind === 'iso') {
        return format.padded ? `${y}-${pad2(mo)}-${pad2(d)}` : `${y}-${mo}-${d}`
    }
    if (format.kind === 'us') {
        return format.padded ? `${pad2(mo)}/${pad2(d)}/${y}` : `${mo}/${d}/${y}`
    }
    const full = MONTHS[mo - 1]
    const name = format.monthText.length > 3 ? full : full.slice(0, 3)
    return `${format.padded ? pad2(d) : d} ${applyCase(format.monthText, name)} ${y}`
}

/** Error values produced by formulas all start with '#'. */
export function isErrorValue(v) {
    return typeof v === 'string' && v.length > 1 && v[0] === '#' && /^#[A-Z/0]+[!?]$/.test(v)
}
