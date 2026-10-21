import { useRef, useState, useSyncExternalStore } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { cellName, rangeName } from './engine/refs.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'
import Grid from './grid/Grid.jsx'
import Toolbar from './grid/Toolbar.jsx'
import FormulaBar from './grid/FormulaBar.jsx'
import { createEditorStore } from './grid/editorStore.js'
import { cellSelection, selectionRect, effectiveRect, extendTo, isSingleCell } from './grid/selection.js'

const TOTAL_ROWS = 100000
const TOTAL_COLS = 200

export default function App() {
    // The engine owns all sheet state. React only tracks its version number
    // (to re-render) plus UI state: the selection and what is being edited.
    const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
    const [editor] = useState(createEditorStore)
    const version = useSyncExternalStore(engine.subscribe, () => engine.version)
    const [selection, setSelection] = useState(() => cellSelection(0, 0))
    const gridApi = useRef(null)

    const { rows, cols } = engine
    const active = selection.anchor
    const clamp = (r, c) => ({ r: Math.max(0, Math.min(rows - 1, r)), c: Math.max(0, Math.min(cols - 1, c)) })

    // ── selection and navigation ──

    function select(next, scroll = true) {
        setSelection(next)
        if (scroll) gridApi.current?.scrollIntoView(next.focus.r, next.focus.c)
    }

    function moveActive(dr, dc) {
        const p = clamp(active.r + dr, active.c + dc)
        select(cellSelection(p.r, p.c))
    }

    // ── editing ──

    function startEdit(r, c, initial, mode, source = 'cell') {
        editor.start(r, c, initial ?? engine.getRaw(r, c), mode, source)
    }

    function commitEdit(move) {
        const target = editor.getTarget()
        if (!target) return
        const value = editor.getValue()
        editor.stop()
        if (engine.getRaw(target.r, target.c) !== value) engine.setCell(target.r, target.c, value)
        if (move === 'down') moveActive(1, 0)
        else if (move === 'up') moveActive(-1, 0)
        else if (move === 'right') moveActive(0, 1)
        else if (move === 'left') moveActive(0, -1)
        if (move !== 'blur') gridApi.current?.focus()
    }

    function cancelEdit() {
        editor.stop()
        gridApi.current?.focus()
    }

    function onEditorKeyDown(e) {
        const target = editor.getTarget()
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(e.shiftKey ? 'up' : 'down') }
        else if (e.key === 'Tab') { e.preventDefault(); commitEdit(e.shiftKey ? 'left' : 'right') }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
        else if (target?.mode === 'enter' && e.key.startsWith('Arrow')) {
            e.preventDefault()
            commitEdit({ ArrowDown: 'down', ArrowUp: 'up', ArrowLeft: 'left', ArrowRight: 'right' }[e.key])
        } else if (e.key === 'F2') {
            editor.setMode(target?.mode === 'enter' ? 'edit' : 'enter')
        }
    }

    // ── commands ──

    const selRect = () => effectiveRect(selection, rows, cols, engine.usedRange())

    const applyStyle = (patch) => engine.applyStyle(selRect(), patch)

    const toggle = (prop) => applyStyle({ [prop]: !engine.getStyle(active.r, active.c)[prop] })

    const fillFromEdge = (vertical) => {
        const g = selRect()
        const source = vertical ? { ...g, r2: g.r1 } : { ...g, c2: g.c1 }
        if ((vertical && g.r2 > g.r1) || (!vertical && g.c2 > g.c1)) engine.fill(source, g)
    }

    const commands = {
        undo: () => engine.undo(),
        redo: () => engine.redo(),
        bold: () => toggle('bold'),
        italic: () => toggle('italic'),
        underline: () => toggle('underline'),
        style: applyStyle,
        clear: () => engine.clearRange(selRect()),
        clearAll: () => { engine.clearAll(); select(cellSelection(0, 0)) },
        insertRows: () => {
            const g = selectionRect(selection, rows, cols)
            engine.insertRows(g.r1, selection.kind === 'rows' ? g.r2 - g.r1 + 1 : 1)
        },
        deleteRows: () => {
            const g = selectionRect(selection, rows, cols)
            engine.deleteRows(g.r1, selection.kind === 'rows' ? g.r2 - g.r1 + 1 : 1)
        },
        insertCols: () => {
            const g = selectionRect(selection, rows, cols)
            engine.insertColumns(g.c1, selection.kind === 'cols' ? g.c2 - g.c1 + 1 : 1)
        },
        deleteCols: () => {
            const g = selectionRect(selection, rows, cols)
            engine.deleteColumns(g.c1, selection.kind === 'cols' ? g.c2 - g.c1 + 1 : 1)
        },
        loadSample: (loader) => {
            engine.transact('Load sample', () => { engine.clearAll(); loader(engine) })
            select(cellSelection(0, 0))
        },
        loadSmall: () => commands.loadSample(loadSampleSmall),
        loadLarge: () => commands.loadSample(loadSampleLarge),
    }

    // ── keyboard (grid focused, not editing) ──

    function onGridKeyDown(e) {
        if (editor.getTarget()) return
        const mod = e.ctrlKey || e.metaKey
        const key = e.key
        const lower = key.length === 1 ? key.toLowerCase() : key

        if (mod) {
            const handled = {
                z: () => (e.shiftKey ? commands.redo() : commands.undo()),
                y: commands.redo,
                b: commands.bold,
                i: commands.italic,
                u: commands.underline,
                d: () => fillFromEdge(true),
                r: () => fillFromEdge(false),
                a: () => {
                    const used = engine.usedRange()
                    if (used) select({ anchor: { r: 0, c: 0 }, focus: { r: used.r2, c: used.c2 }, kind: 'cells' }, false)
                },
            }[lower]
            if (handled) { e.preventDefault(); handled(); return }
        }

        const arrows = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }
        if (arrows[key]) {
            e.preventDefault()
            const [dr, dc] = arrows[key]
            if (e.shiftKey) {
                const p = clamp(selection.focus.r + dr, selection.focus.c + dc)
                select(extendTo({ ...selection, kind: 'cells' }, p.r, p.c))
            } else {
                moveActive(dr, dc)
            }
            return
        }

        switch (key) {
            case 'Enter':
            case 'F2':
                e.preventDefault()
                startEdit(active.r, active.c, null, 'edit')
                return
            case 'Tab':
                e.preventDefault()
                moveActive(0, e.shiftKey ? -1 : 1)
                return
            case 'Delete':
            case 'Backspace':
                e.preventDefault()
                commands.clear()
                return
        }

        if (key.length === 1 && !mod && !e.altKey) {
            e.preventDefault()
            startEdit(active.r, active.c, key, 'enter')
        }
    }

    const nameLabel = isSingleCell(selection)
        ? cellName(active.r, active.c)
        : rangeName(selectionRect(selection, rows, cols))

    return (
        <div className="app-wrapper">
            <div className="app-header">
                <h2 className="app-title">Spreadsheet</h2>
            </div>
            <div className="main-content">
                <Toolbar engine={engine} version={version} active={active} commands={commands} />
                <FormulaBar
                    engine={engine}
                    editor={editor}
                    active={active}
                    nameLabel={nameLabel}
                    onStartEdit={startEdit}
                    onKeyDown={onEditorKeyDown}
                    onCommit={commitEdit}
                />
                <Grid
                    engine={engine}
                    version={version}
                    selection={selection}
                    onSelectionChange={(s) => select(s, false)}
                    editor={editor}
                    onStartEdit={startEdit}
                    onEditorKeyDown={onEditorKeyDown}
                    onCommitEdit={commitEdit}
                    onFill={(source, target) => {
                        engine.fill(source, target)
                        select({ anchor: { r: target.r1, c: target.c1 }, focus: { r: target.r2, c: target.c2 }, kind: 'cells' }, false)
                    }}
                    onKeyDown={onGridKeyDown}
                    apiRef={gridApi}
                />
                <div className="status-bar">
                    <span>Click to select · double-click, Enter, F2 or type to edit · drag the corner square to fill · Ctrl+D / Ctrl+R fill down / right</span>
                </div>
            </div>
        </div>
    )
}
