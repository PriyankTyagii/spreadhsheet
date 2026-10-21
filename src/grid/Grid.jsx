// ─────────────────────────────────────────────────────────────
//  Virtualized grid. Only the rows and columns in the viewport
//  (plus overscan) are rendered; positions come from prefix-sum
//  axes. There is no React state per cell: a render reads the
//  engine directly for the visible cells.
//
//  Layout: one scroller holds a canvas the size of the whole sheet.
//  Everything is placed in canvas coordinates. Four layers:
//
//    corner  sticky top+left  corner box, frozen headers, frozen×frozen cells
//    top     sticky top       column headers + frozen rows
//    left    sticky left      row headers + frozen columns
//    body    absolute         everything else
//
//  Sticky layers stay pinned and are scroll-synced by the browser's own
//  scrolling, so headers never lag a frame behind the body. Each sticky
//  layer clips to its own size and cancels its height with a negative
//  margin so it takes no space in the flow.
//
//  The viewport is quantised (STEP_Y / STEP_X) and overscanned, so
//  scrolling inside a block re-renders nothing: the browser just scrolls
//  already-rendered cells. <Cell> is memoized on primitive props and a
//  stable style object, so a selection change re-renders no cells at all.
//
//  The grid never subscribes to the editor store: the editor and the fill
//  handle are small components that do, so opening the editor or typing
//  does not re-render the grid.
// ─────────────────────────────────────────────────────────────
import { memo, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createAxis } from './axis.js'
import { selectionRect, fillTarget, extendTo, cellSelection } from './selection.js'
import { colToLetters } from '../engine/refs.js'
import { DEFAULT_ROW_HEIGHT } from '../engine/core.js'

export const HEADER_H = 24
export const HEADER_W = 56
const STEP_Y = 72
const STEP_X = 200
const OVERSCAN_ROWS = 3
const OVERSCAN_COLS = 1
const MIN_COL_WIDTH = 30
const MIN_ROW_HEIGHT = 16

const cssCache = new WeakMap()
function cellCss(style) {
    let css = cssCache.get(style)
    if (css) return css
    css = {
        fontWeight: style.bold ? 700 : 400,
        fontStyle: style.italic ? 'italic' : 'normal',
        textDecoration: style.underline ? 'underline' : 'none',
        color: style.color,
        background: style.bg,
        fontSize: style.fontSize,
        textAlign: style.align,
    }
    cssCache.set(style, css)
    return css
}

const Cell = memo(function Cell({ r, c, text, x, y, w, h, style, error }) {
    return (
        <div
            data-r={r}
            data-c={c}
            className={error ? 'cell error' : 'cell'}
            style={{ left: x, top: y, width: w, height: h, lineHeight: `${h - 1}px`, ...cellCss(style) }}
        >
            {text}
        </div>
    )
})

/** Renders the editor if the cell being edited belongs to this layer. */
function EditorSlot({ editor, owns, place, onKeyDown, onCommitEdit }) {
    const target = useSyncExternalStore(editor.subscribe, editor.getTarget)
    if (!target || !owns(target.r, target.c)) return null
    const p = place(target.r, target.c)
    return (
        <CellEditor
            editor={editor}
            {...p}
            autoFocus={target.source !== 'bar'}
            onKeyDown={onKeyDown}
            onFocus={() => editor.setSource('cell')}
            onBlur={(e) => { if (!e.relatedTarget?.hasAttribute('data-formula-bar')) onCommitEdit?.('blur') }}
        />
    )
}

/** The fill handle hides while a cell is being edited. */
function FillHandle({ editor, x, y, onPointerDown }) {
    const editing = useSyncExternalStore(editor.subscribe, () => editor.getTarget() !== null)
    if (editing) return null
    return <div className="fill-handle" style={{ left: x, top: y }} onPointerDown={onPointerDown} />
}

