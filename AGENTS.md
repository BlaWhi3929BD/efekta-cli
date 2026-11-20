# AGENTS.md — Efekta Turbo Playbook (Autonomous Protocol)

This repository provides **`efekta` v3.0 (Turbo Autonomous Engine)**, an ultra-fast CLI & MCP server for AI agents to inspect and complete English lessons on `learn.better.efekta.com`.

---

## 0. The 5 Golden Laws of Speed & Precision (Memorize These!)

1. **LET THE PROGRAM DO THE WORK FIRST (`efekta auto`):**
   `efekta auto --json -c` autonomously unlocks video cards (`video_stage` overlay Play click), scrolls reading panels/viewports, runs the **`> 50%` Step Activity Planner** (skipping straight to `Step summary` once `> 50%` of activities are `100%`, or completing/speaking drills if needed), conducts avatar dialogues, submits essays, and solves ALL regular-lesson exercises (`multiple_choice`, `selection_gaps`, `categorize_columns` incl. distractors, `matching_pairs`, `order_dialogue`, `order_sentence`, and `Verb | Noun` tables).
   It stops only on **Progress Tests** (`progress_test_choice`), CAPTCHA (`human_verification_required`), or rare non-table free-text blanks.
2. **ALWAYS end every manual exercise `batch` with `; next` (or `; auto`):**
   Appending `; next` clicks Next AND automatically fast-forwards through all consecutive passive screens (reading cards, "Correct answers" reviews, "Step passed!" summaries, Lesson Overviews) until the next interactive exercise! And you can chain across frames with `efekta batch "lesson U2L1; auto" --json -c`.
3. **ALWAYS pass `--json -c` (Compact Mode) and read `agentHint` FIRST:**
   `--json -c` strips raw coordinate dumps (saving **80% tokens**) while providing:
   - `exerciseType` (with `steps`, `stoppedAt`, and `needsAgent` returned directly by `auto`!)
   - `actionTemplate` (ready-to-fill command!)
   - `slots`, `items`, `options`, `inputs`, `activities` (clean, deduplicated `id: text` lists)
4. **SKIP MULTI-PHRASE PRONUNCIATION DRILLS IN 1 COMMAND:**
   Whenever an optional pronunciation drill appears in Stages 1–5, run:
   ```bash
   efekta skip --json -c
   ```
   This automatically skips ALL 5–7 phrases in the drill in 1 single shot and advances (note: `efekta auto` only speaks drills instead of skipping when `> 50%` step pass threshold requires it, or when `speak` flag is passed)!
5. **PROGRESS TEST MANDATE ("Take the final test") & ANTI-BOT GUARD — ZERO TRIAL-AND-ERROR:**
   - **TRIAL-AND-ERROR / BRUTE-FORCE (`solve *` / `auto`) ARE STRICTLY FORBIDDEN ON THE FINAL TEST!**
   - Regular lessons permit retry heuristics. On the Progress Test, every question is an unrepeatable formal assessment; incorrect choices directly degrade the final certificate score below the mandatory 70% threshold.
   - The engine automatically detects Progress Tests, tags them as `exerciseType: "progress_test_choice"`, and actively blocks `auto` and all `solve *` strategies to safeguard your exam score.
   - Always derive the correct answer using precise grammatical, syntactical, and context-specific linguistic analysis, then submit with `efekta batch "pick opt-X; next" --json -c`.
   - If `human_verification_required` (Cloudflare Turnstile / reCAPTCHA) appears, STOP immediately and ask the user to complete verification in the browser.

---

## 1. Instant Decision Matrix (See `exerciseType` -> Run 1 Command)

Look at `data.agentHint.exerciseType` from your last response and immediately run the matching **single command**:

