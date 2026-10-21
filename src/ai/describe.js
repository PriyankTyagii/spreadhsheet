// Plain-words descriptions of validated actions, for result cards.

const OPS = {
    eq: 'is', neq: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤',
    contains: 'contains', startsWith: 'starts with', endsWith: 'ends with',
    isEmpty: 'is empty', notEmpty: 'is not empty',
}
const FNS = { sum: 'sum of', avg: 'average', count: 'count of', countDistinct: 'distinct count of', min: 'lowest', max: 'highest' }

const quote = (v) => (typeof v === 'number' ? String(v) : `"${v}"`)
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

export function describeQuery(plan) {
    const parts = []
    const filters = (plan.filters || []).map(f =>
        f.op === 'isEmpty' || f.op === 'notEmpty' ? `${f.column} ${OPS[f.op]}` : `${f.column} ${OPS[f.op] ?? f.op} ${quote(f.value)}`)
    parts.push(filters.length ? `Rows where ${list(filters)}` : 'All rows')
    if (plan.excludeTotalsRow === false) parts[0] += ', including the totals row'
    if (plan.groupBy?.length) parts.push(`grouped by ${list(plan.groupBy)}`)
    if (plan.aggregates?.length) {
        parts.push(`showing ${list(plan.aggregates.map(a => `${FNS[a.fn] ?? a.fn} ${a.column}${a.as ? ` (as "${a.as}")` : ''}`))}`)
    } else if (plan.columns?.length) {
        parts.push(`showing ${list(plan.columns)}`)
    }
    if (plan.sort?.length) {
        parts.push(`sorted by ${list(plan.sort.map(s => `${s.column} ${s.dir === 'desc' ? 'high to low' : 'low to high'}`))}`)
    }
    if (plan.limit) parts.push(plan.limit > 500 ? `limited to 500 (asked for ${plan.limit})` : `first ${plan.limit}`)
    return parts.join('; ') + '.'
}
