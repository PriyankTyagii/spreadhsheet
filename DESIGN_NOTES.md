# Design notes

## Challenges

- **Challenge 1: range selection and fill handle.** Selection model in `src/grid/selection.js`, series detection in `src/engine/fill.js`, `engine.fill()` in `src/engine/core.js`. All four acceptance checks are covered by tests in `src/engine/fill.test.js` (run against the real `fixtures/sales.tsv`).

## Data model changes

The engine (`src/engine/core.js`) owns all sheet state. React keeps only the selection, the editing target and the engine's `version` number.

| State | Shape | Why |
|---|---|---|
| `cells` | `Map<key, { raw, value, ast?, refs?, ranges? }>`, key = `row * 16384 + col` | Sparse. Integer keys are cheaper than `"A1"` strings and decode with one division. Formulas are compiled once into an AST when written. |
| `styles` | `Map<key, StylePatch>` | Moved out of React state into the engine so undo, fill and insert/delete treat formatting like data. A patch stores only the properties that differ from `DEFAULT_STYLE`. |
| `colWidths`, `rowHeights` | sparse `Map<index, px>` | Sizes move with their columns/rows on insert/delete. |
| `rowIds` | `number[]` | Stable identity per row. Needed for "return to original order" after sorting (challenge 2). |
| `frozen` | `{ rows, cols }` | |
| dependency index | `dependents: Map<key, Set<key>>` for single refs; `rangeBuckets: Map<col, Set<formulaKey>>` for ranges | The starter only tracked a range's two corners, so `=SUM(A1:A3)` ignored edits to A2. |

Values: a typed literal is a number only if it is a plain numeral (`parseLiteral`). Otherwise it stays text, and arithmetic coerces `$1,200.00` / `10%` via `toNum` (AI_CONTRACT §3.2). The same coercion functions (`src/engine/values.js`) serve formulas, sort, filter, fill and the AI executor.

## Engine API

Every method below that mutates is exactly one undo step. "No-op" means nothing is recorded.

| Method | What it does |
|---|---|
| `getCell(r, c)` → `{ raw, computed, error }` | Unchanged from the starter. |
| `getValue(r, c)`, `getRaw(r, c)`, `getText(r, c)`, `getDisplay(r, c)`, `getStyle(r, c)` | Computed value; raw input; text before number formatting; text the grid shows; style merged over defaults. |
| `usedRange()` → `{ r1: 0, c1: 0, r2, c2 } \| null` | Bounding box of non-empty cells, anchored at A1. Cached per version. |
| `setCell(r, c, raw)` | Unchanged signature. No-op if the value is the same. |
| `setValues(r, c, matrix, label?)` | Writes a block of raw strings. Used by the sample loaders. |
| `clearRange(rect)` | Clears contents (keeps formatting) — Delete/Backspace. |
| `clearAll()` | Values, styles, sizes and freeze. |
| `applyStyle(rect, patch)` | Merges a style patch into every cell of the rectangle. |
| `fill(source, target)` | Fill handle. `target` contains `source` and extends it in one direction; a smaller target clears the cells dragged back over. Always records one undo step, even if every value was already in place, so Ctrl+Z right after a fill never undoes the action before it. |
| `insertRow(at)`, `deleteRow(at)`, `insertColumn(at)`, `deleteColumn(at)` | Unchanged signatures. Plural forms `insertRows(at, n)` etc. take a count. |
| `setColWidth(c, px)`, `setRowHeight(r, px)`, `colWidth(c)`, `rowHeight(r)` | Sizes. |
| `setFreeze(rows, cols)`, `frozenRows`, `frozenCols` | `null` leaves that axis unchanged. |
| `transact(label, fn)` | Runs `fn` as one undo step. Nested calls join the outer one. If `fn` throws, everything it did is rolled back. |
| `undo()`, `redo()`, `canUndo()`, `canRedo()`, `undoDepth` | |
| `version`, `subscribe(fn)` | `version` increments after every change; the UI re-renders through `useSyncExternalStore`. |
| `ensureCapacity(rows, cols)` | Unchanged (not undoable; only moves bounds). |

## Undo semantics

A transaction records primitive changes: a cell's raw value before and after, a style patch before and after, or a closure pair for sizes, freeze and structural edits. Undo replays them in reverse; redo replays them forward. Recalculation runs once, when the transaction closes.

Structural edits (insert/delete row/column, and sort later) are a remap of indices plus a reference rewrite. The undo record keeps the inverse remap, the cells/styles/sizes/row ids that were removed, and the original text of every formula whose text changed. Undo applies the inverse remap without rewriting, then restores those exactly. Re-applying the forward rewrite is not an inverse: deleting a row turns a reference into `#REF!` and shrinks ranges, and both lose information.

| User action | One Ctrl+Z reverts |
|---|---|
| Edit a cell | That cell. |
| Fill handle drag / Ctrl+D / Ctrl+R | Every filled value and inherited style (or the cells a shrink cleared). |
| Delete / Backspace on a selection | Every cleared cell. |
| Toolbar formatting on a selection | The style of every cell in the selection. |
| Insert / delete row or column | The whole edit, including widths/heights, styles and rewritten formulas. |
| Load sample | The whole load (previous sheet comes back). |
| Clear all | Everything it cleared. |

