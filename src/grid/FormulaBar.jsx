import { useState, useSyncExternalStore } from 'react'

function NameBox({ label, onNavigate }) {
    // While focused the box holds what the user types; otherwise it mirrors
    // the selection. Enter jumps (AZ5000, K2:K100000), Escape gives up.
    const [draft, setDraft] = useState(null)
    const [invalid, setInvalid] = useState(false)
    return (
        <input
            className={`name-box${invalid ? ' invalid' : ''}`}
            value={draft ?? label}
            spellCheck={false}
            aria-label="Name box"
            onFocus={(e) => { setDraft(label); e.target.select() }}
            onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
            onBlur={() => { setDraft(null); setInvalid(false) }}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    e.preventDefault()
                    if (onNavigate(draft ?? '')) { setDraft(null); setInvalid(false) }
                    else setInvalid(true)
                } else if (e.key === 'Escape') {
                    setDraft(null)
                    e.target.blur()
                }
            }}
        />
    )
}

/**
 * Name box + formula bar. While a cell is being edited the bar mirrors the
 * editor store; otherwise it shows the active cell's raw content.
 */
export default function FormulaBar({ engine, editor, active, nameLabel, onNavigate, onStartEdit, onKeyDown, onCommit }) {
    const target = useSyncExternalStore(editor.subscribe, editor.getTarget)
    const value = useSyncExternalStore(editor.subscribe, editor.getValue)
    const shown = target ? value : engine.getRaw(active.r, active.c)

    return (
        <div className="formula-bar">
            <NameBox label={nameLabel} onNavigate={onNavigate} />
            <span className="fx">fx</span>
            <input
                className="formula-bar-input"
                data-formula-bar
                value={shown}
                spellCheck={false}
                onFocus={() => {
                    if (!target) onStartEdit(active.r, active.c, null, 'edit', 'bar')
                    else editor.setSource('bar')
                }}
                onChange={(e) => editor.setValue(e.target.value)}
                onKeyDown={onKeyDown}
                onBlur={(e) => { if (!e.relatedTarget?.hasAttribute('data-cell-editor')) onCommit('blur') }}
                placeholder="Select a cell, then type a value or a formula like =SUM(A1:A5)"
            />
        </div>
    )
}
