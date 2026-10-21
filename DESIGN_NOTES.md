# Design notes

## Challenges

- **Challenge 1: range selection and fill handle.** Selection model in `src/grid/selection.js`, series detection in `src/engine/fill.js`, `engine.fill()` in `src/engine/core.js`. All four acceptance checks are covered by tests in `src/engine/fill.test.js` (run against the real `fixtures/sales.tsv`).
- **Challenge 2: sort and filter.** `engine.sort()` / `engine.setFilter()` in `src/engine/core.js`, comparison in `src/engine/sort.js`, predicates in `src/engine/filter.js`, dropdown in `src/grid/FilterMenu.jsx`. Acceptance checks are in `src/engine/sort.test.js`; I also ran them through the UI in Chrome.
- **Challenge 3: virtualized grid at scale.** `src/grid/Grid.jsx` (layers, windowing, resize, frozen panes), `src/grid/axis.js` (prefix sums + binary search), name box in `src/grid/FormulaBar.jsx`, keyboard handling in `src/App.jsx`. The sheet is 100,000 × 200.
- **Challenge 4: ask your data.** `src/ai/`: `parse.js` (JSON extraction), `validate.js` (schema validator), `actions.js` (guard), `executor.js`, `context.js`, `prompt.js`, `assistant.js`, `provider.js`, and the panel `AiPanel.jsx` (Ctrl+K). All 20 golden queries pass in `src/ai/executor.test.js`, both from the plan and through the mock provider's wrapped text.

## Data model changes

The engine (`src/engine/core.js`) owns all sheet state. React keeps only the selection, the editing target and the engine's `version` number.

| State | Shape | Why |
|---|---|---|
| `cells` | `Map<key, { raw, value, ast?, refs?, ranges? }>`, key = `row * 16384 + col` | Sparse. Integer keys are cheaper than `"A1"` strings and decode with one division. Formulas are compiled once into an AST when written. |
| `styles` | `Map<key, StylePatch>` | Moved out of React state into the engine so undo, fill and insert/delete treat formatting like data. A patch stores only the properties that differ from `DEFAULT_STYLE`. |
| `colWidths`, `rowHeights` | sparse `Map<index, px>` | Sizes move with their columns/rows on insert/delete. |
| `rowIds` | `number[]` | Stable identity per row. Needed for "return to original order" after sorting (challenge 2). |
| `frozen` | `{ rows, cols }` | |
| `filters` | `Map<col, { values: string[] \| null, condition: { op, value } \| null }>` | A view. It decides which rows are hidden and never moves data. The hidden set is cached per version. |
| `sortState` | `{ blockId, col, dir, originalIds }` | `originalIds` is the order of row ids when the sort cycle started, so "original order" works after any number of sorts. |
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
| `sort({ col, dir, range? })` | `dir` is `'asc' \| 'desc' \| 'original'`. Sorts `range` (a multi-row selection) or, without one, the used range below row 1 with a trailing totals row pinned. Returns `false` when the order would not change. |
| `setFilter(col, spec \| null)`, `clearFilters()` | Set/clear one column's filter, or all. |
| `getFilter(col)`, `filteredColumns`, `isRowHidden(r)`, `filterStats()` → `{ visible, total }` | Filter state for the UI. |
| `distinctValues(col)` → `[{ key, label, count }]` | Checklist entries over the rows that pass the *other* columns' filters. |
| `sortState` | Current sort column/direction (header arrow). |
| `fitWidth(c, measure)`, `autoFitColumn(c, measure)` | Width that fits the widest displayed text in the column, clamped to 40–600 px. `measure(text, style)` is injected by the UI (canvas `measureText`), so the engine stays DOM-free. |
| `lastRecalcCount` | Number of formulas the last change re-evaluated. Tests use it to prove incremental recalculation. |
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
| Sort (header button) | The whole reorder, including moved styles/heights and rewritten references. |
| Apply / clear a column filter, Clear all filters | That filter change. |
| Resize a column/row (drag), auto-fit (double-click the border) | That size. Resizing one of several selected columns resizes all of them in one step. |
| Freeze row 1 / Freeze col A toggles | The freeze change. |
| AI: Insert into sheet | Every inserted cell. |
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

## Sort and filter rules

