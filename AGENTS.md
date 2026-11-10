# AGENTS.md — Efekta Turbo Playbook (Autonomous Protocol)

This repository provides **`efekta` v3.0 (Turbo Autonomous Engine)**, an ultra-fast CLI & MCP server for AI agents to inspect and complete English lessons on `learn.better.efekta.com`.

---

## 0. The 4 Golden Laws of Speed (Memorize These!)

1. **LET THE PROGRAM DO THE WORK FIRST (`efekta auto`):**
   `efekta auto` autonomously navigates passive reading cards, auto-skips pronunciation drills, auto-solves multiple-choice questions (both single and multi-select!), and auto-conducts avatar dialogues. It only stops when a knowledge task (`gaps`, `sort`, `pair`, essay) needs your answer!
2. **ALWAYS end every exercise `batch` with `; next` (or `; auto`):**
   Appending `; next` clicks Next AND automatically fast-forwards through all consecutive passive screens (reading cards, "Correct answers" reviews, "Step passed!" summaries, Lesson Overviews) until the next interactive exercise!
3. **ALWAYS pass `--json -c` (Compact Mode) and read `agentHint` FIRST:**
   `--json -c` strips raw coordinate dumps (saving **80% tokens**) while providing:
   - `exerciseType`
   - `actionTemplate` (ready-to-fill command!)
   - `slots`, `items`, `options`, `inputs` (clean, deduplicated `id: text` lists)
4. **SKIP MULTI-PHRASE PRONUNCIATION DRILLS IN 1 COMMAND:**
   Whenever a pronunciation drill appears in Stages 1–5, run:
   ```bash
   efekta skip --json -c
   ```
   This automatically skips ALL 5–7 phrases in the drill in 1 single shot and advances!

---

## 1. Instant Decision Matrix (See `exerciseType` -> Run 1 Command)

Look at `data.agentHint.exerciseType` from your last response and immediately run the matching **single command**:

| `exerciseType` | What You See in `agentHint` | Single Command to Execute |
| :--- | :--- | :--- |
| `passive_screen` / `lesson_overview` | `canProceed: true` or `stage-1..stage-N` | `efekta next --json -c` *(or `efekta auto --json -c`)* |
| `multiple_choice` (1 answer) | `options: ["opt-1: ...", "opt-2: ..."]` | `efekta batch "solve choice; next" --json -c` *(or `efekta batch "pick opt-2; next" --json -c`)* |
| `multiple_choice` (multi-select) | Prompt says *"Choose three"* + `options` | `efekta batch "solve choice; next" --json -c` *(or `efekta batch "pick opt-1,opt-3,opt-5; next" --json -c`)* |
| `matching_pairs` | `slots: ["slot-1: ..."]` + `items: ["item-1: ..."]` | `efekta batch "pair slot-1:item-3, slot-2:item-1, slot-3:item-2; next" --json -c` |
| `categorize_columns` | 2 category `slots` + N draggable `items` | `efekta batch "sort slot-1:item-1,item-4; sort slot-2:item-2,item-3; next" --json -c` |
| `selection_gaps` | `contextText` has `[slot-1]` + bottom word drawer | `efekta batch "gaps word1, word2, word3, word4, word5; next" --json -c` |
| `fill_in_the_blanks` (short blanks) | `contextText` has `[input-1]` text blanks | `efekta batch "gaps answer1, answer2, answer3; next" --json -c` |
| `fill_in_the_blanks` (75+ word essay)| `textarea` asking for writing | `efekta batch "type input-1 '<100+ word essay>'; next" --json -c` |
| `order_sentence` | `items` are shuffled sentence words | `efekta batch "pick item-3,item-1,item-4,item-2; next" --json -c` |
| `order_dialogue` | `items` are dialogue turns (`cdk-drag`) | `efekta batch "drag item-2 item-1; next" --json -c` |
| `speaking_practice` | Pronunciation drill with target phrase | `efekta skip --json -c` *(or `efekta batch "speak all; next" --json -c`)* |
| `speaking_avatar` (mandatory final) | AI video avatar roleplay (turns A/B/C) | `efekta batch "dialogue; next" --json -c` *(or `efekta batch "speak opt-2; next" --json -c`)* |

---

## 2. How Each Turbo Macro Works Under the Hood

### `auto` / `autopilot` — Full Autonomous Progression
```bash
efekta auto --json -c
```
- Completely offloads multiple-choice questions, pronunciation drills, passive reading cards, and avatar dialogues to the program.
- Automatically stops and prompts you with `agentHint` ONLY when a real human-knowledge exercise is encountered (`gaps`, `sort`, `pair`, essay).

### `next` / `ff` — Auto-Fast-Forward
```bash
efekta next --json -c
```
- Clicks `next-1` (or the first incomplete `stage-N` on Lesson Overview), waits for Angular to render, and **loops up to 9 times** through passive reading cards, `"Correct answers"` reviews, self-evaluation prompts, `"Step passed!"` summaries, and Lesson Overviews.
- Stops the instant an interactive exercise appears and returns its `agentHint` + `autoReadNotes`.

### `skip` — 1-Shot Speaking Drill Skipper
```bash
efekta skip --json -c
```
- Loops through all 5–7 phrases of a pronunciation drill in Stage 1–5, clicks `Skip` on each phrase, and automatically fast-forwards directly to the next interactive exercise!

### `solve choice` — Ultra-Fast Smart Multiple Choice Solver
```bash
efekta batch "solve choice; next" --json -c
```
- Tests options with instant abort on `.incorrect` (takes ~35ms per wrong option instead of 260ms).
- Seamlessly handles multi-select: deselects wrong options, keeps `.correct` options selected, and proceeds until Next unlocks!

### `dialogue` / `avatar` — Hybrid Avatar Dialogue Solver
```bash
efekta batch "dialogue; next" --json -c
```
- Conducts the entire multi-turn AI avatar roleplay.
- For speech turns: uses native Voice Engine v3 to synthesize clean English TTS for options A/B/C.
- For tap turns: automatically selects or solves the right option without failing on missing mic buttons.
- Automatically detects and clicks "Finish skipped tasks" if any turn was skipped so the step passes 100%!

### `gaps` — Automatic Drawer & Input Filler
```bash
efekta batch "gaps wait, better, time, lifestyle, yourself; next" --json -c
```
- Automatically handles both Selection-Gap Drawers and Text Inputs in exact order.

### `sort` — DOM-Shift-Immune Category Sorting
```bash
efekta batch "sort slot-1:item-1,item-3; sort slot-2:item-2,item-4; next" --json -c
```
- Snapshots item clean texts upfront before clicking, ensuring DOM removal across items never loses track of the remaining items.
