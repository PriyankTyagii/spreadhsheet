// ─────────────────────────────────────────────────────────────
//  Formulas: tokenizer, recursive-descent parser, evaluator and
//  reference rewriting. Pure functions, no engine state.
//
//  Grammar
//    expr    := term (('+' | '-') term)*
//    term    := unary (('*' | '/') unary)*
//    unary   := ('-' | '+') unary | power
//    power   := primary ('^' unary)?
//    primary := number | ref | ref ':' ref | NAME '(' args ')' | '(' expr ')' | '#REF!'
//
//  References carry absolute flags: $A$1, $A1, A$1, A1.
// ─────────────────────────────────────────────────────────────
import { colToLetters, lettersToCol } from './refs.js'
import { toNum, isErrorValue } from './values.js'

export const ERR = Object.freeze({
    VALUE: '#VALUE!',
    REF: '#REF!',
    DIV0: '#DIV/0!',
    CYCLE: '#CYCLE!',
    PARSE: '#PARSE!',
    NAME: '#NAME?',
})

class FormulaError extends Error {
    constructor(code) { super(code); this.code = code }
}

// ── Tokenizer ──────────────────────────────────────────────────

const REF_RE = /^\$?[A-Za-z]{1,3}\$?\d+/
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*/
const NUM_RE = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/

/**
 * Tokens keep their [start, end) offsets into the formula body so that
 * reference rewriting can splice the original text and preserve spacing.
 */
