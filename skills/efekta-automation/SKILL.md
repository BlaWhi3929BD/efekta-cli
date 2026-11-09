---
name: efekta-automation
description: Automate English lessons and exercises on learn.better.efekta.com using the high-speed efekta CLI and MCP server. Use when the user asks to complete, solve, or automate Efekta lessons, units, or stages.
---

# Efekta Lesson Automation Skill

Use the `efekta` CLI (or `efekta mcp` tools) to inspect and complete interactive English exercises on `learn.better.efekta.com`.

## 1. Core Loop

1. Inspect the active Efekta tab:
   ```bash
   efekta status --json
   ```
2. Read `exerciseType`, `prompt`, `contextText` (with inline `[input-1]` or `[slot-1]` markers), `feedback`, `canProceed`, and `elements`.
3. Execute the optimal strategy for the detected `exerciseType`:

### Multiple Choice (`multiple_choice`)
- Brute-force all options automatically:
  ```bash
  efekta solve choice --json
  ```
- Or click the semantically correct `opt-N` and then `efekta click next-1`.

### Fill in the Blanks (`fill_in_the_blanks`)
- Read `contextText` to see where `[input-1]`, `[input-2]` sit in the sentence.
- **Always wait 350ms between typing each word** so Efekta's UI does not reset:
  ```bash
  efekta batch "type input-1 answer1; wait 350; type input-2 answer2; wait 350; click next-1" --json
  ```

### Sentence Ordering (`order_sentence`)
- Run heuristic analysis:
  ```bash
  efekta solve sentence --json
  ```
- **Heuristics:**
  - The first word always starts with a capital letter (note: `"I"` is always capitalized in English, so check if another capitalized word exists first).
  - The last word always ends with punctuation (`.`, `?`, `!`).
- Drag or click words in sequence (`efekta drag item-X slot-Y` or `efekta click item-X`).

### Column Categorization (`categorize_columns`)
- Drag items (`item-1`, `item-2`...) into category columns (`slot-1`, `slot-2`...).
- **Always wait 450ms between drags** because Efekta's UI accepts cards slowly:
  ```bash
  efekta batch "drag item-1 slot-1; wait 450; drag item-2 slot-2; wait 450" --json
  ```

### Speaking / Video Avatar (`speaking_avatar`)
- **First 3 stages rule:** Inside a lesson, the first 3 stages can be passed without voice—click the end/stage nav (`stage-N`) to check minimum pass requirements and only complete non-voice tasks.
- **When voice dialog is mandatory:**
  1. Wait for the AI video avatar to finish talking:
     ```bash
     efekta wait video-end --json
     ```
  2. Trigger the 3-attempt synthetic speech bypass to unlock manual text answers:
     ```bash
     efekta solve speak --json
     ```
  3. Select the unlocked manual choice (`opt-1`, `opt-2`...).
