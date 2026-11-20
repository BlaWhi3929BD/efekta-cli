# CLAUDE.md — Efekta Turbo Playbook for Claude Code

Use `efekta` v3.0 (Turbo Autonomous Engine) to complete English lessons on `learn.better.efekta.com` in **1 command per interactive screen**.

## 5 Golden Rules
1. **Let the program do the work first (`efekta auto`):** `efekta auto --json -c` autonomously handles passive cards, skips pronunciation drills, solves regular multiple-choice questions, writes essays, and conducts avatar dialogues. It stops when a knowledge task (`gaps`, `sort`, `pair`, `order_dialogue`) or a Progress Test needs your answer.
2. **ALWAYS end exercise batches with `; next` (or `; auto`):** Fast-forwards through all consecutive reading cards, `"Correct answers"` review screens, self-evaluations, `"Step passed!"` summaries, and Lesson Overviews in a single roundtrip.
3. **ALWAYS pass `--json -c` (Compact Mode):** Strips the verbose `elements` coordinate array (saving 80% tokens) and highlights `data.agentHint` (`exerciseType`, `actionTemplate`, `slots`, `items`, `options`, `inputs`).
4. **Skip multi-phrase pronunciation drills in 1 command:** Run `efekta skip --json -c` to skip all phrases in a pronunciation drill and advance.
5. **PROGRESS TEST MANDATE ("Take the final test") — ZERO TRIAL-AND-ERROR:**
   - **NEVER use `solve choice` or brute-force on formal Progress Tests.** Every exam question is single-shot and counts toward the 70% certificate threshold.
   - The engine automatically detects Progress Tests (`exerciseType: "progress_test_choice"`) and blocks `solve choice` and `auto`. Always analyze the question grammatically and submit safely with `efekta batch "pick opt-X; next" --json -c`.

## 1-Look Decision Table

| `agentHint.exerciseType` | Command to Run Immediately |
| :--- | :--- |
| `course_overview` / dashboard | `efekta lesson next --json -c` |
| `passive_screen` / `lesson_overview` | `efekta next --json -c` *(or `efekta auto --json -c`)* |
| `multiple_choice` (regular lesson) | `efekta batch "solve choice; next" --json -c` *(or `pick opt-X; next`)* |
| **`progress_test_choice` (Final Test)** | `efekta batch "pick opt-X; next" --json -c` *(Analyze carefully first!)* |
| `matching_pairs` | `efekta batch "pair slot-1:item-3, slot-2:item-1, slot-3:item-2; next" --json -c` |
| `categorize_columns` | `efekta batch "sort slot-1:item-1,item-4; sort slot-2:item-2,item-3; next" --json -c` |
| `selection_gaps` / `fill_in_the_blanks` | `efekta batch "gaps word1, word2, word3, word4; next" --json -c` |
| `writing_essay` | `efekta batch "essay; next" --json -c` |
| `order_sentence` (tap sequence) | `efekta batch "sequence auto; next" --json -c` |
| `order_sentence` (token picker) | `efekta batch "pick item-3,item-1,item-4,item-2; next" --json -c` |
| `order_dialogue` | `efekta batch "drag item-2 item-1; next" --json -c` |
| `speaking_practice` | `efekta skip --json -c` |
| `speaking_avatar` (final stage) | `efekta batch "dialogue; next" --json -c` |

## Build & Verify
```bash
make test
make build
```
