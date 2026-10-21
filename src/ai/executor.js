// ─────────────────────────────────────────────────────────────
//  Query executor: a validated `query` plan over a table snapshot.
//  Follows AI_CONTRACT.md §3 exactly. Pure: no engine, no React,
//  no model. Every number in the result is computed here.
// ─────────────────────────────────────────────────────────────
import { FILTER_OPS, AGGREGATE_FNS, MAX_RESULT_ROWS } from './contract.js'
import { norm, toNum, toDate } from '../engine/values.js'
import { TOTALS_RE } from '../engine/sort.js'

class QueryError extends Error {
    constructor(code, detail) { super(detail || code); this.code = code; this.detail = detail || code }
}

const fail = (code, what) => { throw new QueryError(code, what === undefined ? code : `${code}:${what}`) }

const isBlankRow = (row) => row.every(v => String(v ?? '').trim() === '')

/** Data rows the plan runs over, per §3.1. */
export function dataRows(table, excludeTotalsRow = true) {
    let last = table.rows.length - 1
    while (last >= 0 && isBlankRow(table.rows[last])) last--
    let rows = table.rows.slice(0, last + 1)
    if (excludeTotalsRow && last >= 0) {
        const first = table.rows[last].find(v => String(v ?? '').trim() !== '')
        if (first !== undefined && TOTALS_RE.test(String(first).trim())) rows = rows.slice(0, -1)
    }
    return rows.filter(r => !isBlankRow(r))
}

function resolver(header) {
    const index = new Map()
    header.forEach((h, i) => { const k = norm(h); if (k && !index.has(k)) index.set(k, i) })
    return (name) => {
        const i = index.get(norm(name))
        if (i === undefined) fail('UNKNOWN_COLUMN', name)
        return i
    }
}

function matches(cell, op, value) {
    switch (op) {
        case 'eq':
        case 'neq': {
            const a = toNum(cell), b = toNum(value)
            const equal = a !== null && b !== null ? a === b : norm(cell) === norm(value)
            return op === 'eq' ? equal : !equal
        }
        case 'gt': case 'gte': case 'lt': case 'lte': {
            const target = toDate(String(value ?? ''))
            let diff
            if (target) {
                const d = toDate(String(cell ?? ''))
                if (!d) return false
                diff = d < target ? -1 : d > target ? 1 : 0
            } else {
                const a = toNum(cell), b = toNum(value)
                if (a === null || b === null) return false
                diff = a - b
            }
            return op === 'gt' ? diff > 0 : op === 'gte' ? diff >= 0 : op === 'lt' ? diff < 0 : diff <= 0
        }
        case 'contains': return norm(cell).includes(norm(value))
        case 'startsWith': return norm(cell).startsWith(norm(value))
        case 'endsWith': return norm(cell).endsWith(norm(value))
        case 'isEmpty': return norm(cell) === ''
        case 'notEmpty': return norm(cell) !== ''
    }
    return fail('UNKNOWN_OP', op)
}

function aggregate(fn, values) {
    switch (fn) {
        case 'count': return values.filter(v => String(v ?? '').trim() !== '').length
        case 'countDistinct': {
            const set = new Set()
            for (const v of values) { const k = norm(v); if (k !== '') set.add(k) }
            return set.size
        }
    }
    const nums = []
    for (const v of values) { const n = toNum(v); if (n !== null) nums.push(n) }
    if (!nums.length) return null
    switch (fn) {
        case 'sum': return nums.reduce((s, n) => s + n, 0)
        case 'avg': return nums.reduce((s, n) => s + n, 0) / nums.length
        case 'min': return nums.reduce((m, n) => (n < m ? n : m), Infinity)
        case 'max': return nums.reduce((m, n) => (n > m ? n : m), -Infinity)
    }
    return fail('UNKNOWN_FN', fn)
}

function compareValues(a, b) {
    const x = toNum(a), y = toNum(b)
    if (x !== null && y !== null) return x - y
    if (x !== null) return -1
    if (y !== null) return 1
    const s = norm(a), t = norm(b)
    return s < t ? -1 : s > t ? 1 : 0
}

