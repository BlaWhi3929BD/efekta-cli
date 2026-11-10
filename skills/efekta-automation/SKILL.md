---
name: efekta-automation
description: Ultra-fast 1-command-per-screen automation for learn.better.efekta.com using the efekta v3.0 Turbo Autonomous CLI and MCP server.
---

# Efekta Automation Skill (Turbo Autonomous Engine v3.0)

Use this skill whenever the user asks you to inspect, navigate, or complete lessons, units, or levels on `learn.better.efekta.com`.

## 5 Golden Rules for Maximum Speed & Accuracy

1. **Let the program do the work first (`efekta auto`):**
   `efekta auto --json -c` autonomously solves multiple-choice questions, auto-skips pronunciation drills, navigates passive reading cards, conducts avatar dialogues, and auto-submits essays. It only stops when a knowledge exercise (`gaps`, `sort`, `pair`) needs your answer!
2. **Always end every exercise `batch` with `; next` (or `; auto`):**
   Automatically clicks Next and fast-forwards through all reading cards, `"Correct answers"` review screens, `"Step passed!"` celebrations, and Lesson Overviews until the next interactive exercise.
3. **Never call `status` or `wait` manually between exercises:**
   Every `batch`, `auto`, and `next` call automatically waits for UI locks and returns the new `PageState` (with `agentHint`).
4. **Always pass `--json -c` (Compact Mode):**
   Strips the verbose `elements` coordinate dump (saving 80% tokens) while preserving `agentHint` (`exerciseType`, `actionTemplate`, `slots`, `items`, `options`, `inputs`) and `contextText`.
5. **PROGRESS TEST MANDATE ("Take the final test") — ZERO TRIAL-AND-ERROR:**
   - **TRIAL-AND-ERROR / BRUTE-FORCE (`solve choice`) IS STRICTLY FORBIDDEN!**
   - On regular lessons, testing options is fine. On the Progress Test, every question is a single-shot exam. Incorrect attempts immediately lower the final score below the mandatory 70% certificate threshold.
   - The engine automatically detects Progress Tests, tags them as `exerciseType: "progress_test_choice"`, and actively blocks `solve choice` and `auto` to safeguard your exam score.
   - Always read the question, analyze grammatical cues and semantic context, pick the exact answer with `efekta batch "pick opt-X; next" --json -c`, and verify before proceeding.

---

## Instant Decision Matrix (`agentHint.exerciseType` -> 1 Command)

| `exerciseType` | What You See in `agentHint` | CLI Command | MCP Tool Equivalent |
| :--- | :--- | :--- | :--- |
| `course_overview` / dashboard | On `/gap/ui/self-study` | `efekta lesson next --json -c` | `efekta_lesson(target: "next")` |
| `passive_screen` / `lesson_overview` | `canProceed: true` or `stage-N` | `efekta auto --json -c` *(or `efekta next`)* | `efekta_autopilot()` |
| `multiple_choice` (Lesson) | `options: ["opt-1: ...", ...]` | `efekta batch "solve choice; next" --json -c` | `efekta_solve(strategy: "choice")` |
| **`progress_test_choice` (Final Test)** | Graded single-shot exam question | `efekta batch "pick opt-X; next" --json -c` *(Analyze carefully!)* | `efekta_batch(commands: "pick opt-X; next")` |
| `speaking_practice` | Pronunciation drill (Stages 1–5) | `efekta skip --json -c` | `efekta_solve(strategy: "speak")` |
| `speaking_avatar` | Final avatar dialogue | `efekta batch "dialogue; next" --json -c` | `efekta_dialogue()` |
| `selection_gaps` | `[slot-N]` + drawer options | `efekta batch "gaps word1, word2; next" --json -c` | `efekta_batch(commands: "gaps w1, w2; next")` |
| `fill_in_the_blanks` | `[input-N]` text blanks | `efekta batch "gaps ans1, ans2; next" --json -c` | `efekta_batch(commands: "gaps a1, a2; next")` |
| `writing_essay` | 80–120+ word textarea | `efekta batch "essay; next" --json -c` | `efekta_essay(text: "auto")` |
| `matching_pairs` | `slots` + `items` | `efekta batch "pair slot-1:item-2; next" --json -c` | `efekta_batch(commands: "pair ...; next")` |
| `categorize_columns` | Category `slots` + `items` | `efekta batch "sort slot-1:item-1; next" --json -c` | `efekta_batch(commands: "sort ...; next")` |
| `order_sentence` (tap sequence) | `ef-sequencing-tap-option-task` | `efekta batch "sequence auto; next" --json -c` | `efekta_sequence(tokens: "auto")` |
| `order_sentence` (token picker) | Shuffled words in `items` | `efekta batch "pick item-3,item-1; next" --json -c` | `efekta_batch(commands: "pick ...; next")` |
| `order_dialogue` | Dialogue turns (`cdk-drag`) | `efekta batch "drag item-2 item-1; next" --json -c` | `efekta_batch(commands: "drag ...; next")` |

---

## Lesson Management & Autonomous Navigation

```bash
efekta lesson next --json -c       # Automatically find & start next incomplete lesson
efekta lesson list --json -c       # View structured units, lessons & progress summary
efekta lesson U3L1 --json -c       # Jump directly to Unit 3 Lesson 1
efekta lesson TEST --json -c       # Jump directly to Final Progress Test
efekta lesson resume --json -c     # Continue current in-progress lesson
efekta lesson close --json -c      # Exit current lesson back to course overview
```
