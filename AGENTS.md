# AGENTS.md — Efekta Turbo Playbook (1-Command-Per-Screen Protocol)

This repository provides **`efekta` v2.2 (Turbo Engine)**, an ultra-fast CLI & MCP server for AI agents to inspect and complete English lessons on `learn.better.efekta.com` in **1 command per interactive exercise**.

---

## 0. The 4 Golden Laws of Speed (Memorize These!)

1. **NEVER call `wait` or `status` manually between exercises:**
   Every `batch`, `next`, `pick`, `pair`, `sort`, and `gaps` command **automatically waits** for Efekta's UI locks (`.locked`, `.item-disabled`, animations) AND **returns the fresh page state** in `data`!
2. **ALWAYS end every exercise `batch` with `; next`:**
   Appending `; next` clicks the Next button AND **automatically fast-forwards through all consecutive passive screens** (reading cards, `"Correct answers"` review screens, `"Step passed!"` summaries, and Lesson Overviews) until the browser lands on the next interactive exercise! Any passive reading text traversed along the way is returned in `data.autoReadNotes`.
3. **ALWAYS pass `--json -c` (Compact Mode) and read `agentHint` FIRST:**
   `--json -c` strips the raw `elements` coordinate dump (saving **80% tokens**) while keeping `data.agentHint`, which gives you:
   - `exerciseType`
   - `actionTemplate` (ready-to-fill command!)
   - `slots`, `items`, `options`, `inputs` (clean, deduplicated `id: text` lists)
4. **NEVER do voice recording in Stages 1–5:**
   If a non-final stage shows a microphone with a `SKIP` button (`skip-1`), skip it in 1 command:
   ```bash
   efekta batch "click skip-1; next" --json -c
   ```

---

## 1. Instant Decision Matrix (See `exerciseType` -> Run 1 Command)

Look at `data.agentHint.exerciseType` from your last response and immediately run the matching **single command**:

| `exerciseType` | What You See in `agentHint` | Single Command to Execute |
| :--- | :--- | :--- |
| `passive_screen` / `lesson_overview` | `canProceed: true` or `stage-1..stage-N` | `efekta next --json -c` |
| `multiple_choice` (1 answer) | `options: ["opt-1: ...", "opt-2: ..."]` | `efekta batch "pick opt-2; next" --json -c` *(or `efekta batch "solve choice; next" --json -c`)* |
| `multiple_choice` (multi-select) | Prompt says *"Choose three"* + `options` | `efekta batch "pick opt-1,opt-3,opt-5; next" --json -c` |
| `matching_pairs` | `slots: ["slot-1: ..."]` + `items: ["item-1: ..."]` | `efekta batch "pair slot-1:item-3, slot-2:item-1, slot-3:item-2; next" --json -c` |
| `categorize_columns` | 2 category `slots` + N draggable `items` | `efekta batch "sort slot-1:item-1,item-4; sort slot-2:item-2,item-3; next" --json -c` |
| `selection_gaps` | `contextText` has `[slot-1]` + bottom word drawer | `efekta batch "gaps word1, word2, word3, word4, word5; next" --json -c` |
| `fill_in_the_blanks` | `contextText` has `[input-1]` text blanks | `efekta batch "gaps answer1, answer2, answer3; next" --json -c` |
| `order_sentence` | `items` are shuffled sentence words | `efekta batch "pick item-3,item-1,item-4,item-2; next" --json -c` |
| `speaking_practice` | Pronunciation drill with target phrase | `efekta batch "speak all; next" --json -c` |
| `speaking_avatar` (optional) | `skip-1` exists in `elements` | `efekta batch "click skip-1; next" --json -c` |
| `speaking_avatar` (mandatory final) | No `skip-1`; AI avatar shows options A/B/C | `efekta batch "pick opt-2; next" --json -c` *(or `efekta batch "speak opt-2; next" --json -c`)* |

---

## 2. How Each Turbo Macro Works Under the Hood

### `next` / `ff` — Auto-Fast-Forward
```bash
efekta next --json -c
```
- Clicks `next-1` (or the first incomplete `stage-N` on Lesson Overview), waits for Angular to render, and **loops up to 7 times** if the next screen is a passive reading card, `"Correct answers"` review, `"Step passed!"` celebration, or Lesson Overview.
- Stops the instant an interactive exercise appears and returns its `agentHint` + `autoReadNotes` (all vocabulary/grammar notes collected along the way).

### `pick` — Multi-Option / Sentence Token Selector
```bash
efekta batch "pick opt-1,opt-4,opt-5; next" --json -c
```
- Snapshots all target texts **upfront** before the first click.
- Automatically waits for `.locked` to clear between clicks (~220ms), so multi-select checkboxes and sentence-ordering tokens never drop a click.

### `pair` — 1-Shot Matching Pairs
```bash
efekta batch "pair slot-1:item-4, slot-2:item-1, slot-3:item-5, slot-4:item-2, slot-5:item-3; next" --json -c
```
- Snapshots the text of every `slot-X` and `item-Y` **before** clicking anything.
- Clicks each left card, waits 95ms, clicks the right card, waits for `.correct` animation, and moves to the next pair.

### `sort` — DOM-Shift-Immune Category Sorting
```bash
efekta batch "sort slot-1:item-1,item-3,item-5; sort slot-2:item-2,item-4,item-6; next" --json -c
```
- In Efekta's sorting UI, sorting `item-1` removes it from the DOM. `sort` snapshots the clean text of every item **upfront**, clicks the item, clicks the category `slot-X`, and waits for the item to leave the DOM before sorting the next one.

### `gaps` — Automatic Drawer & Input Filler
```bash
efekta batch "gaps wait, better, time, lifestyle, yourself; next" --json -c
```
- Works for both **Selection-Gap Drawers** (`button.selection-gap-button` + `div.drawer-option`) and **Text Inputs** (`input-1`, `input-2`).
- For Selection-Gap Drawers, `gaps` automatically clicks the next unfilled gap button, waits for the bottom `.drawer-option` drawer to open, clicks the matching word option, waits for the drawer to close, and repeats for every word in order!

### `speak` / `speak all` — Voice Engine v3 (Real Speech Input)
```bash
efekta batch "speak all; next" --json -c
```
- **Real physical mic is untouched**: user can speak into their microphone anytime without interference.
- When `speak` runs, it arms a 1-shot injection window, intercepts native speaker reference audio or synthesizes clean English TTS via daemon `/api/tts`, feeds it cleanly into WebAudio destination stream, and disarms immediately after.
- In multi-phrase pronunciation drills, `speak all` speaks all 5 phrases in sequence with native pronunciation and auto-advances!
- In AI Avatar dialogues, Efekta presents response options A, B, C in `agentHint.options`. Pick or speak the chosen option directly:
  - If tap buttons are visible: `efekta batch "pick opt-2; next" --json -c`
  - If speech is active: `efekta batch "speak opt-2; next" --json -c` (or `speak B`). Do NOT invent answers; choose from the provided options!
