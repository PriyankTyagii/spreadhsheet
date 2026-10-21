// ─────────────────────────────────────────────────────────────
//  format_sheet → a list of style operations, per AI_CONTRACT §4.
//  Pure: reads a sheet view, returns ops; the engine applies them
//  in one transaction (engine.applyFormat). Nothing here touches
//  React or the DOM.
//
//  view = { rowCount, colCount, text(r, c), patch(r, c), frozenRows }
// ─────────────────────────────────────────────────────────────
import { TOTALS_RE } from '../engine/sort.js'
import { toNum } from '../engine/values.js'

const STYLE_KEYS = ['bold', 'italic', 'underline', 'bg', 'color', 'align', 'fontSize', 'numberFormat']

/** §4.2: the last used row is a totals row by label, or by its shape. */
export function looksLikeTotals(cells) {
    const filled = cells.map(v => String(v ?? '').trim())
    const firstIdx = filled.findIndex(v => v !== '')
    if (firstIdx < 0) return false
    if (TOTALS_RE.test(filled[firstIdx])) return true
    const count = filled.filter(Boolean).length
    const rest = filled.slice(firstIdx + 1).filter(Boolean)
    return toNum(filled[firstIdx]) === null
        && rest.length > 0 && rest.every(v => toNum(v) !== null)
        && count >= 2 && count < filled.length
}

const pick = (style) => Object.fromEntries(Object.entries(style || {}).filter(([k]) => STYLE_KEYS.includes(k)))

/**
 * @returns {{ error: 'OUT_OF_RANGE', detail: string }
 *         | { styles: Map<string, object>, widths: Map<number, number>, freezeRows: number | null,
 *             autoFit: boolean, totalsRow: number | null, headerRow: number }}
 * styles maps "r,c" to the cell's complete new style patch.
 */
export function planFormat(view, action) {
    const { rowCount, colCount } = view
    if (action.freezeRows !== undefined && action.freezeRows !== null && action.freezeRows >= rowCount) {
        return { error: 'OUT_OF_RANGE', detail: `freezing ${action.freezeRows} rows would freeze all ${rowCount} used rows` }
    }
    const lastRow = rowCount - 1
    const lastCells = Array.from({ length: colCount }, (_, c) => view.text(lastRow, c))
    const totalsRow = lastRow >= 1 && looksLikeTotals(lastCells) ? lastRow : null

    const styles = new Map()
    const get = (r, c) => styles.get(`${r},${c}`) ?? { ...(view.patch(r, c) || {}) }
    const merge = (r, c, style) => styles.set(`${r},${c}`, { ...get(r, c), ...pick(style) })

    if (action.clearFormatting) {
        for (let r = 0; r < rowCount; r++) for (let c = 0; c < colCount; c++) styles.set(`${r},${c}`, {})
    }
    if (action.bodyStyle) {
        for (let r = 1; r < rowCount; r++) for (let c = 0; c < colCount; c++) merge(r, c, action.bodyStyle)
    }
    for (const entry of action.columns || []) {
        if (entry.col < 0 || entry.col >= colCount) continue
        for (let r = 1; r < rowCount; r++) merge(r, entry.col, entry.style)
    }
    if (action.totalsStyle && totalsRow !== null) {
        for (let c = 0; c < colCount; c++) merge(totalsRow, c, action.totalsStyle)
    }
    // Last, so header alignment wins; the header is never number-formatted.
    if (action.headerStyle) {
        const { numberFormat: _ignored, ...header } = pick(action.headerStyle)
        for (let c = 0; c < colCount; c++) merge(0, c, header)
    }

    const widths = new Map()
    for (const w of action.columnWidths || []) {
        if (w.col >= 0 && w.col < colCount && w.width >= 30 && w.width <= 600) widths.set(w.col, w.width)
    }
    const freezeRows = typeof action.freezeRows === 'number' ? action.freezeRows : null
    return { styles, widths, freezeRows, autoFit: !!action.autoFitColumns, totalsRow, headerRow: 0 }
}

const NAMES = { bold: 'bold', italic: 'italic', underline: 'underlined' }
function styleWords(style) {
    const out = []
    for (const k of ['bold', 'italic', 'underline']) if (style[k]) out.push(NAMES[k])
    if (style.bg) out.push(style.bg === 'white' ? 'no fill' : `fill ${style.bg}`)
    if (style.color) out.push(`text ${style.color}`)
    if (style.align) out.push(`${style.align}-aligned`)
    if (style.fontSize) out.push(`${style.fontSize}px`)
    if (style.numberFormat) out.push(`${style.numberFormat} format`)
    return out.join(', ')
}

/** Plain-words preview shown before Apply. */
export function describeFormat(action, totalsFound, letter) {
    const parts = []
    if (action.clearFormatting) parts.push('clear all formatting first')
    if (action.headerStyle) parts.push(`header: ${styleWords(action.headerStyle)}`)
    if (action.bodyStyle) parts.push(`body: ${styleWords(action.bodyStyle)}`)
    if (action.columns?.length) {
        parts.push(`${action.columns.length} column${action.columns.length > 1 ? 's' : ''}: `
            + action.columns.map(c => `${letter(c.col)} ${styleWords(c.style)}`).join('; '))
    }
    if (action.totalsStyle) {
        parts.push(totalsFound ? `totals row: ${styleWords(action.totalsStyle)}` : 'totals row: none found, so this is skipped')
    }
    if (typeof action.freezeRows === 'number') {
        parts.push(action.freezeRows === 0 ? 'unfreeze rows' : `freeze ${action.freezeRows} row${action.freezeRows > 1 ? 's' : ''}`)
    }
    if (action.columnWidths?.length) parts.push(`widths: ${action.columnWidths.map(w => `${letter(w.col)} ${w.width}px`).join(', ')}`)
    if (action.autoFitColumns) parts.push('auto-fit column widths')
    return parts.length ? parts.join(' · ') : 'no formatting changes'
}
