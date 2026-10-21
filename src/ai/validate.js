// ─────────────────────────────────────────────────────────────
//  A small JSON Schema validator: exactly the keywords the action
//  schemas in contract.js use (type incl. 'integer' and unions,
//  const, enum, required, properties, additionalProperties: false,
//  items, minimum, maximum, pattern). Returns every problem with a
//  JSON-pointer-ish path, e.g. "/filters/0/op: must be one of …".
// ─────────────────────────────────────────────────────────────

function typeOf(v) {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
    return typeof v
}

function typeMatches(v, type) {
    const t = typeOf(v)
    if (type === 'number') return t === 'number' || t === 'integer'
    return t === type
}

/** @returns {string[]} problems; empty when valid */
export function validate(schema, value, path = '') {
    const errors = []
    const at = path || '/'

    if (schema.const !== undefined && value !== schema.const) {
        errors.push(`${at}: must be ${JSON.stringify(schema.const)}`)
        return errors
    }
    if (schema.enum && !schema.enum.some(e => e === value)) {
        errors.push(`${at}: must be one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')}`)
        return errors
    }
    if (schema.type) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type]
        if (!types.some(t => typeMatches(value, t))) {
            errors.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`)
            return errors
        }
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`)
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`)
    }
    if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errors.push(`${at}: does not match ${schema.pattern}`)
    }
    if (Array.isArray(value) && schema.items) {
        value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}/${i}`)))
    }
    if (typeOf(value) === 'object') {
        for (const key of schema.required || []) {
            if (!(key in value)) errors.push(`${path}/${key}: is required`)
        }
        const props = schema.properties || {}
        for (const [key, v] of Object.entries(value)) {
            if (props[key]) errors.push(...validate(props[key], v, `${path}/${key}`))
            else if (schema.additionalProperties === false) errors.push(`${path}/${key}: is not allowed`)
        }
    }
    return errors
}