export function tokenize(body) {
    const tokens = []
    let i = 0
    while (i < body.length) {
        const ch = body[i]
        if (ch === ' ' || ch === '\t') { i++; continue }
        const rest = body.slice(i)
        if ('+-*/^(),:'.includes(ch)) {
            tokens.push({ type: ch, start: i, end: i + 1 })
            i++
            continue
        }
        if (rest.startsWith('#REF!')) {
            tokens.push({ type: 'err', code: ERR.REF, start: i, end: i + 5 })
            i += 5
            continue
        }
        let m = NUM_RE.exec(rest)
        if (m) {
            tokens.push({ type: 'num', value: parseFloat(m[0]), start: i, end: i + m[0].length })
            i += m[0].length
            continue
        }
        m = REF_RE.exec(rest)
        if (m && !/[A-Za-z0-9_(]/.test(rest[m[0].length] || '')) {
            tokens.push({ type: 'ref', ref: parseRefText(m[0]), start: i, end: i + m[0].length })
            i += m[0].length
            continue
        }
        m = NAME_RE.exec(rest)
        if (m) {
            tokens.push({ type: 'name', value: m[0].toUpperCase(), start: i, end: i + m[0].length })
            i += m[0].length
            continue
        }
        throw new FormulaError(ERR.PARSE)
    }
    return tokens
}

function parseRefText(text) {
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(text)
    return {
        col: lettersToCol(m[2]),
        row: parseInt(m[4], 10) - 1,
        colAbs: m[1] === '$',
        rowAbs: m[3] === '$',
    }
}

export function refToText(ref) {
    return (ref.colAbs ? '$' : '') + colToLetters(ref.col) + (ref.rowAbs ? '$' : '') + (ref.row + 1)
}

// ── Parser ─────────────────────────────────────────────────────

export function parse(body) {
    const tokens = tokenize(body)
    let pos = 0
    const peek = () => tokens[pos]
    const take = (type) => {
        const t = tokens[pos]
        if (!t || (type && t.type !== type)) throw new FormulaError(ERR.PARSE)
        pos++
        return t
    }

    function expr() {
        let node = term()
        while (peek() && (peek().type === '+' || peek().type === '-')) {
            const op = take().type
            node = { t: 'bin', op, l: node, r: term() }
        }
        return node
    }
    function term() {
        let node = unary()
        while (peek() && (peek().type === '*' || peek().type === '/')) {
            const op = take().type
            node = { t: 'bin', op, l: node, r: unary() }
        }
        return node
    }
    function unary() {
        const t = peek()
        if (t && (t.type === '-' || t.type === '+')) {
            take()
            const e = unary()
            return t.type === '-' ? { t: 'neg', e } : e
        }
        return power()
    }
    function power() {
        const base = primary()
        if (peek() && peek().type === '^') {
            take()
            return { t: 'bin', op: '^', l: base, r: unary() }
        }
        return base
    }
    function primary() {
        const t = peek()
        if (!t) throw new FormulaError(ERR.PARSE)
        if (t.type === 'num') { take(); return { t: 'num', v: t.value } }
        if (t.type === 'err') { take(); return { t: 'err', code: t.code } }
        if (t.type === 'ref') {
            take()
            if (peek() && peek().type === ':') {
                take()
                const b = peek()
                if (b && b.type === 'err') { take(); return { t: 'err', code: b.code } }
                const end = take('ref')
                return { t: 'range', a: t.ref, b: end.ref }
            }
            return { t: 'ref', ref: t.ref }
        }
        if (t.type === 'name') {
            take()
            take('(')
            const args = []
            if (peek() && peek().type !== ')') {
                args.push(expr())
                while (peek() && peek().type === ',') { take(); args.push(expr()) }
            }
            take(')')
            return { t: 'fn', name: t.value, args }
        }
        if (t.type === '(') {
            take()
            const e = expr()
            take(')')
            return e
        }
        throw new FormulaError(ERR.PARSE)
    }

    const ast = expr()
    if (pos !== tokens.length) throw new FormulaError(ERR.PARSE)
    return ast
}

/**
 * Compile a raw cell value that starts with '='. Never throws: a parse
 * failure becomes an AST that evaluates to #PARSE!.
 */
export function compile(raw) {
    try {
        return parse(raw.slice(1))
    } catch (e) {
        return { t: 'err', code: e instanceof FormulaError ? e.code : ERR.PARSE }
    }
}

/** Every single reference and range an AST reads, in absolute coordinates. */
export function collectRefs(ast, out = { refs: [], ranges: [] }) {
    switch (ast.t) {
        case 'ref': out.refs.push(ast.ref); break
        case 'range': out.ranges.push(ast); break
        case 'bin': collectRefs(ast.l, out); collectRefs(ast.r, out); break
        case 'neg': collectRefs(ast.e, out); break
        case 'fn': for (const a of ast.args) collectRefs(a, out); break
    }
    return out
}

// ── Evaluator ──────────────────────────────────────────────────

/** Scalar used in arithmetic: blanks are 0, numeric text is coerced. */
function arith(v) {
    if (typeof v === 'number') return v
    if (v === '' || v === null || v === undefined) return 0
    if (isErrorValue(v)) throw new FormulaError(v)
    const n = toNum(v)
    if (n === null) throw new FormulaError(ERR.VALUE)
    return n
}

/** Numbers a function sees from its arguments; ranges skip blanks and plain text. */
function collectNumbers(args, ctx) {
    const nums = []
    for (const a of args) {
        if (a.t === 'range') {
            const r1 = Math.min(a.a.row, a.b.row), r2 = Math.max(a.a.row, a.b.row)
            const c1 = Math.min(a.a.col, a.b.col), c2 = Math.max(a.a.col, a.b.col)
            ctx.forEachInRange(r1, c1, r2, c2, (v) => {
                if (isErrorValue(v)) throw new FormulaError(v)
                const n = toNum(v)
                if (n !== null) nums.push(n)
            })
        } else {
            nums.push(arith(evalNode(a, ctx)))
        }
    }
    return nums
}

const FUNCTIONS = {
    SUM: (n) => n.reduce((s, v) => s + v, 0),
    AVG: (n) => { if (!n.length) throw new FormulaError(ERR.DIV0); return n.reduce((s, v) => s + v, 0) / n.length },
    MIN: (n) => n.length ? n.reduce((m, v) => v < m ? v : m, Infinity) : 0,
    MAX: (n) => n.length ? n.reduce((m, v) => v > m ? v : m, -Infinity) : 0,
    COUNT: (n) => n.length,
}
FUNCTIONS.AVERAGE = FUNCTIONS.AVG

function evalNode(node, ctx) {
    switch (node.t) {
        case 'num': return node.v
        case 'err': throw new FormulaError(node.code)
        case 'ref': {
            const v = ctx.get(node.ref.row, node.ref.col)
            if (isErrorValue(v)) throw new FormulaError(v)
            return v
        }
        case 'range': throw new FormulaError(ERR.VALUE)
        case 'neg': return -arith(evalNode(node.e, ctx))
        case 'bin': {
            const l = arith(evalNode(node.l, ctx))
            const r = arith(evalNode(node.r, ctx))
            switch (node.op) {
                case '+': return l + r
                case '-': return l - r
                case '*': return l * r
                case '/': if (r === 0) throw new FormulaError(ERR.DIV0); return l / r
                case '^': return Math.pow(l, r)
            }
            throw new FormulaError(ERR.VALUE)
        }
        case 'fn': {
            const fn = FUNCTIONS[node.name]
            if (!fn) throw new FormulaError(ERR.NAME)
            return fn(collectNumbers(node.args, ctx))
        }
    }
    throw new FormulaError(ERR.VALUE)
}

/**
 * Evaluate an AST. ctx = { get(row, col), forEachInRange(r1, c1, r2, c2, fn) }.
 * Returns a number, a string (a lone reference to text) or an error code.
 */
export function evaluate(ast, ctx) {
    try {
        const v = evalNode(ast, ctx)
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) return ERR.VALUE
            // Hide binary float noise (0.1 + 0.2) without losing real precision.
            return Math.abs(v) < 1e15 ? +v.toPrecision(15) : v
        }
        return v === '' ? 0 : v
    } catch (e) {
        if (e instanceof FormulaError) return e.code
        return ERR.VALUE
    }
}