const round2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)

/**
 * @param {object} plan   a validated query plan
 * @param {{ header: string[], rows: string[][] }} table
 * @returns {{ columns: string[], rows: any[][], rowCount: number, truncated: boolean }
 *          | { error: string, detail: string }}
 */
export function executeQuery(plan, table) {
    try {
        return run(plan, table)
    } catch (e) {
        if (e instanceof QueryError) return { error: e.code, detail: e.detail }
        throw e
    }
}

function run(plan, table) {
    if (!plan || plan.type !== 'query') fail('READ_ONLY')
    const col = resolver(table.header)
    const filters = (plan.filters || []).map(f => {
        if (!FILTER_OPS.includes(f.op)) fail('UNKNOWN_OP', f.op)
        return { index: col(f.column), op: f.op, value: f.value }
    })
    const groupBy = (plan.groupBy || []).map(name => ({ index: col(name), name: table.header[col(name)].trim() }))
    const aggregates = (plan.aggregates || []).map(a => {
        if (!AGGREGATE_FNS.includes(a.fn)) fail('UNKNOWN_FN', a.fn)
        const index = col(a.column)
        return { fn: a.fn, index, name: a.as ?? `${a.fn}(${table.header[index].trim()})` }
    })
    const projection = (plan.columns && plan.columns.length ? plan.columns : table.header.filter(h => String(h).trim() !== ''))
        .map(name => ({ index: col(name), name: table.header[col(name)].trim() }))

    let rows = dataRows(table, plan.excludeTotalsRow !== false)
    if (filters.length) rows = rows.filter(r => filters.every(f => matches(r[f.index], f.op, f.value)))

    let columns, out, sortSource
    if (aggregates.length || groupBy.length) {
        const groups = new Map()
        for (const r of rows) {
            const key = groupBy.map(g => norm(r[g.index])).join('\u0000')
            let g = groups.get(key)
            if (!g) groups.set(key, (g = { labels: groupBy.map(c => String(r[c.index] ?? '').trim()), rows: [] }))
            g.rows.push(r)
        }
        // No group-by: one group over every filtered row, even when that is none.
        if (!groupBy.length && !groups.size) groups.set('', { labels: [], rows: [] })
        columns = [...groupBy.map(g => g.name), ...aggregates.map(a => a.name)]
        out = [...groups.values()].map(g => [
            ...g.labels,
            ...aggregates.map(a => aggregate(a.fn, g.rows.map(r => r[a.index]))),
        ])
        sortSource = (name) => {
            const i = columns.findIndex(c => norm(c) === norm(name))
            if (i < 0) fail('UNKNOWN_SORT_COLUMN', name)
            return (row) => row[i]
        }
    } else {
        columns = projection.map(p => p.name)
        const byRow = new Map()
        out = rows.map(r => { const o = projection.map(p => r[p.index] ?? ''); byRow.set(o, r); return o })
        // Row results may sort on any source column, projected or not.
        sortSource = (name) => {
            const i = table.header.findIndex(h => norm(h) === norm(name))
            if (i < 0) fail('UNKNOWN_SORT_COLUMN', name)
            return (row) => byRow.get(row)[i]
        }
    }

    const sorts = (plan.sort || []).map(s => ({ get: sortSource(s.column), sign: s.dir === 'desc' ? -1 : 1 }))
    if (sorts.length) {
        const indexed = out.map((row, i) => ({ row, i }))
        indexed.sort((a, b) => {
            for (const s of sorts) {
                const d = compareValues(s.get(a.row), s.get(b.row))
                if (d !== 0) return s.sign * d
            }
            return a.i - b.i
        })
        out = indexed.map(x => x.row)
    }

    const limit = Math.min(plan.limit ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS)
    const truncated = out.length > limit
    out = out.slice(0, limit).map(row => row.map(round2))
    return { columns, rows: out, rowCount: out.length, truncated }
}
