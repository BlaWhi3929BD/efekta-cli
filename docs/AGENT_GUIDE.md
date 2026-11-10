# Efekta AI Agent Turbo Guide (`learn.better.efekta.com`)

This guide is designed so that **any AI agent** (even lightweight or local models) can complete Efekta lessons and tests with maximum speed, zero token waste, and 100% accuracy.

---

## 0. The 5 Golden Rules of Efekta Automation

1. **LET THE PROGRAM DO THE WORK FIRST (`efekta auto`):**
   `efekta auto --json -c` autonomously glides through passive reading cards, auto-skips pronunciation drills, auto-solves multiple choice, conducts avatar dialogues, and writes essays. Only stop when human knowledge tasks (`gaps`, `sort`, `pair`) need your answer!
2. **ALWAYS end every interactive batch with `; next` (or `; auto`):**
   Appending `; next` clicks Next AND automatically fast-forwards through all consecutive reading cards, "Correct answers" reviews, self-evaluations, "Step passed!" summaries, and Lesson Overviews until the next interactive exercise!
3. **ALWAYS read `agentHint` first (use `--json -c` for 80% smaller output):**
   `agentHint` gives you `exerciseType`, `slots`, `items`, `options` (pre-populated even on selection_gaps!), and a ready-to-fill `actionTemplate`.
4. **SKIP MULTI-PHRASE PRONUNCIATION DRILLS IN 1 COMMAND (`efekta skip`):**
   Whenever a pronunciation drill appears in Stages 1–5, run `efekta skip --json -c` to skip all 5–7 phrases in 1 single shot and advance!
5. **PROGRESS TEST MANDATE ("Take the final test") — ZERO TRIAL-AND-ERROR:**
   - **TRIAL-AND-ERROR / BRUTE-FORCE (`solve choice`) IS STRICTLY FORBIDDEN ON FORMAL TESTS!**
   - On the Progress Test, every question is an unrepeatable formal assessment; incorrect choices directly degrade the certificate score below the mandatory 70% threshold.
   - The engine automatically detects Progress Tests (`exerciseType: "progress_test_choice"`) and actively blocks `solve choice` and `auto` to safeguard your exam score.
   - Always derive the correct answer using precise grammatical, syntactical, and context-specific linguistic analysis, then submit with `efekta batch "pick opt-X; next" --json -c`.

---

## 1. Instant Decision Table (`agentHint.exerciseType` -> 1 Command)

Always run commands with `--json -c`. Look ONLY at `data.agentHint` and `data.contextText`:

| `exerciseType` | What You See in `agentHint` | 1-Roundtrip CLI Command | MCP Tool Equivalent |
| :--- | :--- | :--- | :--- |
| `course_overview` / dashboard | On `/gap/ui/self-study` | `efekta lesson next --json -c` | `efekta_lesson(target="next")` |
| `passive_screen` / `lesson_overview` | `canProceed: true` or `stage-N` | `efekta next --json -c` *(or `efekta auto`)* | `efekta_autopilot()` |
| `multiple_choice` (Lesson) | `options: ["opt-1: ...", ...]` | `efekta batch "solve choice; next" --json -c` | `efekta_solve(strategy="choice")` |
| **`progress_test_choice` (Final Test)** | Graded single-shot exam question | `efekta batch "pick opt-X; next" --json -c` *(Analyze first!)* | `efekta_batch(commands="pick opt-X; next")` |
| `speaking_practice` | Pronunciation drill (Stages 1–5) | `efekta skip --json -c` | `efekta_solve(strategy="speak")` |
| `speaking_avatar` | Final avatar dialogue | `efekta batch "dialogue; next" --json -c` | `efekta_dialogue()` |
| `selection_gaps` | `[slot-N]` + drawer options | `efekta batch "gaps word1, word2; next" --json -c` | `efekta_batch(commands="gaps ...; next")` |
| `fill_in_the_blanks` | `[input-N]` text blanks | `efekta batch "gaps ans1, ans2; next" --json -c` | `efekta_batch(commands="gaps ...; next")` |
| `writing_essay` | 80–120+ word textarea | `efekta batch "essay; next" --json -c` | `efekta_essay(text="auto")` |
| `matching_pairs` | `slots` + `items` | `efekta batch "pair slot-1:item-2; next" --json -c` | `efekta_batch(commands="pair ...; next")` |
| `categorize_columns` | Category `slots` + `items` | `efekta batch "sort slot-1:item-1; next" --json -c` | `efekta_batch(commands="sort ...; next")` |
| `order_sentence` (tap sequence) | `ef-sequencing-tap-option-task` | `efekta batch "sequence auto; next" --json -c` | `efekta_sequence(tokens="auto")` |
| `order_sentence` (token picker) | Shuffled words in `items` | `efekta batch "pick item-3,item-1; next" --json -c` | `efekta_batch(commands="pick ...; next")` |
| `order_dialogue` | Dialogue turns (`cdk-drag`) | `efekta batch "drag item-2 item-1; next" --json -c` | `efekta_batch(commands="drag ...; next")` |

---

## 2. Autonomous Lesson Selection & Management

```bash
# Automatically find and open the first incomplete lesson
efekta lesson next --json -c

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
