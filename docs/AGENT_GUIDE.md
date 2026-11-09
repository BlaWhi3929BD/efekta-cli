# Efekta AI Agent Turbo Guide (`learn.better.efekta.com`)

This guide is designed so that **any AI agent** (even slow-thinking models) can complete an entire Efekta lesson in **6–10 total CLI calls** instead of 80+ slow step-by-step calls.

---

## 1. Why Previous Agent Execution Was Slow (And How Turbo v2.2 Solves It)

| Old Bottleneck | Turbo v2.2 Solution |
| :--- | :--- |
| Calling `efekta status` after every click | **Every command returns the updated state (`data`) automatically.** Never call `status` after an action! |
| Calling `click next-1` on 4 consecutive reading cards / `"Step passed!"` screens | **`next` (or `; next` at the end of a `batch`) auto-fast-forwards** through up to 7 consecutive passive screens, reading cards, `"Correct answers"` reviews, and Lesson Overviews, collecting their text in `autoReadNotes` and stopping at the next interactive exercise! |
| Inserting manual `wait 300`, `wait 500`, `wait 1200` | **`content.js` automatically polls `waitUntilUnlocked()`** until `.locked` and `.item-disabled` clear before every click. |
| Sorting items removed DOM nodes and shifted `opt-3` -> `opt-2` mid-batch | **`sort`, `pair`, and `pick` snapshot element texts upfront** before the first click, resolving each item by its snapshotted text even if the DOM re-renders. |
| Opening selection-gap drawers one by one (`click slot-1` -> `status` -> `click opt-3`) | **`gaps word1, word2, word3` handles the entire screen in 1 command:** clicks each unfilled `selection-gap-button`, waits for `.drawer-option` to open, clicks the matching word, and repeats! |
| Parsing 40+ noisy elements with duplicated screen-reader text (`"stress stress"`) | **`--json -c` (Compact Mode) + `agentHint`:** strips screen-reader duplicates, hides media player chrome, and gives you a pre-built `agentHint.actionTemplate` + clean `slots`, `items`, and `options` lists! |

---

## 2. The 1-Look Decision Table (Memorize This!)

Always run commands with `--json -c`. Look ONLY at `data.agentHint` and `data.contextText`:

### Case 1: `passive_screen` or `lesson_overview`
When `agentHint.exerciseType` is `"passive_screen"` or `"lesson_overview"`:
```bash
efekta next --json -c
```
*Result:* Clicks Next / enters the next incomplete lesson step, glides through all intro/reading cards, and stops on the first real exercise!

### Case 2: `matching_pairs` ("Tap to match")
`agentHint` shows:
- `slots`: `["slot-1: Reduce", "slot-2: Improve", "slot-3: Work"]`
- `items`: `["item-1: your diet", "item-2: fewer hours", "item-3: stress"]`

Match all pairs + advance in **1 command**:
```bash
efekta batch "pair slot-1:item-3, slot-2:item-1, slot-3:item-2; next" --json -c
```

### Case 3: `categorize_columns` ("Sort the items")
`agentHint` shows:
- `slots`: `["slot-1: Good habits", "slot-2: Bad habits"]`
- `items`: `["item-1: eat well", "item-2: work late", "item-3: exercise", "item-4: skip lunch"]`

Sort all items into both categories + advance in **1 command**:
```bash
efekta batch "sort slot-1:item-1,item-3; sort slot-2:item-2,item-4; next" --json -c
```

### Case 4: `selection_gaps` or `fill_in_the_blanks` ("Tap on the gaps...")
`contextText` shows sentences with inline `[slot-1]` or `[input-1]` markers.
Fill all gaps in order + advance in **1 command**:
```bash
efekta batch "gaps wait, better, time, lifestyle, yourself; next" --json -c
```
*(Note: If `slot-1` was already filled with `"changes"` and `slot-2..slot-6` are empty, `gaps` automatically starts at the first unfilled gap button! You can also target specific gaps explicitly: `gaps slot-2=wait, slot-3=better`.)*

### Case 5: `multiple_choice` (Single or Multi-Select)
- **Single answer:**
  ```bash
  efekta batch "pick opt-2; next" --json -c
  ```
  *(Or brute-force unknown single choice: `efekta batch "solve choice; next" --json -c`)*
- **Multi-select ("Choose two" / "Choose three"):**
  ```bash
  efekta batch "pick opt-1,opt-3,opt-5; next" --json -c
  ```

### Case 6: `order_sentence` ("Put the words in the correct order")
- **Capital letter rule:** First word starts with a capital letter (check non-`"I"` capitalized words first).
- **Punctuation rule:** Last word ends with `.`, `?`, or `!`.
Click all tokens in order + advance in **1 command**:
```bash
efekta batch "pick item-4,item-1,item-5,item-2,item-3; next" --json -c
```

### Case 7: `speaking_practice` (Pronunciation Drill with Microphone)
- Target phrase is displayed in `agentHint.summary` and `contextText`.
- Complete all phrases in the drill + advance in **1 command**:
  ```bash
  efekta batch "speak all; next" --json -c
  ```
  *(Voice Engine v3 captures native reference audio or synthesizes clean English TTS via daemon `/api/tts`, feeds it cleanly into the one-shot armed microphone stream, and leaves the user's real microphone 100% untouched for when they speak).*

### Case 8: `speaking_avatar` (Microphone / AI Video Human)
- **Non-final stage (`skip-1` is present):**
  ```bash
  efekta batch "click skip-1; next" --json -c
  ```
- **Final stage (Mandatory AI Avatar Dialogue, no `skip-1`):**
  Efekta presents response options (A, B, C) in `agentHint.options`.
  - **Tap mode (buttons visible):** Pick the chosen option directly + advance in 1 command:
    ```bash
    efekta batch "pick opt-2; next" --json -c
    ```
  - **Speech mode (microphone visible):** Speak the chosen option directly + advance in 1 command:
    ```bash
    efekta batch "speak opt-2; next" --json -c
    # or by letter:
    efekta batch "speak B; next" --json -c
    ```
  *(Never invent arbitrary responses: always choose from the options listed in `agentHint.options`).*
