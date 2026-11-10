# AGENTS.md — Efekta Turbo Playbook (Autonomous Protocol)

This repository provides **`efekta` v3.0 (Turbo Autonomous Engine)**, an ultra-fast CLI & MCP server for AI agents to inspect and complete English lessons on `learn.better.efekta.com`.

---

## 0. The 5 Golden Laws of Speed & Precision (Memorize These!)

1. **LET THE PROGRAM DO THE WORK FIRST (`efekta auto`):**
   `efekta auto` autonomously navigates passive reading cards, auto-skips pronunciation drills, auto-solves multiple-choice questions (both single and multi-select!), conducts avatar dialogues, and submits essays. It only stops when a knowledge task (`gaps`, `sort`, `pair`) needs your answer!
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
5. **PROGRESS TEST MANDATE ("Take the final test") — ZERO TRIAL-AND-ERROR:**
   - **TRIAL-AND-ERROR / BRUTE-FORCE (`solve choice`) IS STRICTLY FORBIDDEN ON THE FINAL TEST!**
   - Regular lessons permit retry heuristics. On the Progress Test, every question is an unrepeatable formal assessment; incorrect choices directly degrade the final certificate score below the mandatory 70% threshold.
   - The engine automatically detects Progress Tests, tags them as `exerciseType: "progress_test_choice"`, and actively blocks `solve choice` and `auto` to safeguard your exam score.
   - Always derive the correct answer using precise grammatical, syntactical, and context-specific linguistic analysis, then submit with `efekta batch "pick opt-X; next" --json -c`.

---

## 1. Instant Decision Matrix (See `exerciseType` -> Run 1 Command)

Look at `data.agentHint.exerciseType` from your last response and immediately run the matching **single command**:

| `exerciseType` | What You See in `agentHint` | Single Command to Execute | MCP Tool |
| :--- | :--- | :--- | :--- |
| `course_overview` / `unknown` (dashboard) | On course page (`/gap/ui/self-study`) | `efekta lesson next --json -c` *(or `efekta auto --json -c`)* | `efekta_lesson(target: "next")` |
| `passive_screen` / `lesson_overview` | `canProceed: true` or `stage-1..stage-N` | `efekta next --json -c` *(or `efekta auto --json -c`)* | `efekta_next()` / `efekta_autopilot()` |
| `multiple_choice` (Lesson) | `options: ["opt-1: ...", "opt-2: ..."]` | `efekta batch "solve choice; next" --json -c` | `efekta_solve(strategy: "choice")` |
| **`progress_test_choice` (Final Test)** | Graded single-shot exam question | `efekta batch "pick opt-X; next" --json -c` *(Analyze first!)* | `efekta_batch(commands: "pick opt-X; next")` |
| `matching_pairs` | `slots: ["slot-1: ..."]` + `items: ["item-1: ..."]` | `efekta batch "pair slot-1:item-3, slot-2:item-1; next" --json -c` | `efekta_batch(commands: "pair ...; next")` |
| `categorize_columns` | 2 category `slots` + N draggable `items` | `efekta batch "sort slot-1:item-1,item-4; sort slot-2:item-2; next" --json -c` | `efekta_batch(commands: "sort ...; next")` |
| `selection_gaps` | `contextText` has `[slot-1]` + drawer | `efekta batch "gaps word1, word2, word3; next" --json -c` | `efekta_batch(commands: "gaps ...; next")` |
| `fill_in_the_blanks` (short blanks) | `contextText` has `[input-1]` text blanks | `efekta batch "gaps answer1, answer2; next" --json -c` | `efekta_batch(commands: "gaps ...; next")` |
| `writing_essay` (75–120+ words) | `textarea` asking for writing | `efekta batch "essay; next" --json -c` *(or `efekta essay --json -c`)* | `efekta_essay(text: "auto")` |
| `order_sentence` (tap sequence) | `ef-sequencing-tap-option-task` tokens | `efekta batch "sequence auto; next" --json -c` | `efekta_sequence(tokens: "auto")` |
| `order_sentence` (token picker) | `items` are shuffled sentence words | `efekta batch "pick item-3,item-1,item-4,item-2; next" --json -c` | `efekta_batch(commands: "pick ...; next")` |
| `order_dialogue` | `items` are dialogue turns (`cdk-drag`) | `efekta batch "drag item-2 item-1; next" --json -c` | `efekta_batch(commands: "drag ...; next")` |
| `speaking_practice` | Pronunciation drill with target phrase | `efekta skip --json -c` *(or `efekta batch "speak all; next" --json -c`)* | `efekta_solve(strategy: "speak")` |
| `speaking_avatar` (mandatory final) | AI video avatar roleplay (turns A/B/C) | `efekta batch "dialogue; next" --json -c` | `efekta_dialogue()` |

