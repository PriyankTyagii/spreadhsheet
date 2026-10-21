// ─────────────────────────────────────────────────────────────
//  Sort comparison. Pure.
//
//  Order of classes, in both directions: numbers (and dates, as day
//  numbers), then text (case-insensitive), then blank cells, then fully
//  blank rows. Direction only reverses order within numbers and within
//  text, so a "Units" column sorted descending starts at 60, not at a
//  stray "N/A". Ties are broken by the caller on original position, so
//  the sort is stable.
// ─────────────────────────────────────────────────────────────
import { toNum, parseDateParts, partsToDay, isErrorValue } from './values.js'
import { generalText } from './numberFormat.js'

export const TOTALS_RE = /^(grand\s+)?(total|totals|subtotal|sum)\b/i

/** True when the first non-empty cell of a row reads like "Total". */
export function isTotalsRow(textAt, lastCol) {
    for (let c = 0; c <= lastCol; c++) {
        const t = String(textAt(c) ?? '').trim()
        if (t) return TOTALS_RE.test(t)
    }
    return false
}

const NUMBER = 0, TEXT = 1, BLANK = 2, EMPTY_ROW = 3

export function sortKey(value, rowEmpty) {
    if (rowEmpty) return { cls: EMPTY_ROW }
    const text = generalText(value).trim()
    if (text === '') return { cls: BLANK }
    if (!isErrorValue(value)) {
        const n = toNum(value)
        if (n !== null) return { cls: NUMBER, n }
        const d = parseDateParts(text)
        if (d) return { cls: NUMBER, n: partsToDay(d) }
    }
    return { cls: TEXT, s: text.toLowerCase() }
}

/** sign: 1 ascending, -1 descending. */
export function compareKeys(a, b, sign) {
    if (a.cls !== b.cls) return a.cls - b.cls
    if (a.cls === NUMBER) return sign * (a.n - b.n)
    return sign * (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)
}
