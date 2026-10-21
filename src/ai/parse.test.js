import { describe, it, expect } from 'vitest'
import { extractJson } from './parse.js'
import { validate } from './validate.js'
import { parseAction } from './actions.js'
import { QUERY_PLAN_SCHEMA } from './contract.js'

describe('extractJson', () => {
    it('handles bare JSON, prose, fences and braces inside strings', () => {
        expect(extractJson('{"a":1}').value).toEqual({ a: 1 })
        expect(extractJson('Sure! Here is the plan:\n```json\n{"a":"}{"}\n```\nAnything else?').value).toEqual({ a: '}{' })
        expect(extractJson('Use {curly} words? {"a": {"b": [1, 2]}}').value).toEqual({ a: { b: [1, 2] } })
    })
    it('fails clearly on non-JSON', () => {
        expect(extractJson('I cannot help with that.')).toEqual({ ok: false, error: 'no JSON object in the response' })
        expect(extractJson('{"a": 1,}').ok).toBe(false)
        expect(extractJson('').ok).toBe(false)
    })
})

describe('validate', () => {
    it('reports every problem with a path', () => {
        const problems = validate(QUERY_PLAN_SCHEMA, {
            type: 'query', limit: 0, filters: [{ column: 'Region', op: 'like' }], extra: true,
        })
        expect(problems).toEqual([
            '/limit: must be >= 1',
            '/filters/0/op: must be one of "eq", "neq", "gt", "gte", "lt", "lte", "contains", "startsWith", "endsWith", "isEmpty", "notEmpty"',
            '/extra: is not allowed',
        ])
    })
    it('distinguishes integers from numbers', () => {
        expect(validate(QUERY_PLAN_SCHEMA, { type: 'query', limit: 2.5 })).toEqual(['/limit: expected integer, got number'])
    })
})

describe('parseAction', () => {
    it('rejects unknown action types as READ_ONLY before anything runs', () => {
        expect(parseAction('{"type":"mutation","action":"deleteRows"}').error).toBe('READ_ONLY')
    })
    it('rejects invalid plans with the reason', () => {
        const r = parseAction('{"type":"query","groupBy":"Region"}')
        expect(r.error).toBe('INVALID_RESPONSE')
        expect(r.detail).toBe('/groupBy: expected array, got string')
    })
    it('rejects a clarify without a question', () => {
        expect(parseAction('{"type":"clarify"}').detail).toBe('/question: is required')
    })
})