---

## 2. How Each Turbo Macro Works Under the Hood

### `auto` / `autopilot` — Full Autonomous Progression
```bash
efekta auto --json -c
```
- Completely offloads multiple-choice questions, pronunciation drills, passive reading cards, and avatar dialogues to the program.
- Automatically stops and prompts you with `agentHint` ONLY when a real human-knowledge exercise is encountered (`gaps`, `sort`, `pair`).

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
- Conducts the entire multi-turn AI avatar roleplay end to end.
- Detects options A/B/C, uses native Voice Engine v3 to synthesize clean English TTS, checks mic readiness without waiting for idle loops, clicks Next, repeats for every turn.
- Automatically clicks "Finish skipped tasks" if any turn was skipped so the step passes 100%!

### `gaps` — Automatic Drawer & Input Filler
```bash
efekta batch "gaps wait, better, time, lifestyle, yourself; next" --json -c
```
- Automatically handles both Selection-Gap Drawers and Text Inputs in exact order.
- Built-in post-fill verification ensures no option is left in `.deselected` state and guarantees Next unlocks before returning.

### `sort` — DOM-Shift-Immune Category Sorting
```bash
efekta batch "sort slot-1:item-1,item-3; sort slot-2:item-2,item-4; next" --json -c
```
- Snapshots item clean texts upfront before clicking, ensuring DOM removal across items never loses track of the remaining items.

### `essay` — Automatic 120+ Word Formal Essay / Email Writer
```bash
efekta batch "essay; next" --json -c
```
- Extracts task prompt and bullet points from stimulus.
- Auto-generates a fluent, high-register formal B2 English email/essay (120–135 words), satisfying all 75+, 80+, 100+, and 120-word requirements.
- Types it into the textarea, clicks Next, automatically answers the self-evaluation screen ("How did you find the task?"), and advances!

### `sequence` — Tap-Option Sentence & Dialogue Sequencer
```bash
efekta batch "sequence auto; next" --json -c
# Or pass target sentence directly:
efekta batch "sequence 'First time. Yeah, that\\'s right.'; next" --json -c
```
- Automatically resets any tokens already placed in the ordered list back to the pool.
- Clicks each token in exact target order and clicks Check to advance.

### `lesson` — Autonomous Lesson Selector & Navigator
```bash
efekta lesson next --json -c       # Automatically find & start next incomplete lesson
efekta lesson list --json -c       # View structured units, lessons & progress summary
efekta lesson U3L1 --json -c       # Jump directly to Unit 3 Lesson 1
efekta lesson TEST --json -c       # Jump directly to Final Progress Test
efekta lesson resume --json -c     # Continue current in-progress lesson
efekta lesson close --json -c      # Exit current lesson back to course overview
```
- Works from anywhere: course dashboard (`/gap/ui/self-study`), home page (`/gap/ui/home`), or inside an active lesson player (`/gap/ui/self-study/lesson-view`).
- When launching a lesson, automatically scrolls to the card, clicks it, waits for the lesson player to mount, and fast-forwards through overview/objectives (`autoNext(4)`) to land directly on Step 1!
