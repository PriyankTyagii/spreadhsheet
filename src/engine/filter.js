// ─────────────────────────────────────────────────────────────
//  Column filters. Pure predicates; the engine decides which rows
//  they apply to and caches the hidden set.
//
//  FilterSpec = {
//    values:    string[] | null   allowed text keys (trimmed, lower-case;
//                                 '' is "(Blanks)"); null = all values
//    condition: { op, value } | null
//               op ∈ contains | gt | lt | isEmpty | notEmpty
//  }
//
//  Matching is on trimmed, case-insensitive text, so "West", "West "
//  and "west" are one value: the data is messy, the user means one region.
// ─────────────────────────────────────────────────────────────
import { norm, toNum, toDate } from './values.js'
import { generalText } from './numberFormat.js'

export const FILTER_CONDITIONS = ['contains', 'gt', 'lt', 'isEmpty', 'notEmpty']

const valueSets = new WeakMap()
function allowed(spec) {
    let s = valueSets.get(spec)
    if (!s) valueSets.set(spec, (s = new Set(spec.values)))
    return s
}

function compare(cell, target, op) {
    const targetDate = toDate(String(target ?? ''))
    let diff
    if (targetDate) {
        const d = toDate(generalText(cell))
        if (!d) return false
        diff = d < targetDate ? -1 : d > targetDate ? 1 : 0
    } else {
        const a = toNum(cell), b = toNum(target)
        if (a === null || b === null) return false
        diff = a - b
    }
    return op === 'gt' ? diff > 0 : diff < 0
}

export function passes(spec, value) {
    const key = norm(generalText(value))
    if (spec.values && !allowed(spec).has(key)) return false
    const cond = spec.condition
    if (!cond) return true
    switch (cond.op) {
        case 'contains': return key.includes(norm(cond.value))
        case 'gt':
        case 'lt': return compare(value, cond.value, cond.op)
        case 'isEmpty': return key === ''
        case 'notEmpty': return key !== ''
    }
    return true
}

/** filters: Map<col, FilterSpec>; valueOf(col) reads the row's computed value. */
export function rowPasses(filters, valueOf) {
    for (const [col, spec] of filters) if (!passes(spec, valueOf(col))) return false
    return true
}
