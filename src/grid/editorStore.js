// ─────────────────────────────────────────────────────────────
//  The text being edited lives here, outside React state, so a
//  keystroke re-renders only the cell editor and the formula bar,
//  never the grid.
//
//  target: { r, c, mode, source } | null
//    mode 'enter' (started by typing): arrow keys commit and move
//    mode 'edit'  (F2, Enter, double-click, formula bar): arrows move the caret
//    source 'cell' | 'bar': which input owns the focus
// ─────────────────────────────────────────────────────────────

export function createEditorStore() {
    let target = null
    let value = ''
    const listeners = new Set()
    const emit = () => { for (const fn of listeners) fn() }

    return {
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
        getTarget: () => target,
        getValue: () => value,
        start(r, c, initial, mode, source = 'cell') { target = { r, c, mode, source }; value = initial; emit() },
        setValue(next) { value = next; emit() },
        setMode(mode) { if (target && target.mode !== mode) { target = { ...target, mode }; emit() } },
        setSource(source) { if (target && target.source !== source) { target = { ...target, source }; emit() } },
        stop() { target = null; value = ''; emit() },
    }
}
