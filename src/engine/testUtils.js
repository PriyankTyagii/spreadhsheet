// Test helpers: load a fixture without Vite's ?raw imports.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createEngine } from './core.js'
import { parseCellName, parseRangeName } from './refs.js'

export function fixtureText(name) {
    return readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), 'utf8')
}

export function parseTsv(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return lines.map(l => l.split('\t'))
}

export function loadFixture(name, rows = 200, cols = 30) {
    const engine = createEngine(rows, cols)
    const data = parseTsv(fixtureText(name))
    engine.ensureCapacity(data.length + 20, 15)
    engine.setValues(0, 0, data)
    return engine
}

/** Small A1-notation conveniences for readable tests. */
export function a1(engine) {
    const at = (name) => parseCellName(name)
    return {
        raw: (n) => { const p = at(n); return engine.getRaw(p.row, p.col) },
        value: (n) => { const p = at(n); return engine.getValue(p.row, p.col) },
        display: (n) => { const p = at(n); return engine.getDisplay(p.row, p.col) },
        style: (n) => { const p = at(n); return engine.getStyle(p.row, p.col) },
        set: (n, v) => { const p = at(n); engine.setCell(p.row, p.col, v) },
        range: (t) => parseRangeName(t),
    }
}