- **Sort is a physical edit.** It is a row permutation run through the same remap-and-rewrite path as insert/delete. Whole rows move, so styles, row heights and row ids travel with their data.
- **Block.** A multi-row selection containing the column is the block. Otherwise it is the used range from row 2, with the last row pinned when its first non-empty cell matches `/^(grand\s+)?(total|totals|subtotal|sum)\b/i`. A selection sort still moves whole rows; I chose to keep row identity intact rather than tear a row apart.
- **Comparison** (`sortKey`/`compareKeys`). Numbers come first (currency and percent text coerce; the three date formats compare as day numbers), then text compared case-insensitively, then blank cells, then fully blank rows. A row holding only formulas, such as the blank row's `=J21/G21`, counts as fully blank, because it has no data of its own. Direction reverses order *within* numbers and within text, but the class order stays fixed. So Units descending starts at 60, not at the stray `N/A`. Ties keep their original order (stable).
- **Cycle.** Ascending, then descending, then original. Original order is the `originalIds` captured on the first click.
- **Formulas follow rows.** A single reference to a moved row is remapped. A range that spans the whole block (`=SUM(J2:J32)`) is unchanged. Other multi-row ranges are also left alone: after a sort their rows no longer form a contiguous block, so there is nothing correct to remap them to.
- **Filters.** Values are matched on trimmed, lower-cased text (§3.2 `norm`), so the checklist shows one `West` entry with a count of 8, covering `West`, `West ` and `west`. The label is the first one seen. I treat the trailing space and the lower case as data-entry noise, not a different region. Conditions: contains, greater than, less than (dates if the operand is a date, otherwise numbers), is empty, is not empty. Columns combine with AND. Hidden rows have height 0, so they keep their row numbers (the gaps show) and still feed formulas. The totals row is filtered like any other row, as in Excel's AutoFilter.
- **With a filter active**, sort permutes only the visible rows among their own positions. Hidden rows stay where they are.

## Grid at scale

- **Windowing.** Rows and columns each have an axis (`createAxis`): a `Float64Array` of prefix sums of their sizes, with binary search for "which index is at pixel y". Hidden rows have size 0. A render reads only the rows and columns overlapping the viewport, plus a little overscan, straight from the engine. There is no React state per cell.
- **Layers.** One scroller holds a canvas as large as the sheet. The column headers and frozen rows, the row headers and frozen columns, and the corner are `position: sticky` layers. The browser's own scrolling keeps them in sync, so headers never lag a frame behind the body; a JS scroll-sync would always be one event late. Each sticky layer cancels its own height with a negative margin, so it takes no space in the flow. All four layers use canvas coordinates, so selection overlays render identically in each and are clipped by the layer.
- **Quantized viewport.** Scroll position is rounded down to 72 px / 200 px steps before it reaches React state. Scrolling within a step re-renders nothing; the browser just moves already-rendered cells.
- **Cheap re-renders.** `<Cell>` is memoized on primitive props plus a style object that the engine caches per style patch. A selection change re-renders no cells. Cells are plain blocks with `contain: strict`.
- **Editing.** The text being edited lives in a tiny external store (`editorStore.js`). Only the editor and the formula bar subscribe to it, so a keystroke is one small React commit and the grid does not re-render.
- **Freeze, resize, name box, keys.** Toolbar toggles freeze row 1 and column A. Drag a header border to resize; double-click it to auto-fit; drag a row header's bottom edge to change the row height. Sizes live in the engine, so they move with insert/delete and undo. The name box accepts a cell (`AZ5000`) or a range (`K2:K100000`). Keys: Ctrl+Home, Ctrl+End, PageUp/PageDown, Home/End, Ctrl+Arrow (edge of the data run), and Shift with any of these to extend.
- **Filling K2:K100000.** Name box → `K2`, type `=J2*2`, Enter. Name box → `K2:K100000`, Enter, then Ctrl+D. Ctrl+D is fill-down from the selection's first row: one undo step, 99,999 formulas, about 240 ms in the engine.

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
| Fill 5,000 cells < 200 ms | 5 seed columns (id, number pair, date, weekday, formula) × 1,000 rows, `engine.fill` including recalculation | 10.1 ms |
| Sort 10,000 rows < 300 ms | 10,000 rows × 11 columns built from the large fixture, including a `=J/G` formula per row that is rewritten as its row moves; sort by Total descending, including full recalculation | 123 ms |
| sales-large.tsv, sort by Date | 2,990 rows, engine only | 12.8 ms |
| same, in the UI | Click on the header button until the frame is painted (`sort → paint` user-timing measure, 3 runs) | 28–62 ms (engine 11–37 ms) |

| Any golden plan over sales-large < 50 ms | Executor per plan, median of 5; the slowest plan reported (`query-golden-slowest`) | 6.3 ms (snapshotting the sheet adds 1.2 ms) |
| Two-level group-by over 100,000 rows < 500 ms | Region × Category with sum/avg/count over generated messy rows | 76 ms |

Grid budgets. Measured on the production build in Chrome 155, driven headlessly by Playwright. Headless Chrome caps animation frames at 30 fps, so frame-time runs use `--disable-frame-rate-limit --disable-gpu-vsync`: each frame then takes exactly as long as its work, and a frame under 16.7 ms means 60 fps is achievable. Headless rasterizes on the CPU, so paint numbers are pessimistic compared with a normal GPU-backed window. Sheet for the scroll and typing runs: sales-large plus `K2:K100000 = J*2` (about 130,000 filled cells).

