// ─────────────────────────────────────────────────────────────
//  Fill series detection. Pure: given the seed values along one
//  line (a column when filling up/down, a row when filling
//  left/right), return a function that produces the value for any
//  position k on that line. Seeds occupy k = 0..n-1; k >= n is a
//  forward fill and k < 0 a backward one (dragging up or left).
//
//  Result of series(k): { seedIndex, offset, raw }
//    seedIndex  which seed this position copies its style from
//    offset     distance from that seed (formulas shift by this)
//    raw        the value to write, or null for "shift the seed formula"
// ─────────────────────────────────────────────────────────────
import { parseLiteral, parseDateParts, partsToDay, formatDay } from './values.js'

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december']

const mod = (a, n) => ((a % n) + n) % n

function matchName(s, list) {
    const lower = s.toLowerCase()
    for (let i = 0; i < list.length; i++) {
        if (lower === list[i]) return { index: i, short: false }
        if (lower === list[i].slice(0, 3)) return { index: i, short: true }
    }
    return null
}

function caseOf(s) {
    if (s === s.toUpperCase()) return 'upper'
    if (s === s.toLowerCase()) return 'lower'
    return 'title'
}

function printName(list, index, short, letterCase) {
    let w = list[index]
    if (short) w = w.slice(0, 3)
    if (letterCase === 'upper') return w.toUpperCase()
    if (letterCase === 'lower') return w
    return w[0].toUpperCase() + w.slice(1)
}

/** Classify one seed value. */
export function classify(raw) {
    const s = raw ?? ''
    if (s === '') return { kind: 'empty' }
    if (s[0] === '=') return { kind: 'formula' }
    const lit = parseLiteral(s)
    if (typeof lit === 'number') return { kind: 'number', value: lit }
    const date = parseDateParts(s)
    if (date) return { kind: 'date', day: partsToDay(date), format: date.format }
    const trimmed = s.trim()
    const wd = matchName(trimmed, WEEKDAYS)
    if (wd) return { kind: 'weekday', index: wd.index, short: wd.short, letterCase: caseOf(trimmed) }
    const mo = matchName(trimmed, MONTH_NAMES)
    if (mo) return { kind: 'month', index: mo.index, short: mo.short, letterCase: caseOf(trimmed) }
    const tn = /^(.*\D)(\d+)$/.exec(s)
    if (tn) {
        const digits = tn[2]
        return { kind: 'textnum', prefix: tn[1], value: parseInt(digits, 10), width: digits[0] === '0' ? digits.length : 0 }
    }
    return { kind: 'text' }
}

/** Least-squares slope of values against their positions 0..n-1. */
function slope(values) {
    const n = values.length
    const meanX = (n - 1) / 2
    const meanY = values.reduce((s, v) => s + v, 0) / n
    let num = 0, den = 0
    for (let i = 0; i < n; i++) {
        num += (i - meanX) * (values[i] - meanY)
        den += (i - meanX) * (i - meanX)
    }
    return { step: num / den, intercept: meanY - (num / den) * meanX }
}

const clean = (v) => +v.toPrecision(12)

/**
 * Build the series for one line of seeds (raw strings, in fill order).
 * Positions inside the seed block return the seed itself.
 */
export function buildSeries(seeds) {
    const n = seeds.length
    const kinds = seeds.map(classify)
    const kind = kinds.every(k => k.kind === kinds[0].kind) ? kinds[0].kind : 'mixed'

    const copy = (k) => {
        const i = mod(k, n)
        return { seedIndex: i, offset: k - i, raw: kinds[i].kind === 'formula' ? null : seeds[i] }
    }
    const at = (k, raw) => {
        if (k >= 0 && k < n) return copy(k)
        return { seedIndex: mod(k, n), offset: k - mod(k, n), raw }
    }

    if (kind === 'number' && n > 1) {
        const { step, intercept } = slope(kinds.map(k => k.value))
        return (k) => at(k, String(clean(intercept + step * k)))
    }

    if (kind === 'date') {
        const days = kinds.map(k => k.day)
        const step = n === 1 ? 1 : Math.round((days[n - 1] - days[0]) / (n - 1))
        return (k) => {
            const day = k >= n ? days[n - 1] + (k - n + 1) * step : days[0] + k * step
            return at(k, formatDay(day, kinds[mod(k, n)].format))
        }
    }

    if (kind === 'textnum' && kinds.every(k => k.prefix === kinds[0].prefix)) {
        const values = kinds.map(k => k.value)
        const step = n === 1 ? 1 : Math.round((values[n - 1] - values[0]) / (n - 1))
        const { prefix } = kinds[0]
        return (k) => {
            const v = Math.abs(k >= n ? values[n - 1] + (k - n + 1) * step : values[0] + k * step)
            const width = kinds[mod(k, n)].width
            return at(k, prefix + String(v).padStart(width, '0'))
        }
    }

    if (kind === 'weekday' || kind === 'month') {
        const list = kind === 'weekday' ? WEEKDAYS : MONTH_NAMES
        const L = list.length
        const first = kinds[0].index
        const step = n === 1 ? 1 : mod(kinds[1].index - first, L) || 1
        return (k) => {
            const style = kinds[mod(k, n)]
            return at(k, printName(list, mod(first + k * step, L), style.short, style.letterCase))
        }
    }

    // One number, plain text, formulas, blanks or a mix: repeat the seeds.
    return copy
}
