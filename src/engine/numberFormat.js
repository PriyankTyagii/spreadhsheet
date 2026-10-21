// ─────────────────────────────────────────────────────────────
//  Display formatting. The stored value never changes; this only
//  decides what text the grid shows. Table: AI_CONTRACT.md §4.
// ─────────────────────────────────────────────────────────────
import { toNum, toDate, isErrorValue } from './values.js'

export const NUMBER_FORMATS = ['general', 'number', 'currency', 'percent', 'date']

function grouped(n, decimals) {
    const fixed = Math.abs(n).toFixed(decimals)
    const [int, frac] = fixed.split('.')
    const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return (n < 0 ? '-' : '') + withCommas + (frac ? '.' + frac : '')
}

/** How a value prints with no format: numbers without float noise. */
export function generalText(value) {
    if (value === null || value === undefined) return ''
    if (typeof value === 'number') return String(+value.toPrecision(12))
    return String(value)
}

/**
 * @param {number|string} value  the computed value (text for literals)
 * @param {string} [format]      one of NUMBER_FORMATS
 * @returns {string}
 */
export function formatValue(value, format) {
    const text = generalText(value)
    if (!format || format === 'general' || text === '' || isErrorValue(value)) return text
    if (format === 'date') {
        if (typeof value === 'number') return text
        return toDate(text) ?? text
    }
    // Dates are not numbers here, even though "2024-01-15" has digits.
    const n = toNum(value)
    if (n === null) return text
    switch (format) {
        case 'number': return grouped(n, 2)
        case 'currency': return (n < 0 ? '-$' : '$') + grouped(Math.abs(n), 2)
        case 'percent': return String(+(n * 100).toFixed(2)) + '%'
    }
    return text
}
