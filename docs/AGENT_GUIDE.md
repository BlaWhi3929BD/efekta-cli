# Efekta AI Agent Automation Guide (v2.0)

This guide is designed for **AI coding agents** (Claude Code, OpenAI Codex, Cursor, Windsurf, Google Antigravity, Cline, Roo Code, OpenCode, Aider) operating the `efekta` CLI or MCP server to complete English lessons on `learn.better.efekta.com`.

---

## 1. Two Ways to Connect

### Option A: Fast CLI (Recommended for Bash-capable agents)
Run `efekta <command> --json`. The background WebSocket daemon starts automatically if not already running.

### Option B: Model Context Protocol (`efekta mcp`)
Configure `efekta mcp` as a stdio MCP server. It exposes 6 structured tools:
- `efekta_status`
- `efekta_click`
- `efekta_drag`
- `efekta_type`
- `efekta_solve`
- `efekta_wait`

---

## 2. Understanding `efekta status --json`

```json
{
  "id": "req-1762692000-1",
  "success": true,
  "data": {
    "url": "https://learn.better.efekta.com/...",
    "title": "Efekta",
    "exerciseType": "fill_in_the_blanks",
    "prompt": "Complete the sentences with the correct form of the verb.",
    "contextText": [
      "She usually [input-1] to the office by train, but today she [input-2] from home."
    ],
    "feedback": "",
    "video": {
      "hasVideo": false,
      "isPlaying": false,
      "paused": true,
      "ended": true,
      "currentTime": 0,
      "duration": 0
    },
    "canProceed": false,
    "nextButtonId": "",
    "elementsCount": 3,
    "elements": [
      { "id": "input-1", "type": "input", "text": "", "tag": "input", "x": 380, "y": 290, "width": 90, "height": 32, "selected": false, "disabled": false },
      { "id": "input-2", "type": "input", "text": "", "tag": "input", "x": 610, "y": 290, "width": 90, "height": 32, "selected": false, "disabled": false },
      { "id": "next-1", "type": "next_btn", "text": "Check", "tag": "button", "x": 820, "y": 580, "width": 110, "height": 44, "selected": false, "disabled": true }
    ]
  }
}
```

### Virtual ID Prefixes
- `opt-1, opt-2...` — Multiple-choice options / radio buttons / checkboxes
- `item-1, item-2...` — Draggable word chips / cards / blocks
- `slot-1, slot-2...` — Drop target slots / blank boxes / category columns
- `input-1, input-2...` — Text inputs / textareas / contenteditable blanks
- `next-1...` — Next / Continue / Check / Submit / Proceed buttons
- `mic-1...` — Microphone / Record speech buttons
- `stage-1, stage-2...` — Lesson stage navigation tabs/indicators
- `btn-1, btn-2...` — Other interactive buttons

---

## 3. Command Reference

```bash
# Inspect current page state
efekta status --json

# Click an element by virtual ID, CSS selector, exact text, or x,y coordinates
efekta click opt-1 --json

# Drag a draggable item to a target slot or column
efekta drag item-1 slot-1 --json

# Type text into an input or contenteditable gap
efekta type input-1 "goes" --json

# Press a keyboard key (Enter, Escape, Backspace, Tab, Space, ArrowRight...)
efekta press Enter --json

# Wait for avatar video completion, Next button unlock, or milliseconds
efekta wait video-end --json
efekta wait next --json
efekta wait 350 --json

# Query arbitrary DOM elements by CSS selector
efekta eval "[class*='lesson']" --json

# Chained batch execution in a single roundtrip
efekta batch "type input-1 goes; wait 350; type input-2 is working; wait 350; click next-1" --json

# Built-in smart solvers
efekta solve choice --json
efekta solve sentence --json
efekta solve speak --json

# Capture lossless PNG screenshot
efekta screen -o /tmp/efekta.png --json
```

---

## 4. Exercise-Specific Strategies & Timing Rules

1. **First 3 Stages Without Voice:**
   - Inside a lesson (`Level -> Unit -> Lesson -> Stages`), the first 3 stages can be completed without microphone speech.
   - Click the end / stage navigation buttons (`stage-N`) to inspect minimum completion requirements, and complete only the non-voice tasks needed to advance.

2. **Multiple Choice (`multiple_choice`):**
   - Run `efekta solve choice --json`. It clicks each option with a 90ms delay (and clicks `Check` if present) until `canProceed` becomes `true`.

3. **Fill in the Blanks (`fill_in_the_blanks`):**
   - Always include `wait 350` between filling consecutive blanks so Efekta's frontend state does not reset earlier blanks.

4. **Order Sentence (`order_sentence`):**
   - Run `efekta solve sentence --json`.
   - First word starts with a capital letter (watch out for standalone `"I"`—only use `"I"` as first word if no other capitalized word exists or grammar requires it).
   - Last word ends with `.`, `?`, or `!`.

5. **Categorize Columns (`categorize_columns`):**
   - Always include `wait 450` between `drag item-X slot-Y` actions because Efekta's UI takes ~400ms to accept a card into a category column.

6. **Speaking / AI Video Avatar (`speaking_avatar`):**
   - Run `efekta wait video-end` to wait for the avatar to finish speaking.
   - Run `efekta solve speak --json`. It burns 3 attempts using speech-modulated WebRTC audio so speech recognition fails 3 times and unlocks manual multiple-choice options (`opt-1`, `opt-2`...).
   - Click the correct option and advance!
