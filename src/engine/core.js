// ─────────────────────────────────────────────────────────────
//  Spreadsheet engine. Pure JavaScript: no React, no DOM.
//
//  State
//    cells       Map<key, Cell>          sparse; key = row * MAX_COLS + col
//    styles      Map<key, StylePatch>    only the properties a cell overrides
//    rowHeights / colWidths              sparse Maps of non-default sizes
//    rowIds      number[]                stable identity per row (sort "original")
//    filters     Map<col, FilterSpec>    a view: hides rows, never moves data
//    frozen      { rows, cols }
//
//  Every mutation runs inside a transaction. A transaction records the
//  before/after of each primitive change; one transaction is one undo step.
//  Recalculation runs once when the transaction closes and touches only the
//  changed cells and their transitive dependents.
// ─────────────────────────────────────────────────────────────
import { keyOf, rowOf, colOf, rect } from './refs.js'
import { compile, collectRefs, evaluate, rewriteFormula, compileTemplate, renderTemplate, shiftRef, ERR } from './formula.js'
import { parseLiteral, isErrorValue } from './values.js'
import { formatValue, generalText } from './numberFormat.js'
import { buildSeries } from './fill.js'
import { sortKey, compareKeys, isTotalsRow } from './sort.js'
import { rowPasses } from './filter.js'

export const DEFAULT_STYLE = Object.freeze({
    bold: false, italic: false, underline: false,
    bg: 'white', color: '#202124', align: 'left', fontSize: 13, numberFormat: 'general',
})
export const DEFAULT_COL_WIDTH = 100
export const DEFAULT_ROW_HEIGHT = 24
const MAX_UNDO_HISTORY = 100

function makeCell(raw) {
    if (raw[0] === '=') {
        const ast = compile(raw)
        const { refs, ranges } = collectRefs(ast)
        return {
            raw, ast, value: null,
            refs: refs.map(r => keyOf(r.row, r.col)),
            ranges: ranges.map(g => rect(g.a.row, g.a.col, g.b.row, g.b.col)),
        }
    }
    return { raw, value: parseLiteral(raw) }
}

const isBlank = (raw) => raw === undefined || raw === null || String(raw).trim() === ''

// Reference policies for structural edits: how a reference to an old
// row/col index reads after the edit. `pick` selects the axis.
function shiftPolicy(axis, at, n) {
    const f = axis === 'row' ? 'row' : 'col'
    const move = (r) => (r[f] >= at ? { ...r, [f]: r[f] + n } : r)
    return { ref: move, range: (g) => ({ a: move(g.a), b: move(g.b) }) }
}

function deletePolicy(axis, at, n) {
    const f = axis === 'row' ? 'row' : 'col'
    const end = at + n
    return {
        ref: (r) => (r[f] < at ? r : r[f] < end ? null : { ...r, [f]: r[f] - n }),
        range: (g) => {
            const [lo, hi] = g.a[f] <= g.b[f] ? [g.a, g.b] : [g.b, g.a]
            if (lo[f] >= at && hi[f] < end) return null
            const nlo = lo[f] < at ? lo[f] : lo[f] < end ? at : lo[f] - n
            const nhi = hi[f] < at ? hi[f] : hi[f] < end ? at - 1 : hi[f] - n
            return { a: { ...lo, [f]: nlo }, b: { ...hi, [f]: nhi } }
        },
    }
}

// Sort: a reference to a moved row follows it. A range that spans the
// whole sorted block (=SUM(J2:J32)) is left alone; so is any other
// multi-row range, since its rows no longer form one block after a sort.
function permutePolicy(perm, top, bottom) {
    return {
        ref: (r) => (perm.has(r.row) ? { ...r, row: perm.get(r.row) } : r),
        range: (g) => {
            const lo = Math.min(g.a.row, g.b.row), hi = Math.max(g.a.row, g.b.row)
            if (lo === hi && perm.has(lo) && !(lo <= top && hi >= bottom)) {
                return { a: { ...g.a, row: perm.get(lo) }, b: { ...g.b, row: perm.get(lo) } }
            }
            return g
        },
    }
}

