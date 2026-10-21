// ─────────────────────────────────────────────────────────────
//  System prompt. The sheet context goes here (not in the user
//  turn) so the user turn is exactly what the user typed: the
//  mock provider looks prompts up verbatim, and history stays
//  readable.
// ─────────────────────────────────────────────────────────────
import { QUERY_PLAN_SCHEMA, FORMAT_SHEET_SCHEMA, CLARIFY_SCHEMA, MAX_RESULT_ROWS } from './contract.js'

export function buildSystemPrompt(context) {
    return [
        'You turn a spreadsheet user\'s request into ONE JSON action. You never compute answers yourself:',
        'the app executes your action deterministically and shows the numbers it computes.',
        '',
        'Reply with a single JSON object and nothing else. Allowed actions:',
        `1. "query": a read-only analysis plan. Schema: ${JSON.stringify(QUERY_PLAN_SCHEMA)}`,
        `2. "format_sheet": formatting intent. Schema: ${JSON.stringify(FORMAT_SHEET_SCHEMA)}`,
        `3. "clarify": ask the user one question. Schema: ${JSON.stringify(CLARIFY_SCHEMA)}`,
        '',
        'Rules:',
        '- Use column names exactly as they appear in the context below.',
        '- If the user names a column that is not in the context, put their word in the plan unchanged.',
        '  Do not substitute a similar column; the app will ask the user which one they meant.',
        '- If the user asks to change, delete, add or overwrite data, reply {"type":"mutation","request":"<what they asked>"}.',
        '  The app will refuse it; it is read-only.',
        '- filters are ANDed. Dates in filter values use YYYY-MM-DD. "In 2024" = gte 2024-01-01 and lt 2025-01-01.',
        '- aggregates need "as" with a short readable name; sort may name an aggregate by that name.',
        `- "Top N" means sort descending and limit N. The app never returns more than ${MAX_RESULT_ROWS} rows.`,
        '- For row listings without aggregates, "columns" chooses which columns to show.',
        '- format_sheet column indexes are 0-based (A = 0). Row 1 is the header. freezeRows: 0 unfreezes.',
        '- If the request is ambiguous, use "clarify".',
        '',
        `Sheet context: ${JSON.stringify(context)}`,
    ].join('\n')
}
