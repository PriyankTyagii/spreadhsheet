// ─────────────────────────────────────────────────────────────
//  Virtualized grid. Only the rows and columns in the viewport
//  (plus overscan) are rendered; positions come from prefix-sum
//  axes. There is no React state per cell: a render reads the
//  engine directly for the ~800 visible cells.
//
//  Layout: one scroller holds a canvas the size of the whole sheet.
//  Column headers, row headers and the corner are zero-size
//  `position: sticky` panes, so they stay put while scrolling and
//  are synced by the browser itself, with no scroll-event lag.
// ─────────────────────────────────────────────────────────────
import { useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createAxis } from './axis.js'
import { selectionRect, fillTarget, extendTo, cellSelection } from './selection.js'
import { colToLetters } from '../engine/refs.js'

export const HEADER_H = 24
export const HEADER_W = 56
const OVERSCAN_ROWS = 6
const OVERSCAN_COLS = 3

function cellCss(style) {
    return {
        fontWeight: style.bold ? 700 : 400,
        fontStyle: style.italic ? 'italic' : 'normal',
        textDecoration: style.underline ? 'underline' : 'none',
        color: style.color,
        background: style.bg,
        fontSize: style.fontSize,
        textAlign: style.align,
    }
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

export default function Grid({
    engine, version, selection, onSelectionChange, editor, onStartEdit, onEditorKeyDown,
    onCommitEdit, onFill, onKeyDown, onSort, onOpenFilter, apiRef,
}) {
    const scrollerRef = useRef(null)
    const bodyRef = useRef(null)
    const dragRef = useRef(null)
    const [viewport, setViewport] = useState({ top: 0, left: 0, width: 1200, height: 700 })
    const [fillPreview, setFillPreview] = useState(null)
    const editTarget = useSyncExternalStore(editor.subscribe, editor.getTarget)

    const { rows, cols } = engine
    const rowAxis = useMemo(
        () => createAxis(rows, (r) => (engine.isRowHidden && engine.isRowHidden(r) ? 0 : engine.rowHeight(r))),
        // version: sizes or hidden rows may have changed
        [engine, rows, version], // eslint-disable-line react-hooks/exhaustive-deps
    )
    const colAxis = useMemo(
        () => createAxis(cols, (c) => engine.colWidth(c)),
        [engine, cols, version], // eslint-disable-line react-hooks/exhaustive-deps
    )

    // ── viewport tracking ──
    useEffect(() => {
        const el = scrollerRef.current
        let frame = 0
        const read = () => {
            frame = 0
            setViewport({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight })
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
            const top = rowAxis.start(r), bottom = rowAxis.end(r)
            const left = colAxis.start(c), right = colAxis.end(c)
            const viewH = el.clientHeight - HEADER_H, viewW = el.clientWidth - HEADER_W
            if (top < el.scrollTop) el.scrollTop = top
            else if (bottom > el.scrollTop + viewH) el.scrollTop = bottom - viewH
            if (left < el.scrollLeft) el.scrollLeft = left
            else if (right > el.scrollLeft + viewW) el.scrollLeft = right - viewW
        },
        pageRows() {
            const el = scrollerRef.current
            return Math.max(1, Math.floor(((el?.clientHeight ?? 600) - HEADER_H) / 24) - 1)
        },
    }), [rowAxis, colAxis])

    // ── visible window ──
    const r0 = Math.max(0, rowAxis.indexAt(viewport.top) - OVERSCAN_ROWS)
    const r1 = Math.min(rows - 1, rowAxis.indexAt(viewport.top + viewport.height) + OVERSCAN_ROWS)
    const c0 = Math.max(0, colAxis.indexAt(viewport.left) - OVERSCAN_COLS)
    const c1 = Math.min(cols - 1, colAxis.indexAt(viewport.left + viewport.width) + OVERSCAN_COLS)

    const visibleRows = []
    for (let r = r0; r <= r1; r++) if (rowAxis.size(r) > 0) visibleRows.push(r)
    const visibleCols = []
    for (let c = c0; c <= c1; c++) visibleCols.push(c)

    const sel = selectionRect(selection, rows, cols)
    const used = engine.usedRange()
    const sortState = engine.sortState

    // ── pointer handling ──
    function cellAt(clientX, clientY) {
        const box = bodyRef.current.getBoundingClientRect()
        return { r: rowAxis.indexAt(clientY - box.top), c: colAxis.indexAt(clientX - box.left) }
    }

    function autoScroll(clientX, clientY) {
        const el = scrollerRef.current
        const box = el.getBoundingClientRect()
        const dy = clientY > box.bottom - 10 ? 24 : clientY < box.top + HEADER_H ? -24 : 0
        const dx = clientX > box.right - 10 ? 40 : clientX < box.left + HEADER_W ? -40 : 0
        if (dx || dy) el.scrollBy(dx, dy)
    }

    function onBodyPointerDown(e) {
        if (e.button !== 0) return
        const { r, c } = cellAt(e.clientX, e.clientY)
        if (editTarget && editTarget.r === r && editTarget.c === c) return
        e.preventDefault()
        onCommitEdit?.()
        scrollerRef.current.focus({ preventScroll: true })
        if (e.shiftKey) onSelectionChange(extendTo(selection, r, c))
        else onSelectionChange(cellSelection(r, c))
        dragRef.current = { mode: 'select', base: e.shiftKey ? selection : cellSelection(r, c) }
        bodyRef.current.setPointerCapture(e.pointerId)
    }

    function onFillPointerDown(e) {
        e.preventDefault()
        e.stopPropagation()
        onCommitEdit?.()
        dragRef.current = { mode: 'fill', source: sel }
        setFillPreview(sel)
        bodyRef.current.setPointerCapture(e.pointerId)
    }

    function onBodyPointerMove(e) {
        const drag = dragRef.current
        if (!drag) return
        autoScroll(e.clientX, e.clientY)
        const { r, c } = cellAt(e.clientX, e.clientY)
        if (drag.mode === 'select') {
            onSelectionChange(extendTo(drag.base, r, c))
        } else if (drag.mode === 'header') {
            onSelectionChange({ ...drag.base, focus: drag.kind === 'rows' ? { r, c: cols - 1 } : { r: rows - 1, c } })
        } else {
            setFillPreview(fillTarget(drag.source, r, c))
        }
    }

    function onBodyPointerUp() {
        const drag = dragRef.current
        dragRef.current = null
        if (drag && drag.mode === 'fill' && fillPreview) {
            const same = ['r1', 'r2', 'c1', 'c2'].every(k => fillPreview[k] === drag.source[k])
            if (!same) onFill(drag.source, fillPreview)
            setFillPreview(null)
        }
    }

    function onDoubleClick(e) {
        const { r, c } = cellAt(e.clientX, e.clientY)
        onStartEdit(r, c, null, 'edit')
    }

    function onColHeaderPointerDown(e, c) {
        e.preventDefault()
        onCommitEdit?.()
        scrollerRef.current.focus({ preventScroll: true })
        const base = e.shiftKey && selection.kind === 'cols'
            ? selection
            : { anchor: { r: 0, c }, focus: { r: rows - 1, c }, kind: 'cols' }
        onSelectionChange(e.shiftKey ? { ...base, focus: { r: rows - 1, c } } : base)
        dragRef.current = { mode: 'header', kind: 'cols', base }
        bodyRef.current.setPointerCapture(e.pointerId)
    }

    function onRowHeaderPointerDown(e, r) {
        e.preventDefault()
        onCommitEdit?.()
        scrollerRef.current.focus({ preventScroll: true })
        const base = e.shiftKey && selection.kind === 'rows'
            ? selection
            : { anchor: { r, c: 0 }, focus: { r, c: cols - 1 }, kind: 'rows' }
        onSelectionChange(e.shiftKey ? { ...base, focus: { r, c: cols - 1 } } : base)
        dragRef.current = { mode: 'header', kind: 'rows', base }
        bodyRef.current.setPointerCapture(e.pointerId)
    }

    // ── render ──
    const cellsOut = []
    for (const r of visibleRows) {
        const y = rowAxis.start(r), h = rowAxis.size(r)
        for (const c of visibleCols) {
            const text = engine.getDisplay(r, c)
            const style = engine.getStyle(r, c)
            const isError = text[0] === '#' && engine.getCell(r, c).error
            cellsOut.push(
                <div
                    key={r * 16384 + c}
                    data-r={r}
                    data-c={c}
                    className={isError ? 'cell error' : 'cell'}
                    style={{ left: colAxis.start(c), top: y, width: colAxis.size(c), height: h, ...cellCss(style) }}
                >
                    {text}
                </div>,
            )
        }
    }

    const selBox = {
        left: colAxis.start(sel.c1), top: rowAxis.start(sel.r1),
        width: colAxis.end(sel.c2) - colAxis.start(sel.c1), height: rowAxis.end(sel.r2) - rowAxis.start(sel.r1),
    }
    const active = selection.anchor
    const activeBox = {
        left: colAxis.start(active.c), top: rowAxis.start(active.r),
        width: colAxis.size(active.c), height: rowAxis.size(active.r),
    }
    const preview = fillPreview && {
        left: colAxis.start(fillPreview.c1), top: rowAxis.start(fillPreview.r1),
        width: colAxis.end(fillPreview.c2) - colAxis.start(fillPreview.c1),
        height: rowAxis.end(fillPreview.r2) - rowAxis.start(fillPreview.r1),
    }

    return (
        <div className="grid-scroller" ref={scrollerRef} tabIndex={0} onKeyDown={onKeyDown}>
            <div className="grid-canvas" style={{ width: HEADER_W + colAxis.total, height: HEADER_H + rowAxis.total }}>
                <div className="pane-top">
                    {visibleCols.map(c => {
                        const inSel = c >= sel.c1 && c <= sel.c2
                        const inData = used && c <= used.c2
                        const filtered = !!engine.getFilter(c)
                        const sortDir = sortState && sortState.col === c ? sortState.dir : null
                        return (
                            <div
                                key={c}
                                className={`col-header${inSel ? ' in-selection' : ''}${filtered ? ' filtered' : ''}`}
                                style={{ left: HEADER_W + colAxis.start(c), width: colAxis.size(c) }}
                                onPointerDown={(e) => onColHeaderPointerDown(e, c)}
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
                                            {sortDir === 'asc' ? '\u2191' : sortDir === 'desc' ? '\u2193' : '\u21C5'}
                                        </button>
                                        <button
                                            className={`header-btn${filtered ? ' on' : ''}`}
                                            title="Filter"
                                            onClick={(e) => onOpenFilter(c, e.currentTarget.getBoundingClientRect())}
                                        >
                                            {'\u25BE'}
                                        </button>
                                    </span>
                                )}
                            </div>
                        )
                    })}
                </div>
                <div className="pane-left">
                    {visibleRows.map(r => {
                        const inSel = r >= sel.r1 && r <= sel.r2
                        return (
                            <div
                                key={r}
                                className={`row-header${inSel ? ' in-selection' : ''}`}
                                style={{ top: HEADER_H + rowAxis.start(r), height: rowAxis.size(r) }}
                                onPointerDown={(e) => onRowHeaderPointerDown(e, r)}
                            >
                                {r + 1}
                            </div>
                        )
                    })}
                </div>
                <div className="pane-corner" onPointerDown={(e) => { e.preventDefault(); onSelectionChange({ anchor: { r: 0, c: 0 }, focus: { r: rows - 1, c: cols - 1 }, kind: 'cells' }) }} />

                <div
                    ref={bodyRef}
                    className="pane-body"
                    style={{ left: HEADER_W, top: HEADER_H, width: colAxis.total, height: rowAxis.total }}
                    onPointerDown={onBodyPointerDown}
                    onPointerMove={onBodyPointerMove}
                    onPointerUp={onBodyPointerUp}
                    onDoubleClick={onDoubleClick}
                >
                    {cellsOut}
                    <div className="selection-box" style={selBox} />
                    <div className="active-box" style={activeBox} />
                    {preview && <div className="fill-preview" style={preview} />}
                    {!editTarget && (
                        <div
                            className="fill-handle"
                            style={{ left: selBox.left + selBox.width - 4, top: selBox.top + selBox.height - 4 }}
                            onPointerDown={onFillPointerDown}
                        />
                    )}
                    {editTarget && (
                        <CellEditor
                            editor={editor}
                            x={colAxis.start(editTarget.c)}
                            y={rowAxis.start(editTarget.r)}
                            width={colAxis.size(editTarget.c)}
                            height={rowAxis.size(editTarget.r)}
                            style={engine.getStyle(editTarget.r, editTarget.c)}
                            autoFocus={editTarget.source !== 'bar'}
                            onKeyDown={onEditorKeyDown}
                            onFocus={() => editor.setSource('cell')}
                            onBlur={(e) => { if (!e.relatedTarget?.hasAttribute('data-formula-bar')) onCommitEdit?.('blur') }}
                        />
                    )}
                </div>
            </div>
        </div>
    )
}
