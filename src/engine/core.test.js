// Starter tests for the engine. Extend this file (or add more *.test.js
// files) for every behaviour you implement. Graders run `npm test` and add
// their own hidden tests against the public engine API you document in
// DESIGN_NOTES.md.
import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'

describe('engine basics', () => {
    it('evaluates arithmetic and ranges', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '10')
        engine.setCell(1, 0, '20')
        engine.setCell(2, 0, '=SUM(A1:A2)*2')
        expect(engine.getCell(2, 0).computed).toBe(60)
    })

    it('reports a cycle instead of hanging', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '=B1')
        engine.setCell(0, 1, '=A1')
        expect(engine.getCell(0, 1).error).toBe('#CYCLE!')
    })

    it('undoes and redoes a single edit', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, 'hello')
        engine.setCell(0, 0, 'world')
        engine.undo()
        expect(engine.getCell(0, 0).raw).toBe('hello')
        engine.redo()
        expect(engine.getCell(0, 0).raw).toBe('world')
    })

    it('shifts references when a row is inserted above them', () => {
        const engine = createEngine(10, 10)
        engine.setCell(2, 0, '5')       // A3
        engine.setCell(4, 0, '=A3+1')   // A5
        engine.insertRow(1)             // A3 -> A4, A5 -> A6
        expect(engine.getCell(5, 0).raw).toBe('=A4+1')
        expect(engine.getCell(5, 0).computed).toBe(6)
    })
})

describe('defects fixed in the starter engine', () => {
    it('parses ranges (the shunting-yard parser saw ":" before the second cell)', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '1')
        engine.setCell(1, 0, '2')
        engine.setCell(2, 0, '=SUM(A1:A2)')
        expect(engine.getCell(2, 0).computed).toBe(3)
    })

    it('recomputes a range formula when a cell in the middle of the range changes', () => {
        const engine = createEngine(10, 10)
        engine.setValues(0, 0, [['1'], ['2'], ['3'], ['=SUM(A1:A3)']])
        engine.setCell(1, 0, '20')
        expect(engine.getValue(3, 0)).toBe(24)
    })

    it('does not read dates or labels as numbers (parseFloat("2024-01-15") was 2024)', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '2024-01-15')
        engine.setCell(1, 0, '12 units')
        expect(engine.getValue(0, 0)).toBe('2024-01-15')
        engine.setCell(2, 0, '=A2+1')
        expect(engine.getCell(2, 0).error).toBe('#VALUE!')
    })

    it('coerces currency and percent text in arithmetic', () => {
        const engine = createEngine(10, 10)
        engine.setValues(0, 0, [['$1,200.00', '10%', '=A1*B1']])
        expect(engine.getValue(0, 2)).toBe(120)
    })

    it('a reference to a deleted row becomes #REF! and undo brings it back', () => {
        const engine = createEngine(10, 10)
        engine.setValues(0, 0, [['5'], ['6'], ['=A2*2']])
        engine.deleteRow(1)
        expect(engine.getRaw(1, 0)).toBe('=#REF!*2')
        engine.undo()
        expect(engine.getRaw(2, 0)).toBe('=A2*2')
        expect(engine.getValue(2, 0)).toBe(12)
    })

    it('deleting a row inside a range shrinks the range', () => {
        const engine = createEngine(10, 10)
        engine.setValues(0, 0, [['1'], ['2'], ['3'], ['=SUM(A1:A3)']])
        engine.deleteRow(1)
        expect(engine.getRaw(2, 0)).toBe('=SUM(A1:A2)')
        expect(engine.getValue(2, 0)).toBe(4)
    })

    it('undo of a structural edit restores styles and sizes too', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 3, 'x')
        engine.applyStyle({ r1: 0, c1: 3, r2: 0, c2: 3 }, { bold: true })
        engine.setColWidth(3, 300)
        engine.insertColumn(3)
        expect(engine.colWidth(3)).toBe(100)
        expect(engine.colWidth(4)).toBe(300)
        expect(engine.getStyle(0, 4).bold).toBe(true)
        engine.undo()
        expect(engine.colWidth(3)).toBe(300)
        expect(engine.getStyle(0, 3).bold).toBe(true)
        engine.redo()
        expect(engine.colWidth(4)).toBe(300)
    })

    it('a long dependency chain does not overflow the stack', () => {
        const engine = createEngine(20010, 2)
        const data = [['1']]
        for (let i = 1; i < 20000; i++) data.push([`=A${i}+1`])
        engine.setValues(0, 0, data)
        expect(engine.getValue(19999, 0)).toBe(20000)
        engine.setCell(0, 0, '2')
        expect(engine.getValue(19999, 0)).toBe(20001)
    })
})

describe('transactions', () => {
    it('a bulk action is one undo step', () => {
        const engine = createEngine(10, 10)
        engine.setValues(0, 0, [['1', '2'], ['3', '4']])
        engine.clearRange({ r1: 0, c1: 0, r2: 1, c2: 1 })
        expect(engine.getRaw(1, 1)).toBe('')
        engine.undo()
        expect(engine.getRaw(1, 1)).toBe('4')
    })

    it('rolls back everything when the action throws', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, 'keep')
        expect(() => engine.transact('boom', () => {
            engine.setCell(0, 0, 'changed')
            throw new Error('boom')
        })).toThrow('boom')
        expect(engine.getRaw(0, 0)).toBe('keep')
        expect(engine.undoDepth).toBe(1)
    })

    it('no-op edits create no undo entry', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, 'a')
        engine.setCell(0, 0, 'a')
        expect(engine.undoDepth).toBe(1)
    })

    it('formats display without changing the stored value', () => {
        const engine = createEngine(10, 10)
        engine.setValues(0, 0, [['79', '10%', '0.1', 'n/a', '15 Jan 2024']])
        engine.applyStyle({ r1: 0, c1: 0, r2: 0, c2: 0 }, { numberFormat: 'currency' })
        engine.applyStyle({ r1: 0, c1: 1, r2: 0, c2: 3 }, { numberFormat: 'percent' })
        engine.applyStyle({ r1: 0, c1: 4, r2: 0, c2: 4 }, { numberFormat: 'date' })
        expect([0, 1, 2, 3, 4].map(c => engine.getDisplay(0, c))).toEqual(['$79.00', '10%', '10%', 'n/a', '2024-01-15'])
        expect(engine.getRaw(0, 0)).toBe('79')
    })
})
