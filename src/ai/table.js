// ─────────────────────────────────────────────────────────────
//  A plain snapshot of the sheet for the AI side: header row plus
//  every row below it to the last used row, as text before number
//  formatting (what the grid shows with format "general"). Pure
//  data; the executor and the applier never see the engine.
// ─────────────────────────────────────────────────────────────

/** @returns {{ header: string[], rows: string[][], colCount: number }} */
export function readTable(engine) {
    const used = engine.usedRange()
    if (!used) return { header: [], rows: [], colCount: 0 }
    const colCount = used.c2 + 1
    const read = (r) => {
        const out = new Array(colCount)
        for (let c = 0; c < colCount; c++) out[c] = engine.getText(r, c)
        return out
    }
    const header = read(0)
    const rows = []
    for (let r = 1; r <= used.r2; r++) rows.push(read(r))
    return { header, rows, colCount }
}