| `exerciseType` | What You See in `agentHint` | Single Command to Execute | MCP Tool |
| :--- | :--- | :--- | :--- |
| `course_overview` / `unknown` (dashboard) | On course page (`/gap/ui/self-study`) | `efekta batch "lesson next; auto" --json -c` | `efekta_lesson(target: "next")` |
| `passive_screen` / `video_stage` / `lesson_overview` | `canProceed: true` or `stage-1..stage-N` | `efekta auto --json -c` *(or `efekta next --json -c`)* | `efekta_autopilot()` / `efekta_next()` |
| `multiple_choice` (Lesson) | `options: ["opt-1: ...", "opt-2: ..."]` | `efekta batch "solve choice; next" --json -c` | `efekta_solve(strategy: "choice")` |
| **`progress_test_choice` (Final Test)** | Graded single-shot exam question | `efekta batch "pick opt-X; next" --json -c` *(Analyze first!)* | `efekta_batch(commands: "pick opt-X; next")` |
| `matching_pairs` | `slots` + `items` (or card grid) | `efekta batch "solve pair; next" --json -c` *(or `pair ...; next`)* | `efekta_solve(strategy: "pair")` |
| `categorize_columns` | 2 category `slots` + N `items` (incl. distractors) | `efekta batch "solve sort; next" --json -c` *(or `sort ...; next`)* | `efekta_solve(strategy: "sort")` |
| `selection_gaps` | `contextText` has `[slot-1]` + drawer | `efekta batch "solve gaps; next" --json -c` *(or `gaps w1, w2; next`)* | `efekta_solve(strategy: "gaps")` |
| `fill_in_the_blanks` (table / short blanks) | `contextText` has `[input-1]` text blanks | `efekta batch "solve gaps; next" --json -c` *(or `gaps ans1, ans2; next`)* | `efekta_solve(strategy: "gaps")` |
| `writing_essay` (75–120+ words) | `textarea` asking for writing | `efekta batch "essay; next" --json -c` *(or `efekta essay --json -c`)* | `efekta_essay(text: "auto")` |
| `order_sentence` (tap sequence) | `ef-sequencing-tap-option-task` tokens | `efekta batch "solve sentence; next" --json -c` *(or `sequence "<text>"; next`)* | `efekta_solve(strategy: "sentence")` |
| `order_sentence` (token picker) | `items` are shuffled sentence words | `efekta batch "pick item-3,item-1,item-4,item-2; next" --json -c` | `efekta_batch(commands: "pick ...; next")` |
| `order_dialogue` | `items` are dialogue turns (`cdk-drag`) | `efekta batch "solve order; next" --json -c` *(or `drag item-2 item-1; next`)* | `efekta_solve(strategy: "order")` |
| `speaking_practice` | Pronunciation drill with target phrase | `efekta skip --json -c` *(or `efekta batch "speak all; next" --json -c`)* | `efekta_solve(strategy: "speak")` |
| `speaking_avatar` (mandatory final) | AI video avatar roleplay (turns A/B/C) | `efekta batch "dialogue; next" --json -c` | `efekta_dialogue()` |
| `human_verification_required` | Cloudflare Turnstile / reCAPTCHA | **STOP & ask user** to verify manually in browser | — |

---

## 2. How Each Turbo Macro Works Under the Hood

### `auto` / `autopilot` — Full Autonomous Progression & Step Planner
```bash
efekta auto --json -c
efekta auto 60 speak --json -c     # Custom step budget & speak drills instead of skipping
```
- Autonomously solves regular-lesson exercises: `multiple_choice`, `selection_gaps`, `categorize_columns` (skips distractors without locking), `matching_pairs` (waits cleanly through `.disabled` cooldowns), `order_dialogue`, `order_sentence` (`ef-sequencing-tap-option-task` prefix locking), `fill_in_the_blanks` (2-col and 4-col word-family tables), `writing_essay`, and `speaking_avatar`.
- **Smart `> 50%` Step Activity Planner:** parses `act-1..act-N` progress pills. Once `>= floor(total / 2) + 1` activities reach `100%` on a multi-activity regular step, jumps directly to `Step summary` before running slower solvers; if `"Step not passed"` appears or `0%` activities are needed for the threshold, jumps back or speaks the drill automatically.
- Unlocks `video_stage` immediately via Angular's overlay Play button, scrolls scrollable panels + iframe viewports (`IntersectionObserver` reading cards), and advances past unlocked `"Step passed!"` summaries even at the end of a time budget.
- Returns `steps`, `stoppedAt`, and `needsAgent` directly in JSON. Stops cleanly on Progress Tests and `human_verification_required`.

### `next` / `ff` — Auto-Fast-Forward
```bash
efekta next --json -c
```
- Clicks `next-1` (or the first incomplete `stage-N` on Lesson Overview), handles overlay Play clicks on `video_stage` + viewport/container scrolls on reading cards, and **loops up to 9 times** through passive cards, `"Correct answers"` reviews, self-evaluation prompts, `"Step passed!"` summaries, and Lesson Overviews.
- Stops the instant an interactive exercise appears and returns its `agentHint` + `autoReadNotes`.

