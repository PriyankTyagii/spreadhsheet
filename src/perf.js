// User-timing marks around UI actions. They show up in the DevTools
// performance panel, and tests read them with
// performance.getEntriesByName('<label>') / '<label> → paint'.
export function timed(label, fn) {
    const start = performance.now()
    const result = fn()
    performance.measure(label, { start, end: performance.now() })
    // Two frames later the browser has painted the result.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        performance.measure(`${label} → paint`, { start, end: performance.now() })
    }))
    return result
}
