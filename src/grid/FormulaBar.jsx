import { useSyncExternalStore } from 'react'

/**
 * Name box + formula bar. While a cell is being edited the bar mirrors the
 * editor store; otherwise it shows the active cell's raw content.
 */
export default function FormulaBar({ engine, editor, active, nameLabel, onStartEdit, onKeyDown, onCommit }) {
    const target = useSyncExternalStore(editor.subscribe, editor.getTarget)
    const value = useSyncExternalStore(editor.subscribe, editor.getValue)
    const shown = target ? value : engine.getRaw(active.r, active.c)

    return (
        <div className="formula-bar">
            <span className="name-box">{nameLabel}</span>
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
