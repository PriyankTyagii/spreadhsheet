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
]

export function runAll(list = BENCHMARKS) {
    return list.map(b => {
        const { ms, samples } = b.run()
        return { id: b.id, label: b.label, budget: b.budget, ms, samples, pass: b.budget ? ms < b.budget : null }
    })
}
