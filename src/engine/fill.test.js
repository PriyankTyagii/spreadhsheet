import { describe, it, expect } from 'vitest'
import { buildSeries } from './fill.js'
import { createEngine } from './core.js'
import { loadFixture, a1 } from './testUtils.js'

const forward = (seeds, count) => {
    const s = buildSeries(seeds)
    return Array.from({ length: count }, (_, i) => s(seeds.length + i).raw)
}

describe('fill series', () => {
    it('copies a single seed, extends numeric pairs', () => {
        expect(forward(['7'], 3)).toEqual(['7', '7', '7'])
        expect(forward(['1', '2'], 3)).toEqual(['3', '4', '5'])
        expect(forward(['10', '7.5'], 2)).toEqual(['5', '2.5'])
    })

    it('increments text ending in a number and keeps zero padding', () => {
        expect(forward(['Item 1'], 2)).toEqual(['Item 2', 'Item 3'])
        expect(forward(['Q4'], 1)).toEqual(['Q5'])
        expect(forward(['2024-W01'], 2)).toEqual(['2024-W02', '2024-W03'])
        expect(forward(['A-099'], 2)).toEqual(['A-100', 'A-101'])
        expect(forward(['ORD-1001', 'ORD-1002'], 3)).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
    })

    it('steps dates by the seed delta in each seed format', () => {
        expect(forward(['2024-01-15'], 2)).toEqual(['2024-01-16', '2024-01-17'])
        expect(forward(['1/15/2024', '1/22/2024'], 2)).toEqual(['1/29/2024', '2/5/2024'])
        expect(forward(['30 Jan 2024'], 2)).toEqual(['31 Jan 2024', '1 Feb 2024'])
    })

    it('cycles weekday and month names preserving case', () => {
        expect(forward(['Mon'], 3)).toEqual(['Tue', 'Wed', 'Thu'])
        expect(forward(['SUNDAY'], 1)).toEqual(['MONDAY'])
        expect(forward(['nov'], 3)).toEqual(['dec', 'jan', 'feb'])
        expect(forward(['Jan', 'Mar'], 2)).toEqual(['May', 'Jul'])
    })

    it('counts backwards when filling up', () => {
        const s = buildSeries(['Item 3', 'Item 4'])
        expect(s(-1).raw).toBe('Item 2')
        expect(s(-2).raw).toBe('Item 1')
    })

    it('marks formulas for shifting instead of copying text', () => {
        const s = buildSeries(['=A1'])
        expect(s(3)).toEqual({ seedIndex: 0, offset: 3, raw: null })
    })
})

describe('engine fill (acceptance on sales.tsv)', () => {
    it('A2:A3 dragged to A6 continues the order IDs; one undo restores', () => {
        const e = loadFixture('sales.tsv')
        const x = a1(e)
        const before = ['A4', 'A5', 'A6'].map(x.raw)
        e.fill(x.range('A2:A3'), x.range('A2:A6'))
        expect(['A4', 'A5', 'A6'].map(x.raw)).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
        e.undo()
        expect(['A4', 'A5', 'A6'].map(x.raw)).toEqual(before)
    })

    it('shifts relative references and pins absolute ones; insert row keeps them right', () => {
        const e = loadFixture('sales.tsv')
        const x = a1(e)
        x.set('K2', '=G2*H2')
        x.set('L2', '=$G$2*H2')
        e.fill(x.range('K2:L2'), x.range('K2:L32'))
        expect(x.raw('K32')).toBe('=G32*H32')
        expect(x.raw('L32')).toBe('=$G$2*H32')
        expect(x.value('K2')).toBe(4800)
        expect(x.value('L32')).toBe(4 * 49.99)
        e.insertRow(9) // above row 10
        expect(x.raw('L33')).toBe('=$G$2*H33')
        expect(x.value('L33')).toBe(4 * 49.99)
    })

    it('B2:B4 (three date formats) filled to B8 keeps each seed format', () => {
        const e = loadFixture('sales.tsv')
        const x = a1(e)
        expect(['B2', 'B3', 'B4'].map(x.raw)).toEqual(['2024-01-03', '2024-01-05', '1/8/2024'])
        e.fill(x.range('B2:B4'), x.range('B2:B8'))
        // average step of the seeds is 2.5 days, rounded to 3
        expect(['B5', 'B6', 'B7', 'B8'].map(x.raw)).toEqual(['2024-01-11', '2024-01-14', '1/17/2024', '2024-01-20'])
    })

    it('filled cells inherit the seed style', () => {
        const e = createEngine(20, 5)
        const x = a1(e)
        x.set('A1', 'Mon')
        e.applyStyle(x.range('A1'), { bold: true, numberFormat: 'number' })
        e.fill(x.range('A1'), x.range('A1:A4'))
        expect(x.raw('A4')).toBe('Thu')
        expect(x.style('A4').bold).toBe(true)
    })

    it('fills left and up', () => {
        const e = createEngine(20, 10)
        const x = a1(e)
        x.set('E5', '5')
        x.set('E6', '6')
        e.fill(x.range('E5:E6'), x.range('E2:E6'))
        expect(['E2', 'E3', 'E4'].map(x.value)).toEqual([2, 3, 4])
        x.set('D1', '=E1*2')
        e.fill(x.range('D1'), x.range('B1:D1'))
        expect(x.raw('B1')).toBe('=C1*2')
    })

    it('dragging back inside the selection clears the excluded cells in one step', () => {
        const e = createEngine(20, 5)
        const x = a1(e)
        e.setValues(0, 0, [['1'], ['2'], ['3']])
        e.fill(x.range('A1:A3'), x.range('A1:A1'))
        expect([x.raw('A1'), x.raw('A2'), x.raw('A3')]).toEqual(['1', '', ''])
        e.undo()
        expect(x.raw('A3')).toBe('3')
    })

    it('a formula that would point above row 1 becomes #REF!', () => {
        const e = createEngine(20, 5)
        const x = a1(e)
        x.set('A2', '=A1')
        e.fill(x.range('A2'), x.range('A1:A2'))
        expect(x.raw('A1')).toBe('=#REF!')
        expect(e.getCell(0, 0).error).toBe('#REF!')
    })
})
