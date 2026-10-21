// React commit counter for the walkthrough recording: open /?profile on a
// `npm run build:profile` bundle. The numbers are written straight into a
// DOM node, not React state, so counting commits causes no extra commits.
const stats = { commits: 0, lastMs: 0, maxMs: 0 }

function show() {
    window.__reactStats = { ...stats }
    const el = document.getElementById('react-stats')
    if (el) {
        el.textContent = `React commits: ${stats.commits} · last ${stats.lastMs.toFixed(1)} ms · max ${stats.maxMs.toFixed(1)} ms`
    }
}

export function onRender(id, phase, actualDuration) {
    stats.commits++
    stats.lastMs = actualDuration
    stats.maxMs = Math.max(stats.maxMs, actualDuration)
    show()
}

export function resetStats() {
    stats.commits = 0
    stats.lastMs = 0
    stats.maxMs = 0
    show()
}
