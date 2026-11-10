---
name: efekta-automation
description: Ultra-fast 1-command-per-screen automation for learn.better.efekta.com using the efekta v3.0 Turbo Autonomous CLI and MCP server.
---

# Efekta Automation Skill (Turbo Autonomous Engine v3.0)

Use this skill whenever the user asks you to complete lessons, units, or levels on `learn.better.efekta.com`.

## 4 Golden Rules for Maximum Speed
1. **Let the program do the work first (`efekta auto`):** `efekta auto --json -c` autonomously solves multiple-choice questions, auto-skips pronunciation drills, navigates passive reading cards, and conducts avatar dialogues. Only stops when a knowledge exercise (`gaps`, `sort`, `pair`, essay) needs your answer!
2. **Never call `status` or `wait` manually between exercises:** Every `batch`, `auto`, and `next` call automatically waits for UI locks and returns the new `PageState` (with `agentHint`).
3. **Always end every exercise `batch` with `; next` (or `; auto`):** Automatically clicks Next and fast-forwards through all reading cards, `"Correct answers"` review screens, `"Step passed!"` celebrations, and Lesson Overviews until the next interactive exercise.
4. **Always pass `--json -c`:** Compact mode removes the verbose `elements` coordinate list (saving 80% tokens) while preserving `agentHint` (`exerciseType`, `actionTemplate`, `slots`, `items`, `options`, `inputs`) and `contextText`.

## Instant Decision Matrix (`agentHint.exerciseType` -> 1 Command)

- **`passive_screen` / `lesson_overview`**:
  ```bash
  efekta next --json -c
  # or autonomous mode:
  efekta auto --json -c
  ```
- **`multiple_choice` (single or multi-select)**:
  ```bash
  efekta batch "solve choice; next" --json -c
  ```
- **`speaking_practice` (pronunciation drill in Stages 1–5)**:
  ```bash
  efekta skip --json -c
  ```
- **`speaking_avatar` (mandatory final stage)**:
  ```bash
  efekta batch "dialogue; next" --json -c
  ```
- **`selection_gaps` / `fill_in_the_blanks` (short blanks)**:
  ```bash
  efekta batch "gaps word1, word2, word3, word4; next" --json -c
  ```
- **`fill_in_the_blanks` (75+ word writing essay)**:
  ```bash
  efekta batch "type input-1 '<100+ word essay>'; next" --json -c
  ```
- **`matching_pairs`**:
  ```bash
  efekta batch "pair slot-1:item-3, slot-2:item-1, slot-3:item-2; next" --json -c
  ```
- **`categorize_columns`**:
  ```bash
  efekta batch "sort slot-1:item-1,item-4; sort slot-2:item-2,item-3; next" --json -c
  ```
- **`order_sentence`**:
  ```bash
  efekta batch "pick item-3,item-1,item-4,item-2; next" --json -c
  ```
- **`order_dialogue`**:
  ```bash
  efekta batch "drag item-2 item-1; next" --json -c
  ```
  *(Always choose from the options listed in `agentHint.options`).*
