// ─────────────────────────────────────────────────────────────
//  Selection model. Pure.
//
//  { anchor: {r, c}, focus: {r, c}, kind: 'cells' | 'rows' | 'cols' }
//
//  The anchor is the active cell (where editing happens); the focus is
//  the corner that Shift+Click / Shift+Arrow / dragging moves. A 'rows'
//  or 'cols' selection spans every column or row of the sheet.
// ─────────────────────────────────────────────────────────────
import { rect } from '../engine/refs.js'

export function cellSelection(r, c) {
    return { anchor: { r, c }, focus: { r, c }, kind: 'cells' }
}

export function rangeSelection(g) {
    return { anchor: { r: g.r1, c: g.c1 }, focus: { r: g.r2, c: g.c2 }, kind: 'cells' }
}

export function selectionRect(sel, rows, cols) {
    const g = rect(sel.anchor.r, sel.anchor.c, sel.focus.r, sel.focus.c)
    if (sel.kind === 'rows') return { r1: g.r1, r2: g.r2, c1: 0, c2: cols - 1 }
    if (sel.kind === 'cols') return { r1: 0, r2: rows - 1, c1: g.c1, c2: g.c2 }
    return g
}

export function extendTo(sel, r, c) {
    return { ...sel, focus: { r, c } }
}

export function isSingleCell(sel) {
    return sel.kind === 'cells' && sel.anchor.r === sel.focus.r && sel.anchor.c === sel.focus.c
}

/**
 * Rectangle a style or clear should touch. Whole-row/column selections are
 * clipped to the used range so formatting column D does not write 100,000
 * style entries for empty cells.
 */
export function effectiveRect(sel, rows, cols, used) {
    const g = selectionRect(sel, rows, cols)
    if (sel.kind === 'cells' || !used) return g
    return {
        r1: g.r1, c1: g.c1,
        r2: sel.kind === 'cols' ? Math.max(g.r1, Math.min(g.r2, used.r2)) : g.r2,
        c2: sel.kind === 'rows' ? Math.max(g.c1, Math.min(g.c2, used.c2)) : g.c2,
    }
}

/**
 * Fill-handle drag: the target rectangle for a pointer at (r, c). Outside
 * the selection it extends along the axis the pointer has moved further on;
 * inside it shrinks (dragging back).
 */
export function fillTarget(g, r, c) {
    const below = r - g.r2, above = g.r1 - r, right = c - g.c2, left = g.c1 - c
    const vertical = Math.max(below, above), horizontal = Math.max(right, left)
    if (vertical > 0 || horizontal > 0) {
        if (vertical >= horizontal) {
            return below > 0 ? { ...g, r2: r } : { ...g, r1: r }
        }
        return right > 0 ? { ...g, c2: c } : { ...g, c1: c }
    }
    // Inside: shrink along whichever axis the pointer is pulled back on.
    if (r < g.r2 && (g.r2 - r) >= (g.c2 - c)) return { ...g, r2: Math.max(g.r1, r) }
    if (c < g.c2) return { ...g, c2: Math.max(g.c1, c) }
    return g
}
