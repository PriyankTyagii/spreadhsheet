import { useEffect, useMemo, useRef, useState } from 'react'
import { colToLetters } from '../engine/refs.js'

const CONDITIONS = [
    ['', 'No condition'],
    ['contains', 'Text contains'],
    ['gt', 'Greater than'],
    ['lt', 'Less than'],
    ['isEmpty', 'Is empty'],
    ['notEmpty', 'Is not empty'],
]

/**
 * Filter dropdown for one column: search, a checklist of distinct values
 * (trimmed, case-insensitive, first-seen label) plus (Blanks), and one
 * condition. Apply writes one undoable filter change.
 */
export default function FilterMenu({ engine, col, x, y, onClose }) {
    const ref = useRef(null)
    const existing = engine.getFilter(col)
    const values = useMemo(() => engine.distinctValues(col), [engine, col])
    const [query, setQuery] = useState('')
    const [checked, setChecked] = useState(() => new Set(existing?.values ?? values.map(v => v.key)))
    const [op, setOp] = useState(existing?.condition?.op ?? '')
    const [operand, setOperand] = useState(existing?.condition?.value ?? '')

    useEffect(() => {
        const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('pointerdown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('pointerdown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [onClose])

    const shown = values.filter(v => v.label.toLowerCase().includes(query.trim().toLowerCase()))
    const toggle = (key) => setChecked(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    })

    function apply() {
        const allChecked = values.every(v => checked.has(v.key))
        const spec = {
            values: allChecked ? null : [...checked],
            condition: op ? { op, value: operand } : null,
        }
        engine.setFilter(col, spec.values || spec.condition ? spec : null)
        onClose()
    }

    function clear() {
        engine.setFilter(col, null)
        onClose()
    }

    const header = engine.getText(0, col)
    const left = Math.min(x, window.innerWidth - 280)

    return (
        <div className="filter-menu" ref={ref} style={{ left, top: y }}>
            <div className="filter-title">Filter {colToLetters(col)}{header ? ` · ${header}` : ''}</div>
            <input className="filter-search" placeholder="Search values" value={query} autoFocus
                onChange={(e) => setQuery(e.target.value)} />
            <div className="filter-actions">
                <button className="link-btn" onClick={() => setChecked(new Set(values.map(v => v.key)))}>Select all</button>
                <button className="link-btn" onClick={() => setChecked(new Set())}>Select none</button>
            </div>
            <div className="filter-list">
                {shown.map(v => (
                    <label key={v.key} className="filter-item">
                        <input type="checkbox" checked={checked.has(v.key)} onChange={() => toggle(v.key)} />
                        <span className="filter-label">{v.label}</span>
                        <span className="filter-count">{v.count}</span>
                    </label>
                ))}
                {!shown.length && <div className="filter-empty">No values match</div>}
            </div>
            <div className="filter-condition">
                <select className="toolbar-select" value={op} onChange={(e) => setOp(e.target.value)}>
                    {CONDITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {(op === 'contains' || op === 'gt' || op === 'lt') && (
                    <input className="filter-search" value={operand} placeholder={op === 'contains' ? 'text' : 'number or date'}
                        onChange={(e) => setOperand(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') apply() }} />
                )}
            </div>
            <div className="filter-footer">
                <button className="toolbar-btn" onClick={clear} disabled={!existing}>Clear</button>
                <button className="toolbar-btn primary" onClick={apply}>Apply</button>
            </div>
        </div>
    )
}
