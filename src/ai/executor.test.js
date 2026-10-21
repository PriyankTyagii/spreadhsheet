import { describe, it, expect } from 'vitest'
import queries from '../../fixtures/ai-eval/queries.json'
import { loadFixture } from '../engine/testUtils.js'
import { readTable } from './table.js'
import { executeQuery } from './executor.js'
import { parseAction } from './actions.js'
import { createMockProvider } from './mockProvider.js'

const table = readTable(loadFixture('sales-large.tsv', 3100, 15))

function close(actual, expected) {
    if (typeof expected === 'number') return typeof actual === 'number' && Math.abs(actual - expected) <= 0.01
    return actual === expected
}
const rowsEqual = (a, b) => a.length === b.length && a.every((v, i) => close(v, b[i]))

function expectRows(actual, expected, ordered) {
    if (ordered) {
        expected.forEach((row, i) => expect(rowsEqual(actual[i], row), `row ${i}: ${JSON.stringify(actual[i])} vs ${JSON.stringify(row)}`).toBe(true))
        return
    }
    for (const row of expected) {
        expect(actual.some(a => rowsEqual(a, row)), `missing ${JSON.stringify(row)}`).toBe(true)
    }
}

function check(result, expectObj, plan) {
    if (expectObj.error) {
        expect(result.error).toBe(expectObj.error)
        if (expectObj.detail) expect(result.detail).toBe(expectObj.detail)
        return
    }
    expect(result.error).toBeUndefined()
    expect(result.columns).toEqual(expectObj.columns)
    expect(result.rowCount).toBe(expectObj.rowCount)
    expect(result.truncated).toBe(expectObj.truncated)
    if (expectObj.rows) {
        expect(result.rows.length).toBe(expectObj.rows.length)
        expectRows(result.rows, expectObj.rows, !!(plan.sort && plan.sort.length))
    }
    if (expectObj.rowsPreview) expectRows(result.rows.slice(0, expectObj.rowsPreview.length), expectObj.rowsPreview, true)
}

describe('golden queries (fixtures/ai-eval/queries.json over sales-large.tsv)', () => {
    for (const c of queries.cases) {
        it(`${c.id}: ${c.prompt}`, () => {
            const parsed = parseAction(JSON.stringify(c.plan))
            const result = parsed.ok ? executeQuery(parsed.action, table) : { error: parsed.error, detail: parsed.detail }
            check(result, c.expect, c.plan)
        })
    }
})

describe('mock provider end to end (prose and code fences are parsed)', () => {
    const provider = createMockProvider()
    for (const c of queries.cases) {
        it(`${c.id} via mock`, async () => {
            const { text } = await provider.complete({ system: '', user: c.prompt })
            const parsed = parseAction(text)
            const result = parsed.ok ? executeQuery(parsed.action, table) : { error: parsed.error, detail: parsed.detail }
            check(result, c.expect, c.plan)
        })
    }
})

describe('executor rules', () => {
    const t = {
        header: ['Name', 'Amount', 'When'],
        rows: [
            [' west ', '$1,000.00', '2024-01-05'],
            ['West', '10%', '1/8/2024'],
            ['', '', ''],
            ['East', 'n/a', '15 Jan 2024'],
            ['Total', '$1,000.10', ''],
        ],
    }
    it('skips blank rows, excludes the totals row unless asked, trims group labels', () => {
        const r = executeQuery({ type: 'query', groupBy: ['name'], aggregates: [{ fn: 'sum', column: 'Amount' }] }, t)
        expect(r.columns).toEqual(['Name', 'sum(Amount)'])
        expect(r.rows).toEqual([['west', 1000.1], ['East', null]])
        const all = executeQuery({ type: 'query', excludeTotalsRow: false, aggregates: [{ fn: 'count', column: 'Name', as: 'n' }] }, t)
        expect(all.rows).toEqual([[4]])
    })
    it('compares dates when the filter value is a date', () => {
        const r = executeQuery({ type: 'query', filters: [{ column: 'When', op: 'gte', value: '2024-01-08' }], aggregates: [{ fn: 'count', column: 'Name', as: 'n' }] }, t)
        expect(r.rows).toEqual([[2]])
    })
    it('caps the limit at 500 in code', () => {
        const big = { header: ['x'], rows: Array.from({ length: 900 }, (_, i) => [String(i)]) }
        const r = executeQuery({ type: 'query', limit: 100000 }, big)
        expect(r.rowCount).toBe(500)
        expect(r.truncated).toBe(true)
    })
    it('reports unknown columns by name and never guesses', () => {
        expect(executeQuery({ type: 'query', groupBy: ['Territory'] }, t)).toEqual({ error: 'UNKNOWN_COLUMN', detail: 'UNKNOWN_COLUMN:Territory' })
        expect(executeQuery({ type: 'query', aggregates: [{ fn: 'sum', column: 'Amount' }], sort: [{ column: 'Nope' }] }, t).error).toBe('UNKNOWN_SORT_COLUMN')
    })
    it('refuses anything that is not a query', () => {
        expect(executeQuery({ type: 'format_sheet' }, t).error).toBe('READ_ONLY')
    })
})