| Budget | How | Result |
|---|---|---|
| First paint < 100 ms | `first-contentful-paint` over 5 loads of `/` | 64–92 ms on warm loads (median 88 ms); the first load after a rebuild was 564 ms (cold cache) |
| Scroll at 60 fps | Script sets `scrollTop += step` each `requestAnimationFrame` for 240 frames, after a warm-up; frame time = rAF interval | 1 row/frame: avg 2.6 ms, p95 8.3 ms. 10 rows/frame: avg 14.5 ms, p95 23.9 ms. 100 rows/frame (a fling that replaces the whole window every frame): avg 18.6 ms, p95 34.6 ms |
| Keystroke latency < 16 ms with 50,000+ filled cells | Typing into J95000 with the sheet above. `keydown` → next animation frame, plus the Event Timing API (`PerformanceObserver({ type: 'event' })`) | Typing: 1.3–2.1 ms to the next frame; Event Timing reports 16 ms (Chrome rounds to 8 ms and includes frame presentation). Enter (commit + recalc + re-render): 9.3 ms |
| React commits while typing in J95000 | `npm run build:profile`, open `/?profile`. `<Profiler>` counts commits (shown in the status bar, written to the DOM directly so counting causes no commits) | 1 commit per keystroke (0.1–0.2 ms React time); Enter = 2 commits (1.9 ms) |
| Edits recalculate only dependents | Unit test with `lastRecalcCount`; `edit-far` benchmark | 1 formula re-evaluated for an edit to J95000; < 0.2 ms engine time |
| Fill K2:K100000 | `fill-100k` benchmark (engine) and the `fill` user-timing measure (UI) | 239 ms engine median; 380–540 ms in the UI including the re-render |

Profiling. A trace of fast scrolling first showed about 4 ms script, 3.6 ms paint and 2 ms each for style and layout per frame. The three changes that helped: cells as `contain: strict` blocks, not flex containers with attribute-substring alignment selectors; a smaller step and overscan, which renders about 850 cells instead of 1,150; and taking the editor subscription out of the grid. I also tried keying cells by slot to recycle DOM nodes. It didn't help, because the window size never matches the slot count, so I reverted it.

UI actions are wrapped in `timed()` (`src/perf.js`), which records `performance.measure` entries. They show in the DevTools performance panel and can be read back with `performance.getEntriesByName('sort → paint')`.

## AI

**Provider.** `createHttpProvider` speaks the OpenAI-compatible `/chat/completions` format with plain `fetch`. It defaults to Groq (`llama-3.3-70b-versatile`) because it is free and allows browser requests (CORS), so no backend is needed; any compatible endpoint works through `VITE_AI_ENDPOINT` / `VITE_AI_MODEL`. Only `provider.js` knows the vendor. The panel has a mock/http switch. Note: `VITE_*` values are bundled into the client, so this suits a local demo; a production build should proxy the call through a server.

**Flow.** `ask()` builds the context and system prompt, calls `provider.complete`, then `parseAction`: extract JSON → `JSON.parse` → validate against the schema for its `type`. Only a valid action reaches the executor. The card is built from `executeQuery`'s result; the model's text is never shown as an answer (it is visible only under "Show plan").

**Context sent** (inside the system prompt, so the user turn is exactly what was typed and the mock can match it):

```json
{
  "range": "A1:J2992", "rowCount": 2991,
  "columns": [{ "name": "Order ID", "index": 0, "letter": "A", "type": "id", "examples": ["ORD-10001", "ORD-10002", "ORD-10003"] }, "…one per column"],
  "sampleRows": [["ORD-10001", "2023-02-03", "Central", "…"], "…5 rows"],
  "selection": "C2:C10",
  "hasTotalsRow": true
}
```

Types are inferred from up to 200 values per column: percent, currency, date, id, number, else text. History: the last 6 turns (prompt + raw reply) are sent for refinement.

**Failures. Each one shows a card and changes nothing:**

| Case | Result |
|---|---|
| No JSON / unparsable JSON | `INVALID_RESPONSE` with the parser message |
| JSON fails the schema | `INVALID_RESPONSE` listing every problem with its path (`/filters/0/op: must be one of …`) |
| Any `type` other than query / format_sheet / clarify | `READ_ONLY`. The prompt tells the model to label change requests `{"type":"mutation"}`, so "Delete all orders…" is refused by code, not by trusting the model. |
| Unknown column | Executor returns `UNKNOWN_COLUMN:<name>`; the card asks which column was meant and lists the real ones. It never guesses. |
| Network / 401-403 / 429 / other HTTP | `PROVIDER_ERROR` with kind and the provider's message (and Retry-After for 429) |

**Executor notes.** Row results are raw cell text; numbers in results are rounded to 2 decimals. `limit` is capped at 500 in code whatever the plan says. A descending sort reverses the whole comparison (contract §3.5 does not pin blanks), unlike the grid sort, which keeps blanks last.

**Insert into sheet** writes the header plus rows at the chosen cell with `setValues`, one undo step. **Re-run** re-executes the stored plan on the current sheet with no model call.

## Trade-offs and what I would do next

- Range dependencies are found by scanning the formulas bucketed under a column. That is fine for a few range formulas per column, but 100,000 running totals (`=SUM($A$1:A2)` filled down) would make it quadratic. An interval tree per column would fix it.
- Whole-row/column formatting is clipped to the used range rather than stored as a column style.
- At fling speeds a DOM grid repaints about 850 nodes per frame. A canvas-rendered body would make that flat, at the cost of text selection and accessibility.

## Use of AI tools

Claude Code (Anthropic) helped write and review code, tests and these notes. I ran every acceptance check myself and can explain each design decision.