### `skip` — 1-Shot Speaking Drill Skipper
```bash
efekta skip --json -c
```
- Loops through all 5–7 phrases of a pronunciation drill in Stage 1–5, clicks `Skip` on each phrase, and automatically fast-forwards directly to the next interactive exercise!

### `solve <strategy>` — Autonomous Regular-Lesson Solvers (Blocked on Progress Test)
```bash
efekta solve auto --json -c        # Detect current exerciseType and solve it
efekta batch "solve choice; next" --json -c
efekta batch "solve gaps; next" --json -c
efekta batch "solve sort; next" --json -c
efekta batch "solve pair; next" --json -c
efekta batch "solve order; next" --json -c
efekta batch "solve sentence; next" --json -c
```
- Supported strategies: `auto | choice | gaps | sort | pair | order | sentence | speak`.
- `solve choice` tests options with instant `.incorrect` abort & multi-select combo handling; `solve sentence` solves `ef-sequencing-tap-option-task` left-to-right via Catalyst prefix locking after `Check`; `solve sort` marks unplaceable distractor items as exhausted instead of looping; `solve pair` ignores transient `.disabled` wrong-card cooldowns.

### `dialogue` / `avatar` — Hybrid Avatar Dialogue Solver
```bash
efekta batch "dialogue; next" --json -c
```
- Conducts the entire multi-turn AI avatar roleplay end to end, tracks already-tried phrases per turn, handles Firefox autoplay/mute recovery, clicks `"Finish skipped tasks"` if needed, and speaks cleanly via Voice Engine v3 without touching your real microphone.

### `gaps` — Automatic Drawer & Input Filler
```bash
efekta batch "gaps wait, better, time, lifestyle, yourself; next" --json -c
```
- Automatically handles both Selection-Gap Drawers and Text Inputs (including `button.typing-status` tables) in exact order, with post-fill fallback to `solveSelectionGaps()` if needed.

### `sort` — DOM-Shift-Immune Category Sorting
```bash
efekta batch "sort slot-1:item-1,item-3; sort slot-2:item-2,item-4; next" --json -c
```
- Snapshots item clean texts upfront before clicking, ensuring DOM removal across items never loses track of the remaining items.

### `essay` — Automatic 120+ Word Formal Essay / Email Writer
```bash
efekta batch "essay; next" --json -c
```
- Extracts task prompt and bullet points from stimulus, generates a 120–135 word formal B2 email/essay, submits it, and auto-completes self-evaluation.

### `sequence` — Tap-Option Sentence & Dialogue Sequencer
```bash
efekta batch "sequence auto; next" --json -c
# Or pass target sentence directly:
efekta batch "sequence 'First time. Yeah, that\\'s right.'; next" --json -c
```
- Resets unlocked tokens already placed in the ordered list back to the pool, clicks each token in target order, clicks `Check`, and polls until Next unlocks or mismatched tokens pop back cleanly.

### `wait` & `eval` in `batch`
```bash
efekta batch "wait 2s; eval button.item; next" --json -c
```
- `wait` accepts numeric milliseconds (`400`), unit suffixes (`2s`, `1500ms`), or conditions (`video-end`, `next`, `unlocked`).
- `eval` works both standalone and inside `batch`.

### `lesson` — Autonomous Lesson Selector & Navigator
```bash
efekta lesson next --json -c       # Automatically find & start next incomplete lesson
efekta batch "lesson U2L1; auto" --json -c  # Cross-frame launch + immediate autopilot
efekta lesson list --json -c       # View structured units, lessons & progress summary
efekta lesson U3L1 --json -c       # Jump directly to Unit 3 Lesson 1
efekta lesson TEST --json -c       # Jump directly to Final Progress Test
efekta lesson resume --json -c     # Continue current in-progress lesson
efekta lesson close --json -c      # Exit current lesson back to course overview
```
- Works from anywhere: course dashboard (`/gap/ui/self-study`), home page (`/gap/ui/home`), or inside an active lesson player (`/gap/ui/self-study/lesson-view`).
- When launching a lesson inside a `batch` (`lesson U2L1; auto`), `background.js` runs `lesson` in top frame 0, waits for the `study.better.efekta.com` iframe to mount (`elementsCount > 0`), and routes subsequent batch commands directly into the lesson player frame.
