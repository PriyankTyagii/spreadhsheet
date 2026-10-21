import { useState } from 'react'
import { runAll } from './benchmarks.js'

/** /?bench — runs the engine benchmarks in this (production) bundle. */
export default function BenchPage() {
    const [results, setResults] = useState(null)
    const run = () => {
        setResults('running')
        // Let the "running" state paint before the main thread is busy.
        setTimeout(() => {
            const r = runAll()
            window.__benchResults = r
            setResults(r)
        }, 50)
    }
    return (
        <div className="bench">
            <h2>Engine benchmarks</h2>
            <p>Median of several runs in this browser. Use a production build (<code>npm run build &amp;&amp; npm run preview</code>).</p>
            <button className="toolbar-btn primary" onClick={run} id="run-bench">Run</button>
            {results === 'running' && <p>Running…</p>}
            {Array.isArray(results) && (
                <table className="bench-table">
                    <thead><tr><th>Case</th><th>Median ms</th><th>Budget ms</th><th></th></tr></thead>
                    <tbody>
                        {results.map(r => (
                            <tr key={r.id}>
                                <td>{r.label}</td>
                                <td>{r.ms.toFixed(1)}</td>
                                <td>{r.budget ?? ''}</td>
                                <td>{r.pass === null ? '' : r.pass ? 'pass' : 'over'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    )
}
