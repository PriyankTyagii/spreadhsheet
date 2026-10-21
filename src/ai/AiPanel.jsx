// ─────────────────────────────────────────────────────────────
//  Ctrl+K side panel. Prompt → provider → validated action →
//  deterministic execution → a result card. The model's text is
//  never shown as an answer; every number on a card comes from
//  executeQuery over the sheet's computed values.
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react'
import { ask } from './assistant.js'
import { readTable } from './table.js'
import { executeQuery } from './executor.js'
import { describeQuery } from './describe.js'
import { createProvider } from './provider.js'
import { cellName, parseCellName, rangeName } from '../engine/refs.js'

const HISTORY_TURNS = 6

const ERROR_TITLES = {
    PROVIDER_ERROR: { network: 'Network error', auth: 'Authentication error', rate_limit: 'Rate limited', http: 'Provider error' },
    INVALID_RESPONSE: 'The reply was not a valid action, so nothing was run',
    READ_ONLY: 'This assistant is read-only and will not change data',
    UNKNOWN_OP: 'Unknown filter operator',
    UNKNOWN_FN: 'Unknown aggregate function',
    UNKNOWN_SORT_COLUMN: 'The plan sorts by a column that is not in the result',
}

function runQuery(engine, action) {
    const table = readTable(engine)
    const t0 = performance.now()
    const result = executeQuery(action, table)
    return { result, ms: performance.now() - t0, columns: table.header.filter(h => String(h).trim()) }
}

/** Turn a validated action into a card. Pure apart from reading the sheet. */
function cardFor(engine, action) {
    if (action.type === 'clarify') return { type: 'clarify', action, question: action.question }
    if (action.type === 'query') {
        const { result, ms, columns } = runQuery(engine, action)
        if (result.error === 'UNKNOWN_COLUMN') {
            return { type: 'unknown-column', action, missing: result.detail.split(':').slice(1).join(':'), columns }
        }
        if (result.error) return { type: 'error', action, error: result.error, detail: result.detail }
        return { type: 'query', action, result, ms }
    }
    return { type: 'unsupported', action }
}

