import { describe, it, expect } from 'vitest'
import formats from '../../fixtures/ai-eval/format-prompts.json'
import { loadFixture } from '../engine/testUtils.js'
import { parseCellName } from '../engine/refs.js'
import { formatView } from './table.js'
import { planFormat, looksLikeTotals } from './formatApplier.js'
import { parseAction } from './actions.js'
import { createMockProvider } from './mockProvider.js'

// Deterministic stand-in for canvas measureText: 7px per character.
const measure = (text) => text.length * 7

function apply(engine, action) {
    const plan = planFormat(formatView(engine), action)
    if (plan.error) return plan.error
    return engine.applyFormat(plan, measure) ? 'APPLIED' : 'NO_CHANGES'
}

function snapshot(engine) {
    const out = []
    for (let r = 0; r < 34; r++) for (let c = 0; c < 11; c++) out.push(JSON.stringify(engine.getStylePatch(r, c)), engine.getRaw(r, c))
    for (let c = 0; c < 11; c++) out.push(engine.colWidth(c))
    out.push(engine.frozenRows)
    return out.join('|')
}

// f10 says the last row of sales.tsv is not a totals row, but row 33 reads
// "Total", which §3.1/§4.2 define as a totals row (f09 relies on that).
// The contract wins; DESIGN_NOTES records the disagreement.
// f03 calls J22 the blank Total, but in sales.tsv J22 is ORD-1020 ($3,344.00);
// the blank one is J23 (ORD-1021). Off by one in the fixture.
const CONTRACT_OVERRIDES = {
    f10: [{ cell: 'A33', style: { bold: true } }, { undoSteps: 1 }],
    f03: formats.cases.find(x => x.id === 'f03').expect.map(e => (e.cell === 'J22' ? { ...e, cell: 'J23' } : e)),
}

describe('golden format prompts (fixtures/ai-eval/format-prompts.json over sales.tsv)', () => {
    for (const c of formats.cases) {
        it(`${c.id}: ${c.prompt}`, async () => {
            const engine = loadFixture('sales.tsv')
            if (c.id === 'f04') engine.setFreeze(1, null) // "only if something was frozen before"
            // f06 checks A1 goes back to not bold, so it assumes earlier formatting;
            // on a fresh sheet "remove all formatting" is NO_CHANGES per §4.7.
            if (c.id === 'f06') engine.applyStyle({ r1: 0, c1: 0, r2: 0, c2: 9 }, { bold: true, bg: '#f0f0f0' })
            const { text } = await createMockProvider().complete({ user: c.prompt })
            const parsed = parseAction(text)
            expect(parsed.ok).toBe(true)
            const before = snapshot(engine)
            const depth = engine.undoDepth
            const result = apply(engine, parsed.action)
            for (const check of CONTRACT_OVERRIDES[c.id] ?? c.expect) {
                if (check.result) {
                    expect(result).toBe(check.result)
                    expect(engine.undoDepth).toBe(depth)
                    expect(snapshot(engine)).toBe(before)
                    continue
                }
                if (check.frozenRows !== undefined) expect(engine.frozenRows).toBe(check.frozenRows)
                if (check.undoSteps) {
                    expect(engine.undoDepth - depth).toBe(check.undoSteps)
                    continue
                }
                if (!check.cell) continue
                const { row, col } = parseCellName(check.cell)
                if (check.style) {
                    const s = engine.getStyle(row, col)
                    for (const [k, v] of Object.entries(check.style)) expect(s[k], `${check.cell}.${k}`).toBe(v)
                }
                if (check.display !== undefined) expect(engine.getDisplay(row, col), check.cell).toBe(check.display)
                if (check.raw !== undefined) expect(engine.getRaw(row, col)).toBe(check.raw)
            }
            if (result === 'APPLIED') {
                engine.undo()
                expect(snapshot(engine)).toBe(before)
            }
        })
    }
})

describe('format applier rules', () => {
    it('detects totals rows by label or by shape', () => {
        expect(looksLikeTotals(['Total', '', '431', '$74,431.12'])).toBe(true)
        expect(looksLikeTotals(['All regions', '', '431', '99'])).toBe(true)
        expect(looksLikeTotals(['ORD-1029', '4/5/2024', 'East', '35'])).toBe(false)
        expect(looksLikeTotals(['x', '1', '2'])).toBe(false) // every cell filled
    })
    it('on sales-large the totals row is row 2,992', () => {
        const engine = loadFixture('sales-large.tsv', 3100, 15)
        const plan = planFormat(formatView(engine), { type: 'format_sheet', totalsStyle: { bold: true } })
        expect(plan.totalsRow).toBe(2991)
        engine.applyFormat(plan, measure)
        expect(engine.getStyle(2991, 0).bold).toBe(true)
        expect(engine.getStyle(2990, 0).bold).toBe(false)
    })
    it('clears first, then body, columns, totals, header last; never writes outside the used range', () => {
        const engine = loadFixture('sales.tsv')
        engine.applyStyle({ r1: 5, c1: 0, r2: 5, c2: 0 }, { italic: true })
        apply(engine, {
            type: 'format_sheet', clearFormatting: true, bodyStyle: { align: 'center' },
            columns: [{ col: 0, style: { align: 'right', numberFormat: 'number' } }, { col: 40, style: { bold: true } }],
            headerStyle: { align: 'left', bold: true, numberFormat: 'currency' },
        })
        expect(engine.getStyle(5, 0).italic).toBe(false)
        expect(engine.getStyle(5, 0).align).toBe('right')
        expect(engine.getStyle(5, 1).align).toBe('center')
        expect(engine.getStyle(0, 0).numberFormat).toBe('general')
        expect(engine.getStylePatch(0, 10)).toBe(null)
        expect(engine.getStylePatch(5, 40)).toBe(null)
    })
})
