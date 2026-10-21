// ─────────────────────────────────────────────────────────────
//  A1 coordinates. Rows and columns are 0-based internally;
//  "A1" is { row: 0, col: 0 }.
// ─────────────────────────────────────────────────────────────

export function colToLetters(col) {
    let label = ''
    let n = col + 1
    while (n > 0) {
        n--
        label = String.fromCharCode(65 + (n % 26)) + label
        n = Math.floor(n / 26)
    }
    return label
}

export function lettersToCol(letters) {
    let index = 0
    const s = letters.toUpperCase()
    for (let i = 0; i < s.length; i++) index = index * 26 + (s.charCodeAt(i) - 64)
    return index - 1
}

export function cellName(row, col) {
    return colToLetters(col) + (row + 1)
}

/** "B7" → { row: 6, col: 1 }; also accepts "$B$7". null when malformed. */
export function parseCellName(name) {
    const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(name).trim())
    if (!m) return null
    const row = parseInt(m[2], 10) - 1
    if (row < 0) return null
    return { row, col: lettersToCol(m[1]) }
}

/** A normalised rectangle { r1, c1, r2, c2 } with r1 <= r2, c1 <= c2. */
export function rect(r1, c1, r2, c2) {
    return {
        r1: Math.min(r1, r2), c1: Math.min(c1, c2),
        r2: Math.max(r1, r2), c2: Math.max(c1, c2),
    }
}

/** "A1:C5" or "B7" → rect, or null. */
export function parseRangeName(text) {
    const parts = String(text).trim().split(':')
    if (parts.length > 2) return null
    const a = parseCellName(parts[0])
    const b = parts.length === 2 ? parseCellName(parts[1]) : a
    if (!a || !b) return null
    return rect(a.row, a.col, b.row, b.col)
}

export function rangeName(r) {
    const a = cellName(r.r1, r.c1)
    return r.r1 === r.r2 && r.c1 === r.c2 ? a : `${a}:${cellName(r.r2, r.c2)}`
}

// Cells are keyed by a single integer: faster Map lookups than strings and
// trivially decoded. 16384 columns is the Excel limit and keeps
// 1,048,576 rows well inside Number.MAX_SAFE_INTEGER.
export const MAX_COLS = 16384

export function keyOf(row, col) { return row * MAX_COLS + col }
export function rowOf(key) { return Math.floor(key / MAX_COLS) }
export function colOf(key) { return key % MAX_COLS }