function ResultTable({ result }) {
    return (
        <div className="ai-table-wrap">
            <table className="ai-table">
                <thead><tr>{result.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                <tbody>
                    {result.rows.map((row, i) => (
                        <tr key={i}>
                            {row.map((v, j) => (
                                <td key={j} className={typeof v === 'number' ? 'num' : ''}>
                                    {v === null ? '' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function QueryCard({ card, engine, activeCell, onRerun, onInsert }) {
    const [target, setTarget] = useState(cellName(activeCell.r, activeCell.c))
    const [note, setNote] = useState(null)
    const { result } = card
    const insert = () => {
        const at = parseCellName(target)
        if (!at) { setNote({ error: true, text: `"${target}" is not a cell name` }); return }
        const where = onInsert(at, result)
        setNote({ error: false, text: `Inserted at ${where}. Ctrl+Z undoes it in one step.` })
    }
    return (
        <>
            <p className="ai-desc">{describeQuery(card.action)}</p>
            <p className="ai-meta">
                {result.rowCount} {result.rowCount === 1 ? 'row' : 'rows'}
                {result.truncated ? ' (truncated: more rows matched than the limit)' : ''}
                {' · '}computed in {card.ms.toFixed(1)} ms
            </p>
            <ResultTable result={result} />
            <div className="ai-actions">
                <button className="toolbar-btn" onClick={onRerun} title="Run the same plan again on the current sheet, without asking the model">Re-run</button>
                <span className="ai-insert">
                    <input className="ai-cell-input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Insert at cell" />
                    <button className="toolbar-btn" onClick={insert} disabled={!engine}>Insert into sheet</button>
                </span>
            </div>
            {note && <p className={note.error ? 'ai-error-text' : 'ai-ok-text'}>{note.text}</p>}
        </>
    )
}

function Card({ item, engine, activeCell, onRerun, onInsert, onUseColumn }) {
    const [showPlan, setShowPlan] = useState(false)
    const card = item.card
    let body
    if (!card) body = <p className="ai-pending">Thinking…</p>
    else if (card.type === 'query') {
        body = <QueryCard card={card} engine={engine} activeCell={activeCell} onRerun={onRerun} onInsert={onInsert} />
    } else if (card.type === 'clarify') {
        body = <p className="ai-question">{card.question}</p>
    } else if (card.type === 'unknown-column') {
        body = (
            <>
                <p className="ai-question">There is no column called “{card.missing}”. Which column did you mean?</p>
                <div className="ai-chips">
                    {card.columns.map(c => <button key={c} className="ai-chip" onClick={() => onUseColumn(item.prompt, card.missing, c)}>{c}</button>)}
                </div>
            </>
        )
    } else if (card.type === 'unsupported') {
        body = <p className="ai-desc">The model proposed a <code>{card.action.type}</code> action, which this panel does not run.</p>
    } else {
        const title = typeof ERROR_TITLES[card.error] === 'object'
            ? ERROR_TITLES[card.error][card.kind] ?? 'Provider error'
            : ERROR_TITLES[card.error] ?? card.error
        body = (
            <div className="ai-error">
                <strong>{title}</strong>
                <span className="ai-code">{card.error}{card.kind ? ` · ${card.kind}` : ''}</span>
                {card.detail && <p>{card.detail}</p>}
            </div>
        )
    }
    const plan = card && (card.action ?? null)
    return (
        <div className="ai-card">
            <div className="ai-prompt">{item.prompt}</div>
            {body}
            {card && (plan || card.raw) && (
                <div className="ai-plan">
                    <button className="link-btn" onClick={() => setShowPlan(s => !s)}>{showPlan ? 'Hide plan' : 'Show plan'}</button>
                    {showPlan && <pre>{plan ? JSON.stringify(plan, null, 2) : card.raw}</pre>}
                </div>
            )}
        </div>
    )
}

export default function AiPanel({ engine, selectionRect, activeCell, onClose }) {
    const [providerKind, setProviderKind] = useState(() => createProvider().name)
    const [provider, setProvider] = useState(() => createProvider())
    const [items, setItems] = useState([])
    const [input, setInput] = useState('')
    const [busy, setBusy] = useState(false)
    const historyRef = useRef([])
    const inputRef = useRef(null)
    const listRef = useRef(null)

    useEffect(() => { inputRef.current?.focus() }, [])
    useEffect(() => {
        const el = listRef.current
        if (el) el.scrollTop = el.scrollHeight
    }, [items])

    const update = (id, card) => setItems(list => list.map(it => (it.id === id ? { ...it, card } : it)))

    async function submit(text) {
        const prompt = text.trim()
        if (!prompt || busy) return
        const id = Date.now() + Math.random()
        setItems(list => [...list, { id, prompt, card: null }])
        setInput('')
        setBusy(true)
        const res = await ask({
            provider,
            prompt,
            table: readTable(engine),
            selection: selectionRect,
            history: historyRef.current.slice(-HISTORY_TURNS),
        })
        if (res.raw !== undefined) {
            historyRef.current.push({ role: 'user', content: prompt }, { role: 'assistant', content: res.raw })
        }
        if (!res.ok) update(id, { type: 'error', error: res.error, kind: res.kind, detail: res.detail, raw: res.raw, action: res.action })
        else update(id, cardFor(engine, res.action))
        setBusy(false)
        inputRef.current?.focus()
    }

    function rerun(item) {
        update(item.id, cardFor(engine, item.card.action))
    }

    function insert(at, result) {
        const matrix = [result.columns, ...result.rows.map(row => row.map(v => (v === null ? '' : String(v))))]
        engine.setValues(at.row, at.col, matrix, 'Insert query result')
        return rangeName({ r1: at.row, c1: at.col, r2: at.row + matrix.length - 1, c2: at.col + result.columns.length - 1 })
    }

    function switchProvider(kind) {
        setProviderKind(kind)
        setProvider(createProvider(kind))
        historyRef.current = []
    }

    return (
        <aside className="ai-panel" aria-label="Ask AI">
            <div className="ai-header">
                <strong>Ask your data</strong>
                <select className="toolbar-select" value={providerKind} onChange={(e) => switchProvider(e.target.value)} title="Provider">
                    <option value="mock">mock (offline)</option>
                    <option value="http">http (live model)</option>
                </select>
                <span className="spacer" />
                <button className="toolbar-btn" onClick={onClose} title="Close (Ctrl+K)">Close</button>
            </div>
            <div className="ai-list" ref={listRef}>
                {!items.length && (
                    <p className="ai-empty">
                        Ask a question about the sheet, e.g. “What is the total sales by region?”. The model only writes a plan;
                        the numbers are computed here.
                    </p>
                )}
                {items.map(item => (
                    <Card
                        key={item.id}
                        item={item}
                        engine={engine}
                        activeCell={activeCell}
                        onRerun={() => rerun(item)}
                        onInsert={insert}
                        onUseColumn={(prompt, missing, column) => {
                            setInput(prompt.replace(new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), column))
                            inputRef.current?.focus()
                        }}
                    />
                ))}
            </div>
            <form className="ai-input" onSubmit={(e) => { e.preventDefault(); submit(input) }}>
                <textarea
                    ref={inputRef}
                    value={input}
                    rows={2}
                    placeholder="Ask about the data… (Enter to send, Shift+Enter for a new line)"
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input) }
                        if (e.key === 'Escape') onClose()
                    }}
                />
                <button className="toolbar-btn primary" type="submit" disabled={busy || !input.trim()}>{busy ? '…' : 'Ask'}</button>
            </form>
        </aside>
    )
}
