# Efekta AI Agent Turbo Guide (`learn.better.efekta.com`)

This guide is designed so that **any AI agent** (even lightweight or local models) can complete Efekta lessons and tests with maximum speed, zero token waste, and 100% accuracy.

---

## 0. The 5 Golden Rules of Efekta Automation

1. **LET THE PROGRAM DO THE WORK FIRST (`efekta auto`):**
   `efekta auto --json -c` autonomously unlocks video cards (`video_stage` overlay Play click), scrolls reading cards/viewports, runs the **`> 50%` Step Activity Planner** (jumping straight to `Step summary` once `> 50%` activities pass, or speaking drills when needed), conducts avatar dialogues, submits essays, and solves all regular-lesson exercises (`multiple_choice`, `selection_gaps`, `categorize_columns` incl. distractors, `matching_pairs`, `order_dialogue`, `order_sentence`, and `Verb | Noun` tables).
   It only stops on Progress Tests (`progress_test_choice`), CAPTCHA (`human_verification_required`), or rare free-text blanks.
2. **ALWAYS end every interactive batch with `; next` (or `; auto`):**
   Appending `; next` clicks Next AND automatically fast-forwards through reading cards, "Correct answers" reviews, self-evaluations, "Step passed!" summaries, and Lesson Overviews until the next interactive exercise! Supports cross-frame `efekta batch "lesson U2L1; auto" --json -c`, `wait 2s`/`1500ms`, and `eval`.
3. **ALWAYS read `agentHint` first (use `--json -c` for 80% smaller output):**
   `agentHint` gives you `exerciseType`, `slots`, `items`, `options` (pre-populated even on `selection_gaps`!), `activities`, and a ready-to-fill `actionTemplate`, plus `steps` / `stoppedAt` / `needsAgent` on `auto`.
4. **SKIP MULTI-PHRASE PRONUNCIATION DRILLS IN 1 COMMAND (`efekta skip`):**
   Whenever a pronunciation drill appears in Stages 1–5, run `efekta skip --json -c` to skip all 5–7 phrases in 1 single shot and advance.
5. **PROGRESS TEST MANDATE ("Take the final test") & ANTI-BOT GUARD — ZERO TRIAL-AND-ERROR:**
   - **TRIAL-AND-ERROR / BRUTE-FORCE (`solve *` / `auto`) ARE STRICTLY FORBIDDEN ON FORMAL TESTS!**
   - On the Progress Test, every question is an unrepeatable formal assessment; incorrect choices directly degrade the certificate score below the mandatory 70% threshold.
   - The engine automatically detects Progress Tests (`exerciseType: "progress_test_choice"`) and actively blocks `auto` and all `solve *` strategies to safeguard your exam score.
   - Always derive the correct answer using precise grammatical, syntactical, and context-specific linguistic analysis, then submit with `efekta batch "pick opt-X; next" --json -c`.
   - If `human_verification_required` (Cloudflare Turnstile / reCAPTCHA) is returned, STOP immediately and ask the user to verify manually in the browser.

---

## 1. Instant Decision Table (`agentHint.exerciseType` -> 1 Command)

Always run commands with `--json -c`. Look ONLY at `data.agentHint` and `data.contextText`:

| `exerciseType` | What You See in `agentHint` | 1-Roundtrip CLI Command | MCP Tool Equivalent |
| :--- | :--- | :--- | :--- |
| `course_overview` / dashboard | On `/gap/ui/self-study` | `efekta batch "lesson next; auto" --json -c` | `efekta_lesson(target="next")` |
| `passive_screen` / `video_stage` / `lesson_overview` | `canProceed: true` or `stage-N` | `efekta auto --json -c` *(or `efekta next --json -c`)* | `efekta_autopilot()` |
| `multiple_choice` (Lesson) | `options: ["opt-1: ...", ...]` | `efekta batch "solve choice; next" --json -c` | `efekta_solve(strategy="choice")` |
| **`progress_test_choice` (Final Test)** | Graded single-shot exam question | `efekta batch "pick opt-X; next" --json -c` *(Analyze first!)* | `efekta_batch(commands="pick opt-X; next")` |
| `speaking_practice` | Pronunciation drill (Stages 1–5) | `efekta skip --json -c` | `efekta_solve(strategy="speak")` |
| `speaking_avatar` | Final avatar dialogue | `efekta batch "dialogue; next" --json -c` | `efekta_dialogue()` |
| `selection_gaps` | `[slot-N]` + drawer options | `efekta batch "solve gaps; next" --json -c` *(or `gaps w1, w2; next`)* | `efekta_solve(strategy="gaps")` |
| `fill_in_the_blanks` | `[input-N]` text blanks | `efekta batch "solve gaps; next" --json -c` *(or `gaps a1, a2; next`)* | `efekta_solve(strategy="gaps")` |
| `writing_essay` | 80–120+ word textarea | `efekta batch "essay; next" --json -c` | `efekta_essay(text="auto")` |
| `matching_pairs` | `slots` + `items` | `efekta batch "solve pair; next" --json -c` *(or `pair slot-1:item-2; next`)* | `efekta_solve(strategy="pair")` |
| `categorize_columns` | Category `slots` + `items` | `efekta batch "solve sort; next" --json -c` *(or `sort slot-1:item-1; next`)* | `efekta_solve(strategy="sort")` |
| `order_sentence` (tap sequence) | `ef-sequencing-tap-option-task` | `efekta batch "solve sentence; next" --json -c` *(or `sequence "<text>"; next`)* | `efekta_solve(strategy="sentence")` |
| `order_sentence` (token picker) | Shuffled words in `items` | `efekta batch "pick item-3,item-1; next" --json -c` | `efekta_batch(commands="pick ...; next")` |
| `order_dialogue` | Dialogue turns (`cdk-drag`) | `efekta batch "solve order; next" --json -c` *(or `drag item-2 item-1; next`)* | `efekta_solve(strategy="order")` |
| `human_verification_required` | Cloudflare Turnstile / reCAPTCHA | **STOP & ask user** to verify manually in browser | — |

---

## 2. Autonomous Lesson Selection & Management

```bash
# Automatically find and open the first incomplete lesson
efekta lesson next --json -c

# Launch a lesson AND immediately start autopilot across frames
efekta batch "lesson U2L1; auto" --json -c

# View all units, lessons, completion status & next lesson recommendation
efekta lesson list --json -c

# Jump directly to a specific unit & lesson
efekta lesson U3L2 --json -c

# Jump directly to the final progress test
efekta lesson TEST --json -c

# Resume active lesson player
efekta lesson resume --json -c

# Exit active lesson player back to self-study dashboard
efekta lesson close --json -c
```

---

## 3. Built-in Regular-Lesson Solvers & Step Planner

- **`efekta solve <strategy>`** supports `auto | choice | gaps | sort | pair | order | sentence | speak` (all brute-force strategies are strictly disabled when `isProgressTest` is true).
- **Step-Level Activity Planner:** In regular multi-activity steps, `auto` tracks `act-1..act-N` completion percentages. Once `>= floor(N / 2) + 1` (`> 50%`) activities are `100%`, it skips directly to `Step summary`; if `"Step not passed"` occurs, it jumps directly to incomplete activities.
