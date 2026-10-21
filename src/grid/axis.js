// ─────────────────────────────────────────────────────────────
//  One axis of the grid (rows or columns): prefix sums of sizes
//  plus binary search, so "which row is at pixel y" and "where does
//  row r start" are O(log n) and O(1) for 100,000 rows. Pure.
//  Hidden rows have size 0 and simply take no space.
// ─────────────────────────────────────────────────────────────

/**
 * @param {number} count
 * @param {(i: number) => number} sizeAt
 */
export function createAxis(count, sizeAt) {
    const offsets = new Float64Array(count + 1)
    for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + sizeAt(i)
    const total = offsets[count]

    return {
        count,
        total,
        start: (i) => offsets[Math.max(0, Math.min(i, count))],
        end: (i) => offsets[Math.max(0, Math.min(i + 1, count))],
        size: (i) => offsets[i + 1] - offsets[i],
        /** Index of the item covering pixel px (the last one starting at or before it). */
        indexAt(px) {
            if (px <= 0) return 0
            if (px >= total) return count - 1
            let lo = 0, hi = count - 1
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1
                if (offsets[mid] <= px) lo = mid
                else hi = mid - 1
            }
            return lo
        },
    }
}
