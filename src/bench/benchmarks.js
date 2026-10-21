// ─────────────────────────────────────────────────────────────
//  Engine benchmarks, run in the browser against the production
//  bundle: `npm run build && npm run preview`, then open /?bench.
//  Each case reports the median of several runs.
// ─────────────────────────────────────────────────────────────
import { createEngine } from '../engine/core.js'
import { parseTsv } from '../fixtures/loadSample.js'
import salesLarge from '../../fixtures/sales-large.tsv?raw'

function median(xs) {
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
}

function time(runs, setup, fn) {
    const samples = []
    for (let i = 0; i < runs; i++) {
        const ctx = setup()
        const t0 = performance.now()
        fn(ctx)
        samples.push(performance.now() - t0)
    }
    return { ms: median(samples), samples }
}

export function loadLarge(rows = 100000, cols = 200) {
    const engine = createEngine(rows, cols)
    engine.setValues(0, 0, parseTsv(salesLarge))
    return engine
}

/** 10,000 data rows built from the large fixture, plus a K = J/G formula column. */
function tenThousandRows() {
    const src = parseTsv(salesLarge)
    const header = src[0]
    const body = src.slice(1, -1)
    const data = [[...header, 'Per unit']]
    for (let i = 0; data.length <= 10000; i++) {
        const row = body[i % body.length]
        data.push([...row, `=J${data.length + 1}/G${data.length + 1}`])
    }
    const e = createEngine(10100, 20)
    e.setValues(0, 0, data)
    return e
}

export const BENCHMARKS = [
    {
        id: 'fill-5000',
        label: 'Fill 5,000 cells (5 seed columns × 1,000 rows: id, number pair, date, weekday, formula)',
        budget: 200,
        run: () => time(7, () => {
            const e = createEngine(2000, 10)
            e.setValues(0, 0, [['ORD-0001', '1', '2024-01-15', 'Mon', '=B1*2'], ['ORD-0002', '2', '2024-01-16', 'Tue', '=B2*2']])
            return e
        }, (e) => e.fill({ r1: 0, c1: 0, r2: 1, c2: 4 }, { r1: 0, c1: 0, r2: 1001, c2: 4 })),
    },
    {
        id: 'sort-10k',
        label: 'Sort 10,000 rows by Total descending (11 columns incl. 10,000 formulas that follow their rows)',
        budget: 300,
        run: () => time(5, tenThousandRows, (e) => e.sort({ col: 9, dir: 'desc' })),
    },
    {
        id: 'sort-large-date',
        label: 'sales-large.tsv: sort by Date ascending (2,990 rows, three date formats)',
        budget: 300,
        run: () => time(5, () => loadLarge(5000, 30), (e) => e.sort({ col: 1, dir: 'asc' })),
    },
]

/** sales-large plus K = J*2 down to row 100,000. */
function largeWithFormulas() {
    const e = loadLarge()
    e.setCell(1, 10, '=J2*2')
    e.fill({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 99999, c2: 10 })
    return e
}

BENCHMARKS.push(
    {
        id: 'fill-100k',
        label: 'Ctrl+D K2:K100000 with =J2*2 on sales-large (99,999 formulas parsed, indexed and evaluated)',
        budget: null,
        run: () => time(3, () => {
            const e = loadLarge()
            e.setCell(1, 10, '=J2*2')
            return e
        }, (e) => e.fill({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 99999, c2: 10 })),
    },
    {
        id: 'edit-far',
        label: 'Commit an edit to J95000 with 100k formulas + 30k values on the sheet (recalc of dependents only)',
        budget: 16,
        run: () => {
            const e = largeWithFormulas()
            let n = 0
            return time(9, () => e, (eng) => eng.setCell(94999, 9, String(100 + n++)))
        },
    },
)

export function runAll(list = BENCHMARKS) {
    return list.map(b => {
        const { ms, samples } = b.run()
        return { id: b.id, label: b.label, budget: b.budget, ms, samples, pass: b.budget ? ms < b.budget : null }
    })
}
