# CLAUDE.md — Efekta Turbo Playbook for Claude Code

Use `efekta` v3.0 (Turbo Autonomous Engine) to complete English lessons on `learn.better.efekta.com` in **1 command per session/screen**.

## 5 Golden Rules
1. **Let the program do the work first (`efekta auto`):** `efekta auto --json -c` autonomously unlocks video/reading cards, runs the `>50%` Step Activity Planner (skipping straight to `Step summary` once `>50%` pass, or speaking drills if needed), conducts avatar dialogues, writes essays, and solves ALL regular-lesson exercises (`multiple_choice`, `selection_gaps`, `categorize_columns` incl. distractors, `matching_pairs`, `order_dialogue`, `order_sentence`, and `Verb | Noun` tables). It stops only on Progress Tests (`progress_test_choice`), CAPTCHA (`human_verification_required`), or rare free-text blanks.
2. **ALWAYS end manual exercise batches with `; next` (or `; auto`):** Fast-forwards through reading cards, `"Correct answers"` review screens, self-evaluations, `"Step passed!"` summaries, and Lesson Overviews in a single roundtrip (`batch "lesson U2L1; auto"` also routes across frames).
3. **ALWAYS pass `--json -c` (Compact Mode):** Strips the verbose `elements` coordinate array (saving 80% tokens) and highlights `data.agentHint` (`exerciseType`, `actionTemplate`, `slots`, `items`, `options`, `inputs`, `activities`) plus `steps` and `stoppedAt` on `auto`.
4. **Skip multi-phrase pronunciation drills in 1 command:** Run `efekta skip --json -c` to skip all phrases in a pronunciation drill and advance.
5. **PROGRESS TEST MANDATE ("Take the final test") & ANTI-BOT GUARD — ZERO TRIAL-AND-ERROR:**
   - **NEVER use `auto`, `solve *`, or brute-force on formal Progress Tests.** Every exam question is single-shot and counts toward the 70% certificate threshold.
   - The engine automatically detects Progress Tests (`exerciseType: "progress_test_choice"`) and blocks `auto` and all `solve *` commands. Always analyze the question grammatically and submit safely with `efekta batch "pick opt-X; next" --json -c`.
   - Never bypass `human_verification_required` (Cloudflare Turnstile / reCAPTCHA): report to the user and pause.

## 1-Look Decision Table

| `agentHint.exerciseType` | Command to Run Immediately |
| :--- | :--- |
| `course_overview` / dashboard | `efekta batch "lesson next; auto" --json -c` |
| `passive_screen` / `video_stage` / `lesson_overview` | `efekta auto --json -c` *(or `efekta next --json -c`)* |
| `multiple_choice` (regular lesson) | `efekta batch "solve choice; next" --json -c` *(or `pick opt-X; next`)* |
| **`progress_test_choice` (Final Test)** | `efekta batch "pick opt-X; next" --json -c` *(Analyze carefully first!)* |
| `matching_pairs` | `efekta batch "solve pair; next" --json -c` *(or `pair slot-1:item-3, slot-2:item-1; next`)* |
| `categorize_columns` | `efekta batch "solve sort; next" --json -c` *(or `sort slot-1:item-1,item-4; next`)* |
| `selection_gaps` / `fill_in_the_blanks` | `efekta batch "solve gaps; next" --json -c` *(or `gaps word1, word2; next`)* |
| `writing_essay` | `efekta batch "essay; next" --json -c` |
| `order_sentence` (tap sequence) | `efekta batch "solve sentence; next" --json -c` *(or `sequence "<text>"; next`)* |
| `order_sentence` (token picker) | `efekta batch "pick item-3,item-1,item-4,item-2; next" --json -c` |
| `order_dialogue` | `efekta batch "solve order; next" --json -c` *(or `drag item-2 item-1; next`)* |
| `speaking_practice` | `efekta skip --json -c` |
| `speaking_avatar` (final stage) | `efekta batch "dialogue; next" --json -c` |
| `human_verification_required` | **STOP & ask user** to complete verification in browser |

## Build, Install & Verify
```bash
make test      # Run JS + Go -race tests
make build     # Build ./bin/efekta
make install   # Install ~/.local/bin/efekta
make release   # Build ./dist/ cross-platform binaries
```