// ── Reference rewriting ────────────────────────────────────────

/**
 * Split a formula into literal text and reference slots once, so it can be
 * re-rendered many times (fill renders the same seed 100,000 times).
 */
export function compileTemplate(raw) {
    let tokens
    try { tokens = tokenize(raw.slice(1)) } catch { return null }
    const parts = []
    let cursor = 0
    const body = raw.slice(1)
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]
        if (t.type !== 'ref') continue
        const isRange = tokens[i + 1]?.type === ':' && tokens[i + 2]?.type === 'ref'
        parts.push(body.slice(cursor, t.start))
        if (isRange) {
            const end = tokens[i + 2]
            parts.push({ range: { a: t.ref, b: end.ref } })
            cursor = end.end
            i += 2
        } else {
            parts.push({ ref: t.ref })
            cursor = t.end
        }
    }
    parts.push(body.slice(cursor))
    return parts
}

/**
 * Render a template. mapRef(ref) returns a new ref or null (→ #REF!);
 * mapRange({ a, b }) returns { a, b } or null. mapRange defaults to
 * mapping both corners with mapRef.
 */
export function renderTemplate(parts, mapRef, mapRange) {
    let out = '='
    for (const p of parts) {
        if (typeof p === 'string') out += p
        else if (p.ref) {
            const r = mapRef(p.ref)
            out += r ? refToText(r) : ERR.REF
        } else {
            let r
            if (mapRange) r = mapRange(p.range)
            else {
                const a = mapRef(p.range.a), b = mapRef(p.range.b)
                r = a && b ? { a, b } : null
            }
            out += r ? refToText(r.a) + ':' + refToText(r.b) : ERR.REF
        }
    }
    return out
}

/** One-shot rewrite of a formula's references. Non-formulas pass through. */
export function rewriteFormula(raw, mapRef, mapRange) {
    if (typeof raw !== 'string' || raw[0] !== '=') return raw
    const parts = compileTemplate(raw)
    return parts ? renderTemplate(parts, mapRef, mapRange) : raw
}

/** Relative shift for fill/copy: $-pinned parts stay, others move. */
export function shiftRef(ref, dr, dc) {
    const row = ref.rowAbs ? ref.row : ref.row + dr
    const col = ref.colAbs ? ref.col : ref.col + dc
    if (row < 0 || col < 0) return null
    return { ...ref, row, col }
}
