---
name: efekta-automation
description: Ultra-fast 1-command-per-screen automation for learn.better.efekta.com using the efekta v3.0 Turbo Autonomous CLI and MCP server.
---

# Efekta Automation Skill (Turbo Autonomous Engine v3.0)

Use this skill whenever the user asks you to inspect, navigate, or complete lessons, units, or levels on `learn.better.efekta.com`.

## 5 Golden Rules for Maximum Speed & Accuracy

1. **Let the program do the work first (`efekta auto`):**
   `efekta auto --json -c` autonomously unlocks video cards (`video_stage` overlay Play click), scrolls reading cards/viewports, runs the **`> 50%` Step Activity Planner** (skipping to `Step summary` once `> 50%` pass, or speaking drills if needed), conducts avatar dialogues, submits essays, and solves all regular-lesson exercises (`multiple_choice`, `selection_gaps`, `categorize_columns` incl. distractors, `matching_pairs`, `order_dialogue`, `order_sentence`, and `Verb | Noun` tables). It stops only on Progress Tests (`progress_test_choice`), CAPTCHA (`human_verification_required`), or rare free-text blanks.
2. **Always end every manual exercise `batch` with `; next` (or `; auto`):**
   Clicks Next and fast-forwards through reading cards, `"Correct answers"` review screens, `"Step passed!"` celebrations, and Lesson Overviews. Supports cross-frame `efekta batch "lesson U2L1; auto" --json -c`, `wait 2s`/`1500ms`, and `eval`.
3. **Never call `status` or `wait` manually between exercises:**
   Every `batch`, `auto`, and `next` call automatically waits for UI locks and returns the new `PageState` (plus `steps` / `stoppedAt` on `auto`).
4. **Always pass `--json -c` (Compact Mode):**
   Strips the verbose `elements` coordinate dump (saving 80% tokens) while preserving `agentHint` (`exerciseType`, `actionTemplate`, `slots`, `items`, `options`, `inputs`, `activities`) and `contextText`.
5. **PROGRESS TEST MANDATE ("Take the final test") & ANTI-BOT GUARD:**
   - **TRIAL-AND-ERROR / BRUTE-FORCE (`solve *` / `auto`) ARE STRICTLY FORBIDDEN ON PROGRESS TESTS!**
   - The engine automatically detects Progress Tests (`exerciseType: "progress_test_choice"`) and blocks `auto` and all `solve *` solvers to safeguard your exam score. Analyze the question carefully and submit with `efekta batch "pick opt-X; next" --json -c`.
   - If `human_verification_required` (Cloudflare Turnstile / reCAPTCHA) appears, STOP immediately and ask the user to complete it in the browser.

---

## Instant Decision Matrix (`agentHint.exerciseType` -> 1 Command)

| `exerciseType` | What You See in `agentHint` | CLI Command | MCP Tool Equivalent |
| :--- | :--- | :--- | :--- |
| `course_overview` / dashboard | On `/gap/ui/self-study` | `efekta batch "lesson next; auto" --json -c` | `efekta_lesson(target: "next")` |
| `passive_screen` / `video_stage` / `lesson_overview` | `canProceed: true` or `stage-N` | `efekta auto --json -c` *(or `efekta next --json -c`)* | `efekta_autopilot()` |
| `multiple_choice` (Lesson) | `options: ["opt-1: ...", ...]` | `efekta batch "solve choice; next" --json -c` | `efekta_solve(strategy: "choice")` |
| **`progress_test_choice` (Final Test)** | Graded single-shot exam question | `efekta batch "pick opt-X; next" --json -c` *(Analyze carefully!)* | `efekta_batch(commands: "pick opt-X; next")` |
| `speaking_practice` | Pronunciation drill (Stages 1–5) | `efekta skip --json -c` | `efekta_solve(strategy: "speak")` |
| `speaking_avatar` | Final avatar dialogue | `efekta batch "dialogue; next" --json -c` | `efekta_dialogue()` |
| `selection_gaps` | `[slot-N]` + drawer options | `efekta batch "solve gaps; next" --json -c` *(or `gaps w1, w2; next`)* | `efekta_solve(strategy: "gaps")` |
| `fill_in_the_blanks` | `[input-N]` text blanks | `efekta batch "solve gaps; next" --json -c` *(or `gaps a1, a2; next`)* | `efekta_solve(strategy: "gaps")` |
| `writing_essay` | 80–120+ word textarea | `efekta batch "essay; next" --json -c` | `efekta_essay(text: "auto")` |
| `matching_pairs` | `slots` + `items` | `efekta batch "solve pair; next" --json -c` *(or `pair ...; next`)* | `efekta_solve(strategy: "pair")` |
| `categorize_columns` | Category `slots` + `items` | `efekta batch "solve sort; next" --json -c` *(or `sort ...; next`)* | `efekta_solve(strategy: "sort")` |
| `order_sentence` (tap sequence) | `ef-sequencing-tap-option-task` | `efekta batch "solve sentence; next" --json -c` *(or `sequence "<text>"; next`)* | `efekta_solve(strategy: "sentence")` |
| `order_sentence` (token picker) | Shuffled words in `items` | `efekta batch "pick item-3,item-1; next" --json -c` | `efekta_batch(commands: "pick ...; next")` |
| `order_dialogue` | Dialogue turns (`cdk-drag`) | `efekta batch "solve order; next" --json -c` *(or `drag item-2 item-1; next`)* | `efekta_solve(strategy: "order")` |
| `human_verification_required` | Cloudflare Turnstile / reCAPTCHA | **STOP & ask user** to verify manually in browser | — |

---

## Lesson Management & Autonomous Navigation

```bash
efekta lesson next --json -c               # Automatically find & start next incomplete lesson
efekta batch "lesson U2L1; auto" --json -c # Launch lesson and immediately run autopilot
efekta lesson list --json -c               # View structured units, lessons & progress summary
efekta lesson U3L1 --json -c               # Jump directly to Unit 3 Lesson 1
efekta lesson TEST --json -c               # Jump directly to Final Progress Test
efekta lesson resume --json -c             # Continue current in-progress lesson
efekta lesson close --json -c              # Exit current lesson back to course overview
```
