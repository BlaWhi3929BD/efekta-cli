# CLAUDE.md — Efekta Turbo Playbook for Claude Code

Use `efekta` v2.2 (Turbo Engine) to complete English lessons on `learn.better.efekta.com` in **1 command per interactive screen**.

## 4 Golden Rules
1. **NEVER call `wait` or `status` manually after an action:** Every `batch`, `next`, `pick`, `pair`, `sort`, and `gaps` command auto-waits for UI locks and returns the updated state (`data.agentHint`).
2. **ALWAYS end exercise batches with `; next`:** Fast-forwards through all consecutive reading cards, `"Correct answers"` review screens, `"Step passed!"` summaries, and Lesson Overviews in a single roundtrip!
3. **ALWAYS pass `--json -c` (Compact Mode):** Strips the verbose `elements` coordinate array (saving 80% tokens) and highlights `data.agentHint` (`exerciseType`, `actionTemplate`, `slots`, `items`, `options`, `inputs`).
4. **Skip optional speaking tasks:** When `skip-1` is present, run `efekta batch "click skip-1; next" --json -c`.

## 1-Look Decision Table

| `agentHint.exerciseType` | Command to Run Immediately |
| :--- | :--- |
| `passive_screen` / `lesson_overview` | `efekta next --json -c` |
| `multiple_choice` (1 answer) | `efekta batch "pick opt-2; next" --json -c` |
| `multiple_choice` (multi-select) | `efekta batch "pick opt-1,opt-3,opt-5; next" --json -c` |
| `matching_pairs` | `efekta batch "pair slot-1:item-3, slot-2:item-1, slot-3:item-2; next" --json -c` |
| `categorize_columns` | `efekta batch "sort slot-1:item-1,item-4; sort slot-2:item-2,item-3; next" --json -c` |
| `selection_gaps` / `fill_in_the_blanks` | `efekta batch "gaps word1, word2, word3, word4; next" --json -c` |
| `order_sentence` | `efekta batch "pick item-3,item-1,item-4,item-2; next" --json -c` |
| `speaking_avatar` (with `skip-1`) | `efekta batch "click skip-1; next" --json -c` |
| `speaking_avatar` (final stage) | `efekta batch "wait video-end; solve speak" --json -c` -> then `efekta batch "pick opt-1; next" --json -c` |

## Build & Verify
```bash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/efekta ./cmd/efekta
go test -race ./...
```