## Fill rules (`src/engine/fill.js`)

Seeds are read along the fill direction, per column (vertical) or per row (horizontal).

- One number: copy. Two or more numbers: linear trend (least squares, so `1, 2` → `3, 4`).
- Text ending in a number (`Item 1`, `Q4`, `2024-W01`, `ORD-1001`): the number increments by the seed step (1 for a single seed). Zero padding is kept when the seed has a leading zero (`A-099` → `A-100`).
- Dates in the three sample formats: step = the seeds' average delta in days, rounded to whole days (1 for a single seed). Each produced cell is printed in the format of the seed it maps to cyclically, so `B2:B4` (ISO, ISO, M/D/YYYY) filled to `B8` gives ISO, ISO, M/D/YYYY, ISO.
- Weekday and month names (short or long) cycle, keeping the seed's case (`Mon`, `MON`, `mon`).
- Formulas: each produced cell copies the seed at the same position in the cycle, shifted by its distance from that seed. `$` parts stay pinned. A reference that would go above row 1 or left of column A becomes `#REF!`.
- Anything else, or mixed seeds: the seeds repeat.
- Filled cells take the style of the seed they came from.
- Dragging up or left runs the series backwards.
- Dragging back inside the selection clears the cells left out, in one undo step.

## Defects found in the existing code

| Where | Symptom | Root cause | Fix |
|---|---|---|---|
| `parseTokensToAST`, range token | Every range formula (`=SUM(A1:A2)`) showed `#PARSE!`. The starter test "evaluates arithmetic and ranges" failed out of the box. | The shunting-yard loop handled `:` when only the left cell was on the output queue, so the range check `outputQueue.length < 2` always threw. | Replaced with a recursive-descent parser (`src/engine/formula.js`) that reads `ref ':' ref` as one primary. |
| `updateDependencies` / `extractCellReferences` | `=SUM(A1:A3)` did not update when A2 changed. | Only the regex-matched corners `A1` and `A3` were registered as dependencies. | Ranges are indexed per column and checked by containment (`dependentsOf`). |
| `resolveCellValue` | `2024-01-15` was the number 2024, `1/8/2024` was 1, `12 units` was 12. | `parseFloat` accepts any numeric prefix. | `parseLiteral` accepts only a whole numeral. |
| `executeSetCell` / cache | Every edit invalidated the whole cache (`_generation++`), so every cell recomputed on next read. | The generation counter was bumped on all edits, not just structural ones. | Removed the generation scheme. Recalc is push-based: changed cells plus transitive dependents, in Kahn order. |
| `topologicalSort` / `recalculate` | Quadratic recalculation on large sheets. | `queue.shift()` and `sorted.includes()` inside loops. | Index-based queue; leftover cells are cycle members. |
| `getAllDependentsRecursive` | Stack overflow possible on long chains (`A2=A1+1` filled down). | Recursive DFS. | Iterative traversal (tested on a 20,000-cell chain). |
| `performDeleteRow` / `shiftCellReferences` | Deleting row 2 made `=A2*2` silently point at row 1, and ranges were not shrunk. | References to the deleted row were shifted like the rows below it. | A reference into a deleted row becomes `#REF!`; ranges shrink (`deletePolicy`). |
| `shiftCellReferences` | Would rewrite text that only looks like a reference (`LOG10`), and had no notion of `$`. | Regex over the raw string. | Token-based rewrite that preserves `$` flags and the rest of the text. |
| `App.jsx` `clearAllCells` | "Clear all" on a large sheet froze the tab. | `rows × cols` separate `setCell` calls, each with recalculation and an undo entry. | `engine.clearAll()`, one transaction. |
| `loadSample.js` | Loading 3,000 rows created 30,000 undo entries and recalculated 30,000 times. | One `setCell` per cell. | `setValues`, one transaction. |
| `App.jsx` cell styles | Formatting could not be undone and stayed put on insert/delete. | Styles lived in React state keyed by `"row,col"`. | Styles live in the engine. |

## Measurements

Method: `npm run build && npm run preview`, then open `/?bench` in Chrome. The page runs `src/bench/benchmarks.js` in the production bundle and reports the median of 7 runs; I drove it headlessly with Playwright. Machine: Apple M5, 16 GB, macOS 26.5, Chrome 155.

| Budget | Case | Median |
|---|---|---|
| Fill 5,000 cells < 200 ms | 5 seed columns (id, number pair, date, weekday, formula) × 1,000 rows, `engine.fill` including recalculation | 10.9 ms |

## Trade-offs and what I would do next

- Range dependencies are found by scanning the formulas bucketed under a column. That is fine for a few range formulas per column, but 100,000 running totals (`=SUM($A$1:A2)` filled down) would make it quadratic. An interval tree per column would fix it.
- Whole-row/column formatting is clipped to the used range rather than stored as a column style.

## Use of AI tools

Claude Code (Anthropic) helped write and review code, tests and these notes. I ran every acceptance check myself and can explain each design decision.