function CellEditor({ editor, x, y, width, height, style, autoFocus, onKeyDown, onFocus, onBlur }) {
    const value = useSyncExternalStore(editor.subscribe, editor.getValue)
    return (
        <input
            className="cell-editor"
            data-cell-editor
            autoFocus={autoFocus}
            value={value}
            spellCheck={false}
            onChange={(e) => editor.setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            onBlur={onBlur}
            style={{
                left: x, top: y, height,
                minWidth: width,
                width: Math.max(width, value.length * 8 + 16),
                ...cellCss(style),
                background: '#fff',
            }}
        />
    )
}

function range(from, to, skip) {
    const out = []
    for (let i = from; i <= to; i++) if (!skip || !skip(i)) out.push(i)
    return out
}

export default function Grid({
    engine, version, selection, onSelectionChange, editor, onStartEdit, onEditorKeyDown,
    onCommitEdit, onFill, onKeyDown, onSort, onOpenFilter, onResizeCol, onResizeRow, onAutoFit, apiRef,
}) {
    const scrollerRef = useRef(null)
    const dragRef = useRef(null)
    const lastResizeDown = useRef(null)
    const [viewport, setViewport] = useState({ top: 0, left: 0, width: 1400, height: 900 })
    const [fillPreview, setFillPreview] = useState(null)
    const [sizePreview, setSizePreview] = useState(null)

    const { rows, cols } = engine
    const rowAxis = useMemo(() => createAxis(rows, (r) => {
        if (sizePreview && sizePreview.axis === 'row' && sizePreview.index === r) return sizePreview.size
        return engine.isRowHidden(r) ? 0 : engine.rowHeight(r)
    }), [engine, rows, version, sizePreview]) // eslint-disable-line react-hooks/exhaustive-deps
    const colAxis = useMemo(() => createAxis(cols, (c) => {
        if (sizePreview && sizePreview.axis === 'col' && sizePreview.index === c) return sizePreview.size
        return engine.colWidth(c)
    }), [engine, cols, version, sizePreview]) // eslint-disable-line react-hooks/exhaustive-deps

    const F = Math.min(engine.frozenRows, rows)
    const G = Math.min(engine.frozenCols, cols)
    const FH = rowAxis.start(F)
    const FW = colAxis.start(G)

    // ── viewport tracking (quantised) ──
    useEffect(() => {
        const el = scrollerRef.current
        let frame = 0
        const read = () => {
            frame = 0
            const next = {
                top: Math.floor(el.scrollTop / STEP_Y) * STEP_Y,
                left: Math.floor(el.scrollLeft / STEP_X) * STEP_X,
                width: el.clientWidth,
                height: el.clientHeight,
            }
            setViewport(prev => (prev.top === next.top && prev.left === next.left
                && prev.width === next.width && prev.height === next.height ? prev : next))
        }
        const schedule = () => { if (!frame) frame = requestAnimationFrame(read) }
        el.addEventListener('scroll', schedule, { passive: true })
        const ro = new ResizeObserver(schedule)
        ro.observe(el)
        return () => {
            el.removeEventListener('scroll', schedule)
            ro.disconnect()
            if (frame) cancelAnimationFrame(frame)
        }
    }, [])

    useImperativeHandle(apiRef, () => ({
        focus: () => scrollerRef.current?.focus({ preventScroll: true }),
        scrollIntoView(r, c) {
            const el = scrollerRef.current
            if (!el) return
            if (r >= F) {
                const minTop = rowAxis.end(r) + HEADER_H - el.clientHeight
                const maxTop = rowAxis.start(r) - FH
                if (el.scrollTop > maxTop) el.scrollTop = maxTop
                else if (el.scrollTop < minTop) el.scrollTop = minTop
            }
            if (c >= G) {
                const minLeft = colAxis.end(c) + HEADER_W - el.clientWidth
                const maxLeft = colAxis.start(c) - FW
                if (el.scrollLeft > maxLeft) el.scrollLeft = maxLeft
                else if (el.scrollLeft < minLeft) el.scrollLeft = minLeft
            }
        },
        pageRows() {
            const el = scrollerRef.current
            return Math.max(1, Math.floor(((el?.clientHeight ?? 600) - HEADER_H - FH) / DEFAULT_ROW_HEIGHT) - 1)
        },
    }), [rowAxis, colAxis, F, G, FH, FW])

    // ── visible window ──
    const hidden = (r) => rowAxis.size(r) === 0
    const r0 = Math.max(F, rowAxis.indexAt(viewport.top) - OVERSCAN_ROWS)
    const r1 = Math.min(rows - 1, rowAxis.indexAt(viewport.top + viewport.height + STEP_Y) + OVERSCAN_ROWS)
    const c0 = Math.max(G, colAxis.indexAt(viewport.left) - OVERSCAN_COLS)
    const c1 = Math.min(cols - 1, colAxis.indexAt(viewport.left + viewport.width + STEP_X) + OVERSCAN_COLS)
    const scrollRows = range(r0, r1, hidden)
    const scrollCols = range(c0, c1)
    const frozenRows = range(0, F - 1, hidden)
    const frozenCols = range(0, G - 1)

    const sel = selectionRect(selection, rows, cols)
    const used = engine.usedRange()
    const sortState = engine.sortState
    const X = (c) => HEADER_W + colAxis.start(c)
    const Y = (r) => HEADER_H + rowAxis.start(r)

    // ── pointer handling ──

    /** Which cell is under a client point, honouring frozen panes. */
    function cellAt(clientX, clientY) {
        const el = scrollerRef.current
        const box = el.getBoundingClientRect()
        const vx = clientX - box.left - HEADER_W
        const vy = clientY - box.top - HEADER_H
        const x = vx < FW ? vx : vx + el.scrollLeft
        const y = vy < FH ? vy : vy + el.scrollTop
        return { r: rowAxis.indexAt(y), c: colAxis.indexAt(x) }
    }

    function onScrollbar(e) {
        const el = scrollerRef.current
        const box = el.getBoundingClientRect()
        return e.clientX - box.left >= el.clientWidth || e.clientY - box.top >= el.clientHeight
    }

    function capture(e) {
        scrollerRef.current.setPointerCapture(e.pointerId)
    }

    function autoScroll(clientX, clientY) {
        const el = scrollerRef.current
        const box = el.getBoundingClientRect()
        const dy = clientY > box.bottom - 12 ? DEFAULT_ROW_HEIGHT : clientY < box.top + HEADER_H + FH ? -DEFAULT_ROW_HEIGHT : 0
        const dx = clientX > box.right - 12 ? 40 : clientX < box.left + HEADER_W + FW ? -40 : 0
        if (dx || dy) el.scrollBy(dx, dy)
    }

    function onPointerDown(e) {
        if (e.button !== 0 || onScrollbar(e)) return
        const { r, c } = cellAt(e.clientX, e.clientY)
        const editTarget = editor.getTarget()
        if (editTarget && editTarget.r === r && editTarget.c === c) return
        e.preventDefault()
        onCommitEdit?.()
        scrollerRef.current.focus({ preventScroll: true })
        if (e.shiftKey) onSelectionChange(extendTo(selection, r, c))
        else onSelectionChange(cellSelection(r, c))
        dragRef.current = { mode: 'select', base: e.shiftKey ? selection : cellSelection(r, c) }
        capture(e)
    }

    function onFillPointerDown(e) {
        e.preventDefault()
        e.stopPropagation()
        onCommitEdit?.()
        dragRef.current = { mode: 'fill', source: sel }
        setFillPreview(sel)
        capture(e)
    }

    function onPointerMove(e) {
        const drag = dragRef.current
        if (!drag) return
        if (drag.mode === 'resize-col') {
            setSizePreview({ axis: 'col', index: drag.index, size: Math.max(MIN_COL_WIDTH, drag.start + e.clientX - drag.origin) })
            return
        }
        if (drag.mode === 'resize-row') {
            setSizePreview({ axis: 'row', index: drag.index, size: Math.max(MIN_ROW_HEIGHT, drag.start + e.clientY - drag.origin) })
            return
        }
        autoScroll(e.clientX, e.clientY)
        const { r, c } = cellAt(e.clientX, e.clientY)
        if (drag.mode === 'select') onSelectionChange(extendTo(drag.base, r, c))
        else if (drag.mode === 'header') {
            onSelectionChange({ ...drag.base, focus: drag.kind === 'rows' ? { r, c: cols - 1 } : { r: rows - 1, c } })
        } else if (drag.mode === 'fill') setFillPreview(fillTarget(drag.source, r, c))
    }

    function onPointerUp() {
        const drag = dragRef.current
        dragRef.current = null
        if (!drag) return
        if (drag.mode === 'fill' && fillPreview) {
            const same = ['r1', 'r2', 'c1', 'c2'].every(k => fillPreview[k] === drag.source[k])
            if (!same) onFill(drag.source, fillPreview)
            setFillPreview(null)
        } else if ((drag.mode === 'resize-col' || drag.mode === 'resize-row') && sizePreview) {
            if (drag.mode === 'resize-col') onResizeCol(drag.index, sizePreview.size)
            else onResizeRow(drag.index, sizePreview.size)
            setSizePreview(null)
        }
    }

    function onDoubleClick(e) {
        if (onScrollbar(e) || e.target.closest('.col-header, .row-header, .corner-box')) return
        const { r, c } = cellAt(e.clientX, e.clientY)
        onStartEdit(r, c, null, 'edit')
    }

    function startHeaderSelect(e, kind, index) {
        e.preventDefault()
        e.stopPropagation()
        onCommitEdit?.()
        scrollerRef.current.focus({ preventScroll: true })
        const fresh = kind === 'cols'
            ? { anchor: { r: 0, c: index }, focus: { r: rows - 1, c: index }, kind }
            : { anchor: { r: index, c: 0 }, focus: { r: index, c: cols - 1 }, kind }
        const base = e.shiftKey && selection.kind === kind ? selection : fresh
        const focus = kind === 'cols' ? { r: rows - 1, c: index } : { r: index, c: cols - 1 }
        onSelectionChange(e.shiftKey ? { ...base, focus } : base)
        dragRef.current = { mode: 'header', kind, base }
        capture(e)
    }

    function startResize(e, axis, index) {
        e.preventDefault()
        e.stopPropagation()
        // Double-click detection lives here: pointer capture retargets the
        // dblclick event to the scroller, so the handle never receives it.
        const now = e.timeStamp
        const last = lastResizeDown.current
        if (axis === 'col' && last && last.index === index && now - last.time < 400) {
            lastResizeDown.current = null
            onAutoFit(index)
            return
        }
        lastResizeDown.current = { index, time: now }
        dragRef.current = axis === 'col'
            ? { mode: 'resize-col', index, start: colAxis.size(index), origin: e.clientX }
            : { mode: 'resize-row', index, start: rowAxis.size(index), origin: e.clientY }
        capture(e)
    }

    // ── render helpers ──

    function renderCells(rowList, colList) {
        const out = []
        for (const r of rowList) {
            const y = Y(r), h = rowAxis.size(r)
            for (const c of colList) {
                const text = engine.getDisplay(r, c)
                out.push(
                    <Cell
                        key={r * 16384 + c}
                        r={r}
                        c={c}
                        text={text}
                        x={X(c)}
                        y={y}
                        w={colAxis.size(c)}
                        h={h}
                        style={engine.getStyle(r, c)}
                        error={text[0] === '#' && !!engine.getCell(r, c).error}
                    />,
                )
            }
        }
        return out
    }

    function renderColHeaders(colList) {
        return colList.map(c => {
            const inSel = c >= sel.c1 && c <= sel.c2
            const inData = used && c <= used.c2
            const filtered = !!engine.getFilter(c)
            const sortDir = sortState && sortState.col === c ? sortState.dir : null
            return (
                <div
                    key={c}
                    className={`col-header${inSel ? ' in-selection' : ''}${filtered ? ' filtered' : ''}`}
                    style={{ left: X(c), width: colAxis.size(c) }}
                    onPointerDown={(e) => startHeaderSelect(e, 'cols', c)}
                >
                    <span className="col-label">{colToLetters(c)}</span>
                    {inData && (
                        <span className="header-tools" onPointerDown={(e) => e.stopPropagation()}>
                            <button
                                className={`header-btn${sortDir ? ' on' : ''}`}
                                title={sortDir === 'asc' ? 'Sorted ascending: click for descending'
                                    : sortDir === 'desc' ? 'Sorted descending: click for original order'
                                        : 'Sort ascending'}
                                onClick={() => onSort(c)}
                            >
                                {sortDir === 'asc' ? '↑' : sortDir === 'desc' ? '↓' : '⇅'}
                            </button>
                            <button
                                className={`header-btn${filtered ? ' on' : ''}`}
                                title="Filter"
                                onClick={(e) => onOpenFilter(c, e.currentTarget.getBoundingClientRect())}
                            >
                                {'▾'}
                            </button>
                        </span>
                    )}
                    <div
                        className="col-resize"
                        title="Drag to resize, double-click to fit"
                        onPointerDown={(e) => startResize(e, 'col', c)}
                    />
                </div>
            )
        })
    }

    function renderRowHeaders(rowList) {
        return rowList.map(r => (
            <div
                key={r}
                className={`row-header${r >= sel.r1 && r <= sel.r2 ? ' in-selection' : ''}`}
                style={{ top: Y(r), height: rowAxis.size(r) }}
                onPointerDown={(e) => startHeaderSelect(e, 'rows', r)}
            >
                {r + 1}
                <div className="row-resize" onPointerDown={(e) => startResize(e, 'row', r)} />
            </div>
        ))
    }

    const box = (g) => ({
        left: X(g.c1), top: Y(g.r1),
        width: colAxis.end(g.c2) - colAxis.start(g.c1),
        height: rowAxis.end(g.r2) - rowAxis.start(g.r1),
    })
    const selBox = box(sel)
    const active = selection.anchor
    const activeBox = box({ r1: active.r, c1: active.c, r2: active.r, c2: active.c })
    const paneOf = (r, c) => (r < F ? (c < G ? 'corner' : 'top') : (c < G ? 'left' : 'body'))

    const placeEditor = (r, c) => ({
        x: X(c), y: Y(r), width: colAxis.size(c), height: rowAxis.size(r), style: engine.getStyle(r, c),
    })

    /** Selection, active cell, fill preview, fill handle and editor for one layer. */
    function overlays(pane) {
        return (
            <>
                <div className="selection-box" style={selBox} />
                <div className="active-box" style={activeBox} />
                {fillPreview && <div className="fill-preview" style={box(fillPreview)} />}
                {paneOf(sel.r2, sel.c2) === pane && (
                    <FillHandle
                        editor={editor}
                        x={selBox.left + selBox.width - 4}
                        y={selBox.top + selBox.height - 4}
                        onPointerDown={onFillPointerDown}
                    />
                )}
                <EditorSlot
                    editor={editor}
                    owns={(r, c) => paneOf(r, c) === pane}
                    place={placeEditor}
                    onKeyDown={onEditorKeyDown}
                    onCommitEdit={onCommitEdit}
                />
            </>
        )
    }

    const canvasW = HEADER_W + colAxis.total
    const canvasH = HEADER_H + rowAxis.total
    const topH = HEADER_H + FH
    const leftW = HEADER_W + FW

    return (
        <div
            className="grid-scroller"
            ref={scrollerRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick}
        >
            <div className="grid-canvas" style={{ width: canvasW, height: canvasH }}>
                <div className="layer layer-corner" style={{ width: leftW, height: topH, marginBottom: -topH }}>
                    <div className="corner-box" onPointerDown={(e) => {
                        e.preventDefault(); e.stopPropagation()
                        onSelectionChange({ anchor: { r: 0, c: 0 }, focus: { r: rows - 1, c: cols - 1 }, kind: 'cells' })
                    }} />
                    {renderColHeaders(frozenCols)}
                    {renderRowHeaders(frozenRows)}
                    {renderCells(frozenRows, frozenCols)}
                    {overlays('corner')}
                </div>
                <div className="layer layer-top" style={{ width: canvasW, height: topH, marginBottom: -topH }}>
                    {renderColHeaders(scrollCols)}
                    {renderCells(frozenRows, scrollCols)}
                    {overlays('top')}
                </div>
                <div className="layer layer-left" style={{ width: leftW, height: canvasH, marginBottom: -canvasH }}>
                    {renderRowHeaders(scrollRows)}
                    {renderCells(scrollRows, frozenCols)}
                    {overlays('left')}
                </div>
                <div className="layer layer-body" style={{ width: canvasW, height: canvasH }}>
                    {renderCells(scrollRows, scrollCols)}
                    {overlays('body')}
                </div>
                {sizePreview && (
                    <div
                        className={sizePreview.axis === 'col' ? 'resize-guide-v' : 'resize-guide-h'}
                        style={sizePreview.axis === 'col'
                            ? { left: X(sizePreview.index) + sizePreview.size - 1, height: canvasH }
                            : { top: Y(sizePreview.index) + sizePreview.size - 1, width: canvasW }}
                    />
                )}
            </div>
        </div>
    )
}
