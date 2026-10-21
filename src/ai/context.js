// ─────────────────────────────────────────────────────────────
//  What the model is allowed to know about the sheet: headers, an
//  inferred type per column, five sample rows, the row count and
//  the selection. Never the full data. Shape documented in
//  DESIGN_NOTES.md.
// ─────────────────────────────────────────────────────────────
import { toNum, toDate } from '../engine/values.js'
import { colToLetters, rangeName } from '../engine/refs.js'
import { dataRows } from './executor.js'
import { TOTALS_RE } from '../engine/sort.js'

const SAMPLE_FOR_TYPES = 200
const MAJORITY = 0.6

/** number | currency | percent | date | id | text, from up to 200 non-empty values. */
export function inferType(name, values) {
    const v = values.map(x => String(x).trim()).filter(Boolean).slice(0, SAMPLE_FOR_TYPES)
    if (!v.length) return 'text'
    const share = (pred) => v.filter(pred).length / v.length
    if (share(x => x.endsWith('%')) >= MAJORITY / 2 && share(x => toNum(x) !== null || /^n\/?a$/i.test(x)) >= MAJORITY) return 'percent'
    if (share(x => x.includes('$')) >= MAJORITY / 2 && share(x => toNum(x) !== null) >= MAJORITY) return 'currency'
    if (share(x => toDate(x) !== null) >= MAJORITY) return 'date'
    const idLike = share(x => /^[A-Za-z]{1,6}[-_]?\d{2,}$/.test(x)) >= MAJORITY
    if (idLike || /(^|\s)id$/i.test(name.trim())) return 'id'
    if (share(x => toNum(x) !== null) >= MAJORITY) return 'number'
    return 'text'
}

/**
 * @param {{ header: string[], rows: string[][] }} table
 * @param {{ r1, c1, r2, c2 } | null} selection
 */
export function buildContext(table, selection) {
    const rows = dataRows(table, true)
    const last = table.rows[table.rows.length - 1]
    const firstFilled = last && last.find(x => String(x).trim() !== '')
    const columns = table.header.map((name, index) => {
        const values = rows.map(r => r[index])
        const examples = []
        for (const x of values) {
            const t = String(x ?? '').trim()
            if (t && !examples.includes(t)) examples.push(t)
            if (examples.length === 3) break
        }
        return { name: String(name).trim(), index, letter: colToLetters(index), type: inferType(String(name), values), examples }
    }).filter(c => c.name !== '')
    return {
        range: table.header.length ? `A1:${colToLetters(table.header.length - 1)}${table.rows.length + 1}` : null,
        rowCount: table.rows.length,
        columns,
        sampleRows: rows.slice(0, 5),
        selection: selection ? rangeName(selection) : null,
        hasTotalsRow: !!firstFilled && TOTALS_RE.test(String(firstFilled).trim()),
    }
}
