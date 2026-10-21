import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { loadFixture, a1 } from './testUtils.js'

const col = (name) => name.charCodeAt(0) - 65

function withRatio() {
    const e = loadFixture('sales.tsv')
    const x = a1(e)
    x.set('K2', '=J2/G2')
    e.fill(x.range('K2'), x.range('K2:K32'))
    return { e, x }
}

describe('sort (acceptance on sales.tsv)', () => {
    it('sorting by Total descending moves rows, their formulas follow, totals stay pinned', () => {
        const { e, x } = withRatio()
        x.set('M1', '=SUM(J2:J32)')
        const sumBefore = x.value('M1')
        e.sort({ col: col('J'), dir: 'desc' })
        expect(x.raw('A2')).toBe('ORD-1025')
        expect(x.value('K2')).toBe(1080)
        expect(x.raw('K2')).toBe('=J2/G2')
        expect(x.raw('A33')).toBe('Total')
        expect(x.raw('M1')).toBe('=SUM(J2:J32)')
        expect(x.value('M1')).toBe(sumBefore)
        // the fully blank row sorts last, after ORD-1021 whose Total is blank
        expect(x.raw('A31')).toBe('ORD-1021')
        expect(x.raw('A32')).toBe('')
        expect(x.raw('B32')).toBe('')
    })

    it('references from outside the block follow the moved row', () => {
        const { e, x } = withRatio()
        x.set('M1', '=J27') // ORD-1025's Total
        e.sort({ col: col('J'), dir: 'desc' })
        expect(x.raw('M1')).toBe('=J2')
        expect(x.value('M1')).toBe('$9,720.00')
    })

    it('one undo restores the order; ascending → descending → original', () => {
        const e = loadFixture('sales.tsv')
        const x = a1(e)
        const original = Array.from({ length: 33 }, (_, i) => e.getRaw(i, 0))
        e.sort({ col: col('G'), dir: 'asc' })
        expect(x.raw('A2')).toBe('ORD-1013') // 2 units, first of the 2s in original order
        e.sort({ col: col('G'), dir: 'desc' })
        expect(x.raw('A2')).toBe('ORD-1012') // 60 units
        e.sort({ col: col('G'), dir: 'original' })
        expect(Array.from({ length: 33 }, (_, i) => e.getRaw(i, 0))).toEqual(original)
        e.undo(); e.undo(); e.undo()
        expect(Array.from({ length: 33 }, (_, i) => e.getRaw(i, 0))).toEqual(original)
    })

    it('numbers before text, blanks last, dates as dates, case-insensitive text', () => {
        const e = createEngine(20, 3)
        e.setValues(0, 0, [['h'], ['banana'], [''], ['10'], ['Apple'], ['2']])
        e.sort({ col: 0, dir: 'asc', range: { r1: 1, c1: 0, r2: 5, c2: 0 } })
        expect([1, 2, 3, 4, 5].map(r => e.getRaw(r, 0))).toEqual(['2', '10', 'Apple', 'banana', ''])
        const d = createEngine(20, 3)
        d.setValues(0, 0, [['h'], ['15 Jan 2024'], ['2024-01-03'], ['1/8/2024']])
        d.sort({ col: 0, dir: 'asc' })
        expect([1, 2, 3].map(r => d.getRaw(r, 0))).toEqual(['2024-01-03', '1/8/2024', '15 Jan 2024'])
    })

    it('styles move with their rows', () => {
        const e = createEngine(20, 3)
        e.setValues(0, 0, [['h'], ['b'], ['a']])
        e.applyStyle({ r1: 1, c1: 0, r2: 1, c2: 0 }, { bold: true })
        e.sort({ col: 0, dir: 'asc' })
        expect(e.getRaw(2, 0)).toBe('b')
        expect(e.getStyle(2, 0).bold).toBe(true)
        expect(e.getStyle(1, 0).bold).toBe(false)
    })

    it('sorting 10,000 rows stays inside the budget', () => {
        const e = createEngine(10010, 5)
        const data = [['n', 'f']]
        for (let i = 0; i < 10000; i++) data.push([String((i * 7919) % 10007), `=A${i + 2}*2`])
        e.setValues(0, 0, data)
        const t0 = performance.now()
        e.sort({ col: 0, dir: 'asc' })
        const ms = performance.now() - t0
        expect(e.getValue(1, 1)).toBe(e.getValue(1, 0) * 2)
        expect(ms).toBeLessThan(1000) // generous in CI; production numbers are in DESIGN_NOTES
    })
})

describe('filter', () => {
    it('Region = West matches West, "West " and west; sort moves only visible rows', () => {
        const e = loadFixture('sales.tsv')
        const x = a1(e)
        const region = col('C')
        const values = e.distinctValues(region)
        const west = values.find(v => v.key === 'west')
        expect(west.count).toBe(8)
        e.setFilter(region, { values: ['west'], condition: null })
        expect(e.filterStats()).toEqual({ total: 32, visible: 8 })
        const hiddenBefore = []
        for (let r = 1; r <= 32; r++) if (e.isRowHidden(r)) hiddenBefore.push([r, e.getRaw(r, 0)])
        e.sort({ col: col('G'), dir: 'asc' })
        for (const [r, id] of hiddenBefore) expect(e.getRaw(r, 0)).toBe(id)
        expect(x.raw('A3')).toBe('ORD-1027') // first visible row now holds the 2-unit West order
        expect(x.raw('A6')).toBe('ORD-1005')
        e.undo()
        e.undo()
        expect(e.filterStats().visible).toBe(32)
        expect(x.raw('A3')).toBe('ORD-1002')
        expect(x.raw('A29')).toBe('ORD-1027')
    })

    it('undo and redo of a filter refresh the hidden rows and the version', () => {
        const e = createEngine(10, 3)
        e.setValues(0, 0, [['k'], ['1'], ['2']])
        e.setFilter(0, { values: ['1'], condition: null })
        expect(e.isRowHidden(2)).toBe(true) // reads (and caches) the hidden set
        const v = e.version
        e.undo()
        expect(e.version).toBeGreaterThan(v)
        expect(e.isRowHidden(2)).toBe(false)
        e.redo()
        expect(e.isRowHidden(2)).toBe(true)
    })

    it('hidden rows still count in formulas', () => {
        const e = createEngine(10, 3)
        e.setValues(0, 0, [['k'], ['1'], ['2'], ['3']])
        e.setCell(0, 2, '=SUM(A2:A4)')
        e.setFilter(0, { values: ['1'], condition: null })
        expect(e.isRowHidden(2)).toBe(true)
        expect(e.getValue(0, 2)).toBe(6)
    })

    it('conditions: contains, greater than, less than, is empty', () => {
        const e = loadFixture('sales.tsv')
        e.setFilter(col('G'), { values: null, condition: { op: 'gt', value: '20' } })
        expect(e.filterStats().visible).toBe(8)
        e.setFilter(col('G'), { values: null, condition: { op: 'isEmpty' } })
        expect(e.filterStats().visible).toBe(1)
        e.setFilter(col('E'), { values: null, condition: { op: 'contains', value: 'DESK' } })
        expect(e.filterStats().visible).toBe(0) // AND: the only blank-Units row has no product
        e.clearFilters()
        e.setFilter(col('B'), { values: null, condition: { op: 'lt', value: '2024-01-10' } })
        expect(e.filterStats().visible).toBe(3)
    })
})
