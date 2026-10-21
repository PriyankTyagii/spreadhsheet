import { describe, it, expect } from 'vitest'
import { loadFixture } from '../engine/testUtils.js'
import { readTable } from './table.js'
import { buildContext } from './context.js'
import { buildSystemPrompt } from './prompt.js'
import { createHttpProvider } from './provider.js'
import { ask } from './assistant.js'
import { describeQuery } from './describe.js'

const table = readTable(loadFixture('sales.tsv'))

describe('context sent to the model', () => {
    it('has headers, inferred types, five sample rows, row count and selection, never the data', () => {
        const ctx = buildContext(table, { r1: 1, c1: 2, r2: 9, c2: 2 })
        expect(ctx.columns.map(c => `${c.name}:${c.type}`)).toEqual([
            'Order ID:id', 'Date:date', 'Region:text', 'Sales Rep:text', 'Product:text',
            'Category:text', 'Units:number', 'Unit Price:currency', 'Discount:percent', 'Total:currency',
        ])
        expect(ctx.sampleRows).toHaveLength(5)
        expect(ctx.rowCount).toBe(32)
        expect(ctx.range).toBe('A1:J33')
        expect(ctx.selection).toBe('C2:C10')
        expect(ctx.hasTotalsRow).toBe(true)
        expect(buildSystemPrompt(ctx)).not.toContain('ORD-1029') // last data row never sent
    })
})

function fakeFetch(status, body, headers = {}) {
    const calls = []
    const fn = async (url, init) => {
        calls.push({ url, init: { ...init, body: JSON.parse(init.body) } })
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (k) => headers[k.toLowerCase()] ?? null },
            text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
            json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
        }
    }
    fn.calls = calls
    return fn
}

describe('http provider (OpenAI-compatible, no real network)', () => {
    const reply = (content) => ({ choices: [{ message: { content } }] })

    it('sends system, history and user turns and returns the model text', async () => {
        const fetch = fakeFetch(200, reply('```json\n{"type":"clarify","question":"Which year?"}\n```'))
        const p = createHttpProvider({ endpoint: 'https://example.test/v1/chat/completions', apiKey: 'k', model: 'm', fetch })
        const out = await p.complete({ system: 'S', user: 'U', history: [{ role: 'user', content: 'H' }] })
        expect(out.text).toContain('Which year?')
        const { init } = fetch.calls[0]
        expect(init.headers.Authorization).toBe('Bearer k')
        expect(init.body.model).toBe('m')
        expect(init.body.messages.map(m => m.role)).toEqual(['system', 'user', 'user'])
    })

    it('surfaces auth, rate-limit, http and network failures with a kind', async () => {
        const mk = (fetch) => createHttpProvider({ endpoint: 'https://example.test/x', apiKey: 'k', fetch })
        await expect(mk(fakeFetch(401, { error: { message: 'Invalid API Key' } })).complete({ system: '', user: '' }))
            .rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('Invalid API Key') })
        await expect(mk(fakeFetch(429, { error: { message: 'slow down' } }, { 'retry-after': '7' })).complete({ system: '', user: '' }))
            .rejects.toMatchObject({ kind: 'rate_limit', message: expect.stringContaining('retry after 7s') })
        await expect(mk(fakeFetch(500, 'upstream exploded')).complete({ system: '', user: '' }))
            .rejects.toMatchObject({ kind: 'http', message: expect.stringContaining('500') })
        await expect(mk(async () => { throw new TypeError('Failed to fetch') }).complete({ system: '', user: '' }))
            .rejects.toMatchObject({ kind: 'network' })
        await expect(createHttpProvider({ apiKey: '' }).complete({ system: '', user: '' }))
            .rejects.toMatchObject({ kind: 'auth' })
    })
})

describe('assistant round trip', () => {
    it('returns PROVIDER_ERROR instead of throwing', async () => {
        const provider = { complete: async () => { const e = new Error('Rate limited (429)'); e.kind = 'rate_limit'; throw e } }
        expect(await ask({ provider, prompt: 'x', table, selection: null }))
            .toEqual({ ok: false, error: 'PROVIDER_ERROR', kind: 'rate_limit', detail: 'Rate limited (429)' })
    })
    it('rejects prose without JSON as INVALID_RESPONSE and keeps the raw text', async () => {
        const provider = { complete: async () => ({ text: 'Sorry, I cannot do that.' }) }
        const r = await ask({ provider, prompt: 'x', table, selection: null })
        expect(r).toMatchObject({ ok: false, error: 'INVALID_RESPONSE', raw: 'Sorry, I cannot do that.' })
    })
})

describe('plain-words plan description', () => {
    it('reads like a sentence', () => {
        expect(describeQuery({
            type: 'query', filters: [{ column: 'Region', op: 'eq', value: 'West' }, { column: 'Total', op: 'gt', value: 5000 }],
            groupBy: ['Sales Rep'], aggregates: [{ fn: 'sum', column: 'Total', as: 'Sales' }],
            sort: [{ column: 'Sales', dir: 'desc' }], limit: 3,
        })).toBe('Rows where Region is "West" and Total > 5000; grouped by Sales Rep; showing sum of Total (as "Sales"); sorted by Sales high to low; first 3.')
    })
})
