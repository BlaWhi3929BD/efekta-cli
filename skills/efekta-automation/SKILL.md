---
name: efekta-automation
description: Ultra-fast 1-command-per-screen automation for learn.better.efekta.com using the efekta v2.2 Turbo CLI and MCP server.
---

# Efekta Automation Skill (Turbo Engine v2.2)

Use this skill whenever the user asks you to complete lessons, units, or levels on `learn.better.efekta.com`.

## 4 Golden Rules for Maximum Speed
1. **Never call `status` or `wait` manually after an action:** Every `batch` and `next` call automatically waits for UI locks and returns the new `PageState` (with `agentHint`).
2. **Always end every exercise `batch` with `; next`:** Automatically clicks Next and fast-forwards through all reading cards, `"Correct answers"` review screens, `"Step passed!"` celebrations, and Lesson Overviews until the next interactive exercise.
3. **Always pass `--json -c`:** Compact mode removes the verbose `elements` coordinate list (saving 80% tokens) while preserving `agentHint` (`exerciseType`, `actionTemplate`, `slots`, `items`, `options`, `inputs`) and `contextText`.
4. **Never record audio in Stages 1–5:** If `skip-1` is present, run `efekta batch "click skip-1; next" --json -c`.

## Instant Decision Matrix (`agentHint.exerciseType` -> 1 Command)

- **`passive_screen` / `lesson_overview`**:
  ```bash
  efekta next --json -c
  ```
- **`matching_pairs`**:
  ```bash
  efekta batch "pair slot-1:item-3, slot-2:item-1, slot-3:item-2; next" --json -c
  ```
- **`categorize_columns`**:
  ```bash
  efekta batch "sort slot-1:item-1,item-4; sort slot-2:item-2,item-3; next" --json -c
  ```
- **`selection_gaps` / `fill_in_the_blanks`**:
  ```bash
  efekta batch "gaps word1, word2, word3, word4; next" --json -c
  ```
- **`multiple_choice`**:
  ```bash
  efekta batch "pick opt-1,opt-3; next" --json -c
  ```
- **`order_sentence`**:
  ```bash
  efekta batch "pick item-3,item-1,item-4,item-2; next" --json -c
  ```
- **`speaking_practice`**:
  ```bash
  efekta batch "speak all; next" --json -c
  ```
- **`speaking_avatar` (mandatory final stage)**:
  - If tap options are visible:
    ```bash
    efekta batch "pick opt-2; next" --json -c
    ```
  - If speech mode:
    ```bash
    efekta batch "speak opt-2; next" --json -c
    # or by letter:
    efekta batch "speak B; next" --json -c
    ```
  *(Always choose from the options listed in `agentHint.options`).*
