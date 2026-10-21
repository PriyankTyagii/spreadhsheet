const FILLS = [
    ['white', 'White'], ['#ffff99', 'Yellow'], ['#99ffcc', 'Green'], ['#ffcccc', 'Red'],
    ['#cce5ff', 'Blue'], ['#e0ccff', 'Purple'], ['#ffd9b3', 'Orange'], ['#f0f0f0', 'Gray'],
]
const FORMATS = [['general', 'General'], ['number', '1,200.00'], ['currency', '$1,200.00'], ['percent', '10%'], ['date', '2024-01-15']]

/** Formatting applies to the whole selection; each control is one undo step. */
export default function Toolbar({ engine, active, commands, children }) {
    const style = engine.getStyle(active.r, active.c)
    const btn = (label, title, onClick, extra = '', disabled = false) => (
        <button className={`toolbar-btn ${extra}`} title={title} onClick={onClick} disabled={disabled}>{label}</button>
    )

    return (
        <div className="toolbar">
            <div className="toolbar-group">
                {btn('Undo', 'Undo (Ctrl+Z)', commands.undo, '', !engine.canUndo())}
                {btn('Redo', 'Redo (Ctrl+Shift+Z)', commands.redo, '', !engine.canRedo())}
            </div>
            <div className="toolbar-group">
                {btn('B', 'Bold (Ctrl+B)', commands.bold, `bold-btn ${style.bold ? 'active' : ''}`)}
                {btn('I', 'Italic (Ctrl+I)', commands.italic, `italic-btn ${style.italic ? 'active' : ''}`)}
                {btn('U', 'Underline (Ctrl+U)', commands.underline, `underline-btn ${style.underline ? 'active' : ''}`)}
                <select className="toolbar-select" title="Font size" value={style.fontSize}
                    onChange={(e) => commands.style({ fontSize: parseInt(e.target.value, 10) })}>
                    {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
            </div>
            <div className="toolbar-group">
                {['left', 'center', 'right'].map(a => (
                    <button key={a} className={`toolbar-btn ${style.align === a ? 'active' : ''}`}
                        title={`Align ${a}`} onClick={() => commands.style({ align: a })}>
                        {a[0].toUpperCase() + a.slice(1)}
                    </button>
                ))}
            </div>
            <div className="toolbar-group">
                <label className="toolbar-label" htmlFor="text-color">Text</label>
                <input id="text-color" type="color" className="color-input" value={style.color}
                    onChange={(e) => commands.style({ color: e.target.value })} title="Text colour" />
                <label className="toolbar-label" htmlFor="fill-color">Fill</label>
                <select id="fill-color" className="toolbar-select" value={style.bg}
                    onChange={(e) => commands.style({ bg: e.target.value })}>
                    {FILLS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <select className="toolbar-select" title="Number format" value={style.numberFormat}
                    onChange={(e) => commands.style({ numberFormat: e.target.value })}>
                    {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
            </div>
            <div className="toolbar-group">
                {btn('+ Row', 'Insert row above', commands.insertRows)}
                {btn('- Row', 'Delete row', commands.deleteRows)}
                {btn('+ Col', 'Insert column to the left', commands.insertCols)}
                {btn('- Col', 'Delete column', commands.deleteCols)}
            </div>
            <div className="toolbar-group">
                {btn('Clear', 'Clear selection (Delete)', commands.clear, 'danger')}
                {btn('Clear all', 'Clear the sheet', commands.clearAll, 'danger')}
            </div>
            {children}
            <div className="toolbar-group">
                {btn('Sample 33', 'Load fixtures/sales.tsv at A1', commands.loadSmall)}
                {btn('Sample 3k', 'Load fixtures/sales-large.tsv at A1', commands.loadLarge)}
            </div>
        </div>
    )
}
