# AGENTS.md — AI Agent Instructions for `efekta-cli`

This repository provides **`efekta`**, an ultra-fast CLI & Model Context Protocol (MCP) server for AI agents to inspect and automatically complete English lessons on `learn.better.efekta.com`.

---

## 1. How AI Agents Connect to Efekta

You have two ways to interact with the browser where `learn.better.efekta.com` is open:
1. **Direct CLI execution (fastest, < 5ms overhead):**
   Run `efekta <command> --json` in the terminal.
2. **Model Context Protocol (MCP stdio server):**
   Configure `efekta mcp` in your MCP client (`claude_desktop_config.json`, `.cursor/mcp.json`, Windsurf, Cline, Codex, Antigravity).

If you ever need a refresher on commands or Efekta heuristics, run:
```bash
efekta guide
```

---

## 2. Core CLI Commands (Always prefer `--json`)

| Command | Description |
| :--- | :--- |
| `efekta status --json` | Returns `exerciseType`, `prompt`, `contextText` (with inline `[input-1]` / `[slot-1]` placeholders), `feedback`, `video` state, `canProceed`, `nextButtonId`, and all interactive `elements`. |
| `efekta click <target>` | Clicks an element by virtual ID (`opt-1`, `next-1`, `stage-4`), CSS selector, text, or `x,y` coordinates. |
| `efekta drag <source> <target>` | Drags a word/card (`item-1`) to a slot or category column (`slot-1`). |
| `efekta type <target> "<text>"` | Types text into a fill-in-the-blank input or contenteditable gap (`input-1`). |
| `efekta press <key>` | Presses a keyboard key (`Enter`, `Backspace`, `Escape`, `Tab`, `Space`). |
| `efekta wait <cond>` | Waits for milliseconds (`350`), `video-end` (avatar finishes speaking), or `next` (Next button unlocks). |
| `efekta batch "<cmds>"` | Executes a semicolon-separated chain of commands in one roundtrip (supports `click`, `drag`, `type`, `press`, `scroll`, `wait`, `solve`). |
| `efekta solve <strategy>` | Runs built-in solver: `choice` \| `sentence` \| `speak`. |
| `efekta screen -o /tmp/efekta.png` | Captures a lossless PNG screenshot of the Efekta tab. |

---

## 3. Efekta Course Structure & Rules for Agents

### Course Hierarchy
`Level` -> `Unit` -> `Lesson` -> `Stages` (activities inside a lesson).

### Rule 1: First 3 Stages Without Voice
Inside a lesson, **the first 3 stages can be completed without microphone speech**.
- Click the end / stage navigation indicators (`stage-N`) to check the minimum completion requirements needed to advance to the next stage.
- Complete only the non-voice exercises required to unlock stage progression.

### Rule 2: Multiple Choice (`exerciseType: "multiple_choice"`)
- **Strategy:** Fastest and easiest task. Run:
  ```bash
  efekta solve choice --json
  ```
  Or click all choices rapidly in a batch:
  ```bash
  efekta batch "click opt-1; wait 90; click opt-2; wait 90; click opt-3; wait 90; click opt-4" --json
  ```
- Selecting the right choice immediately unlocks the Next button (`canProceed: true`).

### Rule 3: Fill in the Blanks (`exerciseType: "fill_in_the_blanks"`)
- **Strategy:** Read `prompt` and `contextText` from `efekta status --json` (blanks are marked inline as `[input-1]`, `[input-2]`).
- **CRITICAL TIMING RULE:** Wait **300–400ms** after filling or guessing each word before filling the next blank! If you fill multiple blanks without a pause, Efekta's frontend state may reset the previous word:
  ```bash
  efekta batch "type input-1 goes; wait 350; type input-2 work; wait 350; click next-1" --json
  ```

### Rule 4: Sentence Reordering / Order Blocks (`exerciseType: "order_sentence"`)
- **Strategy:** Run `efekta solve sentence --json` to get token heuristics:
  - **First word:** Always starts with a capital letter. *(Watch out: the pronoun `"I"` is always capitalized in English—check if another capitalized word exists first!)*
  - **Last word:** Always ends with a punctuation mark (`.`, `?`, `!`).
  - Place words into slots (`efekta drag item-X slot-Y` or `efekta click item-X`) and observe the updated state.

### Rule 5: Column Categorization (`exerciseType: "categorize_columns"`)
- **Strategy:** Match words/expressions (`item-1`, `item-2`...) into category columns (`slot-1`, `slot-2`...).
- **CRITICAL TIMING RULE:** Efekta's UI takes **400–500ms** to animate and commit a dragged card into a column. Random brute-force is slow here—use semantic reasoning from the column titles (`slot-1`, `slot-2`) and wait between drags:
  ```bash
  efekta batch "drag item-1 slot-1; wait 450; drag item-2 slot-2; wait 450" --json
  ```

### Rule 6: Speaking / AI Video Avatar Stage (`exerciseType: "speaking_avatar"`)
- When you reach the mandatory speaking dialogue with the AI video human:
  1. Wait for the AI avatar video to finish speaking:
     ```bash
     efekta wait video-end --json
     ```
  2. Run the 3-attempt speech bypass:
     ```bash
     efekta solve speak --json
     ```
     *How it works:* The extension hooks `navigator.mediaDevices.getUserMedia` and feeds speech-modulated synthetic audio for 3 attempts. Efekta fails to recognize the speech 3 times and **unlocks manual multiple-choice buttons (`opt-1`, `opt-2`...)**!
  3. Pick the right answer manually with `efekta click opt-X` or `efekta solve choice`.