export function createEngine(initialRows = 50, initialCols = 50) {
    let rows = initialRows
    let cols = initialCols
    let cells = new Map()
    let styles = new Map()
    let rowHeights = new Map()
    let colWidths = new Map()
    let rowIds = []
    let nextRowId = 0
    let filters = new Map()
    let frozen = { rows: 0, cols: 0 }
    let sortState = null

    // Dependency index. Single references: precedent key → dependent keys.
    // Ranges: column → formula keys with a range covering that column; a
    // candidate is confirmed by checking its rects (see dependentsOf).
    const formulaKeys = new Set()
    const dependents = new Map()
    const rangeBuckets = new Map()

    const undoStack = []
    const redoStack = []
    let tx = null
    let pending = null
    let version = 0
    const listeners = new Set()

    let lastRecalcCount = 0
    let usedCache = null
    let hiddenCache = null

    // ── Row identity ──

    function syncRowIds() {
        while (rowIds.length < rows) rowIds.push(nextRowId++)
        if (rowIds.length > rows) rowIds.length = rows
    }
    syncRowIds()

    // ── Dependency index ──

    function addDeps(k, cell) {
        for (const p of cell.refs) {
            let s = dependents.get(p)
            if (!s) dependents.set(p, (s = new Set()))
            s.add(k)
        }
        for (const g of cell.ranges) {
            for (let c = g.c1; c <= g.c2; c++) {
                let s = rangeBuckets.get(c)
                if (!s) rangeBuckets.set(c, (s = new Set()))
                s.add(k)
            }
        }
    }

    function removeDeps(k, cell) {
        for (const p of cell.refs) {
            const s = dependents.get(p)
            if (s) { s.delete(k); if (!s.size) dependents.delete(p) }
        }
        for (const g of cell.ranges) {
            for (let c = g.c1; c <= g.c2; c++) {
                const s = rangeBuckets.get(c)
                if (s) { s.delete(k); if (!s.size) rangeBuckets.delete(c) }
            }
        }
    }

    function dependentsOf(k) {
        const out = []
        const direct = dependents.get(k)
        if (direct) for (const d of direct) out.push(d)
        const bucket = rangeBuckets.get(colOf(k))
        if (bucket) {
            const r = rowOf(k), c = colOf(k)
            for (const f of bucket) {
                const cell = cells.get(f)
                if (cell && cell.ranges.some(g => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2)) out.push(f)
            }
        }
        return out
    }

    function rebuildDeps() {
        dependents.clear()
        rangeBuckets.clear()
        formulaKeys.clear()
        for (const [k, cell] of cells) {
            if (cell.ast) { formulaKeys.add(k); addDeps(k, cell) }
        }
    }

    // ── Recalculation ──

    const evalCtx = {
        get: (r, c) => {
            const cell = cells.get(keyOf(r, c))
            return cell ? cell.value : ''
        },
        forEachInRange: (r1, c1, r2, c2, fn) => {
            for (let r = r1; r <= r2; r++) {
                for (let c = c1; c <= c2; c++) {
                    const cell = cells.get(keyOf(r, c))
                    if (cell) fn(cell.value)
                }
            }
        },
    }

    /**
     * Recompute `seeds` and everything downstream of them, in topological
     * order (Kahn). Iterative, so a 100,000-long chain cannot overflow the
     * stack. Whatever is left when the queue drains sits on a cycle.
     */
    function recalc(seeds) {
        const dirty = new Set()
        const stack = []
        for (const k of seeds) if (!dirty.has(k)) { dirty.add(k); stack.push(k) }
        const downstream = new Map()
        while (stack.length) {
            const k = stack.pop()
            const ds = dependentsOf(k)
            downstream.set(k, ds)
            for (const d of ds) if (!dirty.has(d)) { dirty.add(d); stack.push(d) }
        }
        const indegree = new Map()
        for (const k of dirty) indegree.set(k, 0)
        for (const [, ds] of downstream) for (const d of ds) indegree.set(d, indegree.get(d) + 1)
        const queue = []
        for (const [k, n] of indegree) if (n === 0) queue.push(k)
        let done = 0
        let evaluated = 0
        for (let i = 0; i < queue.length; i++) {
            const k = queue[i]
            done++
            const cell = cells.get(k)
            if (cell && cell.ast) { cell.value = evaluate(cell.ast, evalCtx); evaluated++ }
            for (const d of downstream.get(k)) {
                const n = indegree.get(d) - 1
                indegree.set(d, n)
                if (n === 0) queue.push(d)
            }
        }
        if (done < dirty.size) {
            for (const [k, n] of indegree) {
                if (n > 0) { const cell = cells.get(k); if (cell && cell.ast) { cell.value = ERR.CYCLE; evaluated++ } }
            }
        }
        lastRecalcCount = evaluated
    }

    // ── Primitive writes (unlogged; transactions log around them) ──

    function putRaw(k, raw) {
        const old = cells.get(k)
        if (old && old.ast) { removeDeps(k, old); formulaKeys.delete(k) }
        if (isBlank(raw)) cells.delete(k)
        else {
            const cell = makeCell(raw)
            cells.set(k, cell)
            if (cell.ast) { formulaKeys.add(k); addDeps(k, cell) }
        }
        pending.changed.add(k)
    }

    function putStyle(k, patch) {
        if (patch && Object.keys(patch).length) styles.set(k, patch)
        else styles.delete(k)
        pending.styled = true
    }

    function putSize(map, i, size) {
        if (size === undefined || size === null) map.delete(i)
        else map.set(i, size)
        pending.styled = true
    }

    // ── Transactions and undo ──

    function log(record) {
        if (!tx) throw new Error('engine: mutation outside a transaction')
        tx.records.push(record)
    }

    function setRaw(k, raw) {
        const b = cells.get(k)?.raw ?? ''
        const a = isBlank(raw) ? '' : raw
        if (b === a) return false
        log({ t: 'raw', k, b, a })
        putRaw(k, a)
        return true
    }

    function setStylePatch(k, patch) {
        const b = styles.get(k) || null
        const a = patch && Object.keys(patch).length ? patch : null
        if (sameStyle(b, a)) return false
        log({ t: 'style', k, b, a })
        putStyle(k, a)
        return true
    }

    function setLogged(t, get, set, value) {
        const b = get()
        if (JSON.stringify(b) === JSON.stringify(value)) return false
        log({ t: 'fn', undo: () => set(b), redo: () => set(value) })
        set(value)
        pending.styled = true
        return true
    }

    function beginPending() {
        pending = { changed: new Set(), full: false, styled: false }
    }

    function settle() {
        const p = pending
        pending = null
        if (p.full) {
            rebuildDeps()
            recalc(formulaKeys)
        } else if (p.changed.size) {
            recalc(p.changed)
        }
        if (p.full || p.changed.size || p.styled) {
            usedCache = null
            hiddenCache = null
            version++
            for (const fn of listeners) fn()
        }
    }

    // Closure records (filters, freeze, sizes, sort state, structural edits)
    // change state putRaw/putStyle don't see, so flag it for settle() to
    // drop caches and bump the version.
    function revert(rec) {
        switch (rec.t) {
            case 'raw': putRaw(rec.k, rec.b); break
            case 'style': putStyle(rec.k, rec.b); break
            case 'fn': rec.undo(); pending.styled = true; break
        }
    }

    function replay(rec) {
        switch (rec.t) {
            case 'raw': putRaw(rec.k, rec.a); break
            case 'style': putStyle(rec.k, rec.a); break
            case 'fn': rec.redo(); pending.styled = true; break
        }
    }

    /**
     * Run fn as one undo step. Nested calls join the outer transaction.
     * If fn throws, everything it did is rolled back and the error rethrown.
     * Returns { result, changed } where changed is false for a no-op.
     */
    function transact(label, fn) {
        if (tx) return { result: fn(), changed: true }
        tx = { label, records: [] }
        beginPending()
        let result
        try {
            result = fn()
        } catch (e) {
            for (let i = tx.records.length - 1; i >= 0; i--) revert(tx.records[i])
            tx = null
            settle()
            throw e
        }
        const done = tx
        tx = null
        if (done.records.length) {
            undoStack.push(done)
            if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift()
            redoStack.length = 0
        }
        settle()
        return { result, changed: done.records.length > 0 }
    }

    function undo() {
        const t = undoStack.pop()
        if (!t) return false
        beginPending()
        for (let i = t.records.length - 1; i >= 0; i--) revert(t.records[i])
        settle()
        redoStack.push(t)
        return true
    }

    function redo() {
        const t = redoStack.pop()
        if (!t) return false
        beginPending()
        for (const rec of t.records) replay(rec)
        settle()
        undoStack.push(t)
        return true
    }

    // ── Structural edits ──

    /**
     * Move every row (or column) index i to map(i); -1 deletes it. When a
     * reference policy is given, formulas are rewritten with it. Returns what
     * was removed or rewritten so the edit can be inverted exactly.
     */
    function remapAxis(axis, map, policy) {
        const isRow = axis === 'row'
        const moveKey = (k) => {
            const r = rowOf(k), c = colOf(k)
            const ni = map(isRow ? r : c)
            if (ni < 0) return -1
            return isRow ? keyOf(ni, c) : keyOf(r, ni)
        }
        const out = { cells: [], styles: [], sizes: [], ids: [], filters: [], rewritten: [] }

        const nextCells = new Map()
        for (const [k, cell] of cells) {
            const nk = moveKey(k)
            if (nk < 0) out.cells.push([k, cell.raw])
            else nextCells.set(nk, cell)
        }
        if (policy) {
            for (const [nk, cell] of nextCells) {
                if (!cell.ast) continue
                const raw = rewriteFormula(cell.raw, policy.ref, policy.range)
                if (raw !== cell.raw) {
                    out.rewritten.push([nk, cell.raw])
                    nextCells.set(nk, makeCell(raw))
                }
            }
        }
        cells = nextCells

        const nextStyles = new Map()
        for (const [k, s] of styles) {
            const nk = moveKey(k)
            if (nk < 0) out.styles.push([k, s])
            else nextStyles.set(nk, s)
        }
        styles = nextStyles

        const sizes = isRow ? rowHeights : colWidths
        const nextSizes = new Map()
        for (const [i, s] of sizes) {
            const ni = map(i)
            if (ni < 0) out.sizes.push([i, s])
            else nextSizes.set(ni, s)
        }
        if (isRow) rowHeights = nextSizes
        else colWidths = nextSizes

        if (isRow) {
            const next = new Array(rows)
            for (let i = 0; i < rowIds.length; i++) {
                const ni = map(i)
                if (ni < 0) out.ids.push([i, rowIds[i]])
                else if (ni < rows) next[ni] = rowIds[i]
            }
            for (let i = 0; i < rows; i++) if (next[i] === undefined) next[i] = nextRowId++
            rowIds = next
        } else {
            const next = new Map()
            for (const [c, f] of filters) {
                const nc = map(c)
                if (nc < 0) out.filters.push([c, f])
                else next.set(nc, f)
            }
            filters = next
        }
        pending.full = true
        return out
    }

    function restoreRemoved(axis, removed, inverse) {
        const isRow = axis === 'row'
        for (const [k, raw] of removed.cells) cells.set(k, makeCell(raw))
        for (const [k, s] of removed.styles) styles.set(k, s)
        for (const [i, s] of removed.sizes) (isRow ? rowHeights : colWidths).set(i, s)
        for (const [i, id] of removed.ids) rowIds[i] = id
        for (const [c, f] of removed.filters) filters.set(c, f)
        for (const [nk, raw] of removed.rewritten) {
            const r = rowOf(nk), c = colOf(nk)
            const ok = isRow ? keyOf(inverse(r), c) : keyOf(r, inverse(c))
            cells.set(ok, makeCell(raw))
        }
    }

    /**
     * A logged structural edit. `map`/`inverse` move indices, `policy`
     * rewrites references, `countDelta` changes rows or cols.
     */
    function structural(axis, map, inverse, policy, countDelta) {
        const isRow = axis === 'row'
        let removed = null
        const apply = () => {
            if (isRow) rows += countDelta
            else cols += countDelta
            removed = remapAxis(axis, map, policy)
        }
        const undoIt = () => {
            if (isRow) rows -= countDelta
            else cols -= countDelta
            remapAxis(axis, inverse, null)
            restoreRemoved(axis, removed, inverse)
        }
        log({ t: 'fn', undo: undoIt, redo: apply })
        apply()
    }

    function setSortState(next) {
        setLogged('sort', () => sortState, (v) => { sortState = v }, next)
    }

    function insertRows(at, n = 1) {
        return transact('Insert row', () => {
            setSortState(null)
            structural('row', (i) => (i >= at ? i + n : i),
                (i) => (i < at ? i : i < at + n ? -1 : i - n), shiftPolicy('row', at, n), n)
        }).changed
    }

    function deleteRows(at, n = 1) {
        return transact('Delete row', () => {
            setSortState(null)
            structural('row', (i) => (i < at ? i : i < at + n ? -1 : i - n),
                (i) => (i < at ? i : i + n), deletePolicy('row', at, n), -n)
        }).changed
    }

    function insertCols(at, n = 1) {
        return transact('Insert column', () => {
            setSortState(null)
            structural('col', (i) => (i >= at ? i + n : i),
                (i) => (i < at ? i : i < at + n ? -1 : i - n), shiftPolicy('col', at, n), n)
        }).changed
    }

    function deleteCols(at, n = 1) {
        return transact('Delete column', () => {
            setSortState(null)
            structural('col', (i) => (i < at ? i : i < at + n ? -1 : i - n),
                (i) => (i < at ? i : i + n), deletePolicy('col', at, n), -n)
        }).changed
    }

    // ── Reading ──

    function valueAt(r, c) {
        const cell = cells.get(keyOf(r, c))
        return cell ? cell.value : ''
    }

    function rawAt(r, c) {
        return cells.get(keyOf(r, c))?.raw ?? ''
    }

    function getCell(r, c) {
        const cell = cells.get(keyOf(r, c))
        if (!cell) return { raw: '', computed: '', error: null }
        if (isErrorValue(cell.value) && cell.ast) return { raw: cell.raw, computed: null, error: cell.value }
        return { raw: cell.raw, computed: cell.value, error: null }
    }

    // Merged styles are cached per patch object, so the same patch always
    // yields the same object and memoized cells can compare by identity.
    const mergedStyles = new WeakMap()
    function getStyle(r, c) {
        const s = styles.get(keyOf(r, c))
        if (!s) return DEFAULT_STYLE
        let m = mergedStyles.get(s)
        if (!m) mergedStyles.set(s, (m = Object.freeze({ ...DEFAULT_STYLE, ...s })))
        return m
    }

    /** The text the grid shows: computed value through the number format. */
    function getDisplay(r, c) {
        const cell = cells.get(keyOf(r, c))
        if (!cell) return ''
        const s = styles.get(keyOf(r, c))
        return formatValue(cell.value, s && s.numberFormat)
    }

    /** The value as text before number formatting (what the AI executor reads). */
    function getText(r, c) {
        const cell = cells.get(keyOf(r, c))
        if (!cell) return ''
        return cell.ast ? generalText(cell.value) : cell.raw
    }

    /** Bounding box of non-empty cells, anchored at A1. null when empty. */
    function usedRange() {
        if (usedCache !== null) return usedCache || null
        let r2 = -1, c2 = -1
        for (const k of cells.keys()) {
            const r = rowOf(k), c = colOf(k)
            if (r > r2) r2 = r
            if (c > c2) c2 = c
        }
        usedCache = r2 < 0 ? false : { r1: 0, c1: 0, r2, c2 }
        return usedCache || null
    }

    // A row holding only formulas (say a filled =J21/G21 helper column) has no
    // data of its own, so for sorting it is as blank as a truly empty row.
    function rowIsEmpty(r, c1, c2) {
        for (let c = c1; c <= c2; c++) {
            const cell = cells.get(keyOf(r, c))
            if (cell && !cell.ast && !isBlank(cell.raw)) return false
        }
        return true
    }

    // ── Editing ──

    function setCell(r, c, raw) {
        return transact('Edit cell', () => { setRaw(keyOf(r, c), raw ?? '') }).changed
    }

    /** Write a matrix of raw strings with its top-left at (r, c). One undo step. */
    function setValues(r, c, matrix, label = 'Write values') {
        const width = matrix.reduce((w, row) => Math.max(w, row.length), 0)
        ensureCapacity(r + matrix.length, c + width)
        return transact(label, () => {
            for (let i = 0; i < matrix.length; i++) {
                for (let j = 0; j < matrix[i].length; j++) {
                    const v = matrix[i][j]
                    setRaw(keyOf(r + i, c + j), v === null || v === undefined ? '' : String(v))
                }
            }
        }).changed
    }

    /** Clear the contents (not the formatting) of a rectangle. One undo step. */
    function clearRange(g) {
        return transact('Clear', () => {
            for (const k of [...cells.keys()]) {
                const r = rowOf(k), c = colOf(k)
                if (r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2) setRaw(k, '')
            }
        }).changed
    }

    /** Remove every value, style, size, filter and freeze. One undo step. */
    function clearAll() {
        return transact('Clear all', () => {
            for (const k of [...cells.keys()]) setRaw(k, '')
            for (const k of [...styles.keys()]) setStylePatch(k, null)
            setLogged('sizes', () => [[...rowHeights], [...colWidths]], (v) => {
                rowHeights = new Map(v[0]); colWidths = new Map(v[1])
            }, [[], []])
            setLogged('filters', () => [...filters], (v) => { filters = new Map(v) }, [])
            setLogged('freeze', () => frozen, (v) => { frozen = v }, { rows: 0, cols: 0 })
            setSortState(null)
        }).changed
    }

    // ── Styles ──

    function sameStyle(a, b) {
        if (a === b) return true
        if (!a || !b) return false
        const ka = Object.keys(a), kb = Object.keys(b)
        if (ka.length !== kb.length) return false
        return ka.every(k => a[k] === b[k])
    }

    /** Merge a patch into a cell's style, dropping properties equal to the default. */
    function mergedPatch(k, patch) {
        const next = { ...(styles.get(k) || {}), ...patch }
        for (const p of Object.keys(next)) if (next[p] === DEFAULT_STYLE[p]) delete next[p]
        return next
    }

    /** Apply a style patch to every cell of a rectangle. One undo step. */
    function applyStyle(g, patch) {
        return transact('Format', () => {
            for (let r = g.r1; r <= g.r2; r++) {
                for (let c = g.c1; c <= g.c2; c++) {
                    const k = keyOf(r, c)
                    setStylePatch(k, mergedPatch(k, patch))
                }
            }
        }).changed
    }

    // ── Sizes and freeze ──

    const colWidth = (c) => colWidths.get(c) ?? DEFAULT_COL_WIDTH
    const rowHeight = (r) => rowHeights.get(r) ?? DEFAULT_ROW_HEIGHT

    function setColWidth(c, w) {
        return transact('Resize column', () => {
            setLogged('colw', () => colWidths.get(c) ?? null, (v) => putSize(colWidths, c, v),
                w === DEFAULT_COL_WIDTH ? null : Math.round(w))
        }).changed
    }

    function setRowHeight(r, h) {
        return transact('Resize row', () => {
            setLogged('rowh', () => rowHeights.get(r) ?? null, (v) => putSize(rowHeights, r, v),
                h === DEFAULT_ROW_HEIGHT ? null : Math.round(h))
        }).changed
    }

    /**
     * Width that fits the widest displayed text in column c over the used
     * rows. `measure(text, style)` is supplied by the UI (canvas measureText)
     * so the engine stays DOM-free.
     */
    function fitWidth(c, measure) {
        const used = usedRange()
        let w = 0
        if (used) {
            for (let r = 0; r <= used.r2; r++) {
                const text = getDisplay(r, c)
                if (text) w = Math.max(w, measure(text, getStyle(r, c)))
            }
        }
        return Math.max(40, Math.min(600, Math.ceil(w) + 12))
    }

    function autoFitColumn(c, measure) {
        return setColWidth(c, fitWidth(c, measure))
    }

    function setFreeze(nextRows, nextCols) {
        return transact('Freeze', () => {
            setLogged('freeze', () => frozen, (v) => { frozen = v }, {
                rows: nextRows ?? frozen.rows, cols: nextCols ?? frozen.cols,
            })
        }).changed
    }

    // ── Fill ──

    /**
     * Fill from `source` into `target` (target contains source and extends
     * it in exactly one direction). A target smaller than the source clears
     * the cells that were dragged back over. One undo step.
     */
    function fill(source, target) {
        const down = target.r2 > source.r2, up = target.r1 < source.r1
        const right = target.c2 > source.c2, left = target.c1 < source.c1
        ensureCapacity(target.r2 + 1, target.c2 + 1)
        return transact('Fill', () => {
            // Always one undo step, even if every value was already there:
            // Ctrl+Z right after a fill must not undo the action before it.
            log({ t: 'fn', undo() {}, redo() {} })
            if (!down && !up && !right && !left) {
                // Dragged back inside the selection: clear what was left out.
                for (let r = source.r1; r <= source.r2; r++) {
                    for (let c = source.c1; c <= source.c2; c++) {
                        if (r > target.r2 || c > target.c2) setRaw(keyOf(r, c), '')
                    }
                }
                return
            }
            const vertical = down || up
            const lines = vertical ? [source.c1, source.c2] : [source.r1, source.r2]
            for (let line = lines[0]; line <= lines[1]; line++) {
                const seedKeys = []
                if (vertical) for (let r = source.r1; r <= source.r2; r++) seedKeys.push(keyOf(r, line))
                else for (let c = source.c1; c <= source.c2; c++) seedKeys.push(keyOf(line, c))
                const seeds = seedKeys.map(k => cells.get(k)?.raw ?? '')
                const series = buildSeries(seeds)
                const templates = seeds.map(s => (s[0] === '=' ? compileTemplate(s) : null))
                const seedStyles = seedKeys.map(k => styles.get(k) || null)
                const from = vertical ? (down ? source.r2 + 1 : target.r1) : (right ? source.c2 + 1 : target.c1)
                const to = vertical ? (down ? target.r2 : source.r1 - 1) : (right ? target.c2 : source.c1 - 1)
                const origin = vertical ? source.r1 : source.c1
                for (let i = from; i <= to; i++) {
                    const { seedIndex, offset, raw } = series(i - origin)
                    let value = raw
                    if (value === null) {
                        const tpl = templates[seedIndex]
                        value = tpl
                            ? renderTemplate(tpl, (ref) => (vertical ? shiftRef(ref, offset, 0) : shiftRef(ref, 0, offset)))
                            : seeds[seedIndex]
                    }
                    const k = vertical ? keyOf(i, line) : keyOf(line, i)
                    setRaw(k, value)
                    setStylePatch(k, seedStyles[seedIndex])
                }
            }
        }).changed
    }

    // ── Filters ──

    /** Data rows a filter or sort covers: below the header to the last used row. */
    function dataRows() {
        const used = usedRange()
        return used ? { top: 1, bottom: used.r2, c2: used.c2 } : null
    }

    function computeHidden() {
        const hidden = new Set()
        const d = dataRows()
        if (!filters.size || !d) return hidden
        for (let r = d.top; r <= d.bottom; r++) {
            if (!rowPasses(filters, (c) => valueAt(r, c))) hidden.add(r)
        }
        return hidden
    }

    function hiddenRows() {
        if (!hiddenCache) hiddenCache = computeHidden()
        return hiddenCache
    }

    function setFilter(col, spec) {
        return transact('Filter', () => {
            const next = new Map(filters)
            if (spec) next.set(col, spec)
            else next.delete(col)
            setLogged('filters', () => [...filters], (v) => { filters = new Map(v) }, [...next])
        }).changed
    }

    function clearFilters() {
        return transact('Clear filters', () => {
            setLogged('filters', () => [...filters], (v) => { filters = new Map(v) }, [])
        }).changed
    }

    /** Distinct values of a column over the rows that pass the other columns' filters. */
    function distinctValues(col) {
        const d = dataRows()
        const seen = new Map()
        if (!d) return []
        const others = new Map(filters)
        others.delete(col)
        for (let r = d.top; r <= d.bottom; r++) {
            if (others.size && !rowPasses(others, (c) => valueAt(r, c))) continue
            const text = generalText(valueAt(r, col))
            const key = text.trim().toLowerCase()
            const entry = seen.get(key)
            if (entry) entry.count++
            else seen.set(key, { key, label: key === '' ? '(Blanks)' : text.trim(), count: 1 })
        }
        return [...seen.values()].sort((a, b) =>
            a.key === '' ? 1 : b.key === '' ? -1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    }

    function filterStats() {
        const d = dataRows()
        const total = d ? d.bottom - d.top + 1 : 0
        return { total, visible: total - hiddenRows().size }
    }

    // ── Sort ──

    /**
     * Sort a block of rows by one column. dir: 'asc' | 'desc' | 'original'.
     * Without a range: the used range, row 1 as header, a trailing totals
     * row pinned. With a filter active only visible rows move. Whole rows
     * move, so row identity, styles and heights travel with their data.
     * One undo step; returns false when the order would not change.
     */
    function sort({ col, dir, range }) {
        const d = dataRows()
        if (!d && !range) return false
        let top, bottom
        if (range && range.r2 > range.r1) {
            top = range.r1; bottom = range.r2
        } else {
            top = d.top; bottom = d.bottom
            if (bottom >= top && isTotalsRow((c) => getText(bottom, c), d.c2)) bottom--
        }
        if (bottom <= top) return false

        const hidden = hiddenRows()
        const positions = []
        for (let r = top; r <= bottom; r++) if (!hidden.has(r)) positions.push(r)
        const blockId = `${top}:${bottom}`
        const base = sortState && sortState.blockId === blockId
            ? sortState.originalIds
            : positions.map(r => rowIds[r])

        let order
        if (dir === 'original') {
            const rank = new Map(base.map((id, i) => [id, i]))
            order = positions.slice().sort((a, b) =>
                (rank.get(rowIds[a]) ?? Infinity) - (rank.get(rowIds[b]) ?? Infinity) || a - b)
        } else {
            const used = usedRange()
            const lastCol = used ? used.c2 : col
            const keys = new Map()
            for (const r of positions) keys.set(r, sortKey(valueAt(r, col), rowIsEmpty(r, 0, lastCol)))
            const sign = dir === 'desc' ? -1 : 1
            order = positions.slice().sort((a, b) => compareKeys(keys.get(a), keys.get(b), sign) || a - b)
        }

        const perm = new Map()
        const inv = new Map()
        for (let i = 0; i < positions.length; i++) {
            if (order[i] !== positions[i]) {
                perm.set(order[i], positions[i])
                inv.set(positions[i], order[i])
            }
        }
        const nextState = dir === 'original' ? null : { blockId, col, dir, originalIds: base }
        return transact('Sort', () => {
            setSortState(nextState)
            if (!perm.size) return
            structural('row', (i) => perm.get(i) ?? i, (i) => inv.get(i) ?? i, permutePolicy(perm, top, bottom), 0)
        }).changed
    }

    // ── Capacity ──

    function ensureCapacity(minRows, minCols) {
        if (minRows > rows) { rows = minRows; syncRowIds() }
        if (minCols > cols) cols = minCols
    }

    return {
        get rows() { return rows },
        get cols() { return cols },
        get version() { return version },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },

        // reading
        getCell, getValue: valueAt, getRaw: rawAt, getText, getDisplay, getStyle,
        usedRange, rowId: (r) => rowIds[r],

        // editing (each call is one undo step)
        setCell, setValues, clearRange, clearAll, applyStyle, fill, sort,
        insertRow: (at) => insertRows(at, 1),
        deleteRow: (at) => deleteRows(at, 1),
        insertColumn: (at) => insertCols(at, 1),
        deleteColumn: (at) => deleteCols(at, 1),
        insertRows, deleteRows, insertColumns: insertCols, deleteColumns: deleteCols,
        transact: (label, fn) => transact(label, fn).changed,

        // layout
        colWidth, rowHeight, setColWidth, setRowHeight, fitWidth, autoFitColumn,
        get frozenRows() { return frozen.rows },
        get frozenCols() { return frozen.cols },
        setFreeze,

        // filters
        setFilter, clearFilters, distinctValues, filterStats,
        getFilter: (c) => filters.get(c) || null,
        get filteredColumns() { return [...filters.keys()] },
        isRowHidden: (r) => hiddenRows().has(r),
        get sortState() { return sortState },

        // undo
        undo, redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        get undoDepth() { return undoStack.length },
        /** How many formulas the last change re-evaluated (for tests and benchmarks). */
        get lastRecalcCount() { return lastRecalcCount },

        ensureCapacity,
    }
}
