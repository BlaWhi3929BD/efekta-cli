# Efekta CLI & MCP Server (`efekta-cli`)

**Ultra-fast Cross-Browser CLI & Model Context Protocol (MCP) Server for AI Agents to automate English lessons on [learn.better.efekta.com](https://learn.better.efekta.com).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.23+-00ADD8.svg)](https://go.dev/)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-brightgreen.svg)](#installation)
[![MCP Ready](https://img.shields.io/badge/MCP-Stdio%20Server-purple.svg)](#mcp-integration-claude-cursor-windsurf-cline-antigravity-codex)

---

## Why `efekta-cli`?

- **Blazing Fast (< 5ms CLI latency):** Single compiled Go binary with an auto-starting background WebSocket daemon.
- **Universal Browser Support:** Works in **Chrome, Brave, Edge, Firefox, Zen, Opera, and Vivaldi** via a Manifest V3 WebExtension (`extension/`). Automatically routes commands to whichever browser has an active `learn.better.efekta.com` tab.
- **Turbo Autonomous Mode (`efekta auto`):** Automatically navigates reading cards, auto-skips pronunciation drills, conducts AI avatar dialogues, and auto-solves multiple choice. Only halts when human knowledge exercises (`gaps`, `sort`, `pair`) need an answer.
- **Zero Anti-Bot Detection:** Runs inside your genuine browser session with real cookies, native pointer/mouse event sequences, and React/Angular controlled input compatibility.
- **Voice Engine v3:** One-shot loopback audio synthesis into the browser's microphone input for avatar roleplays and pronunciation drills while keeping physical microphone untouched.
- **Universal AI Agent Compatibility:**
  - **CLI Mode:** Structured `--json -c` compact output, deterministic virtual IDs (`opt-1`, `item-1`, `slot-1`, `input-1`, `next-1`, `stage-1`), and single-roundtrip `batch` execution.
  - **MCP Server Mode (`efekta mcp`):** Native JSON-RPC 2.0 stdio server for Claude Desktop, Claude Code, Cursor, Windsurf, Cline, OpenAI Codex, and Google Antigravity.
  - **Self-Documenting (`efekta guide`):** Prints the complete AI Agent Playbook & Efekta heuristics right from the binary.

---

## Installation

### 1. Build or Install the Binary (Linux / macOS / Windows)

```bash
git clone https://github.com/BlaWhi3929BD/efekta-cli.git
cd efekta-cli

# Build and symlink to ~/.local/bin/efekta (Linux / macOS)
make install

# Or build directly with Go on any OS (Linux / macOS / Windows)
go build -o bin/efekta ./cmd/efekta
```

### 2. Load the Browser Extension (One-time setup)

1. Open your browser's Extensions page:
   - **Chrome / Brave / Edge / Opera:** `chrome://extensions` -> Enable **Developer mode** -> Click **Load unpacked** -> Select the `extension/` folder.
   - **Firefox / Zen:** `about:debugging#/runtime/this-firefox` -> Click **Load Temporary Add-on...** -> Select `extension/manifest.json`.
2. Open [learn.better.efekta.com](https://learn.better.efekta.com) and log in.
3. Verify connection:
   ```bash
   efekta daemon status
   efekta status --json -c
   ```

---

## CLI Usage & Turbo Commands (1-Command-Per-Screen)

```bash
# Full Autonomous Progression (auto-conducts reading, drills, dialogues, multiple-choice)
efekta auto --json -c

# Auto-advance & fast-forward through consecutive passive/reading/summary screens
efekta next --json -c

# Autonomous Lesson Selector & Navigator
efekta lesson next --json -c   # Auto-detect & start next incomplete lesson
efekta lesson list --json -c   # View all units, lessons, completion status & next lesson
efekta lesson U3L1 --json -c   # Jump directly to Unit 3 Lesson 1
efekta lesson TEST --json -c   # Jump directly to Final Progress Test

# 1-Shot Multi-Phrase Pronunciation Drill Skipper
efekta skip --json -c

# 1-Shot Avatar Dialogue Roleplay (turns A/B/C)
efekta batch "dialogue; next" --json -c

# 1-Shot Matching Pairs + Auto-Advance
efekta batch "pair slot-1:item-3, slot-2:item-1, slot-3:item-2; next" --json -c

# 1-Shot Category Sorting (DOM-shift immune) + Auto-Advance
efekta batch "sort slot-1:item-1,item-3; sort slot-2:item-2,item-4; next" --json -c

# 1-Shot Selection-Gap Drawer / Blank Filling + Auto-Advance
efekta batch "gaps wait, better, time, lifestyle, yourself; next" --json -c

# 1-Shot 120+ Word B2 Essay / Formal Email Writer + Auto-Advance
efekta batch "essay; next" --json -c

# 1-Shot Tap Sequence Sentence Reordering + Auto-Advance
efekta batch "sequence auto; next" --json -c

# 1-Shot Multi-Select Multiple Choice + Auto-Advance
efekta batch "solve choice; next" --json -c

# Capture lossless PNG screenshot of the Efekta tab
efekta screen -o screenshot.png
```

---

## MCP Integration (Claude, Cursor, Windsurf, Cline, Antigravity, Codex)

`efekta` includes a native **Model Context Protocol (MCP)** stdio server. Add it to your agent's MCP configuration (`mcp_config.json`, `claude_desktop_config.json`, etc.):

```json
{
  "mcpServers": {
    "efekta": {
      "command": "efekta",
      "args": ["mcp"]
    }
  }
}
```

### Exposed MCP Tools
- `efekta_status` — Inspect exercise type, prompt, inline blank context (`[input-1]`), feedback, video state, and interactive elements.
- `efekta_autopilot` — Full autonomous progression across passive screens, drills, dialogues, and multiple choice.
- `efekta_next` — Fast-forward through consecutive passive screens and summaries until interactive exercise.
- `efekta_batch` — Execute chained commands in a single roundtrip (e.g. `"gaps ...; next"`).
- `efekta_lesson` — Select, list, or start lessons and the final progress test.
- `efekta_dialogue` — Complete entire multi-turn AI avatar dialogue roleplay end to end.
- `efekta_essay` — Auto-write and submit 120+ word B2 formal email/essay and pass self-evaluation.
- `efekta_sequence` — Auto-order tokens in tap-sequencing tasks.
- `efekta_solve` — Run smart solver (`choice`, `sentence`, or `speak`).
- `efekta_click` — Click element by virtual ID, selector, text, or coordinates.
- `efekta_drag` — Drag word/card (`item-N`) to target slot/column (`slot-N`).
- `efekta_type` — Type text into a blank (`input-N`).
- `efekta_wait` — Wait for `video-end`, `next`, or milliseconds.
- `efekta_screenshot` — Save lossless PNG screenshot to disk.

---

## Progress Test Protocol ("Take the final test")

On regular lessons, trial-and-error (`solve choice`) is allowed. However, on the **Progress Test**:
1. **AUTOMATIC SAFEGUARD & NO TRIAL-AND-ERROR:** Questions are single-shot formal assessments without retries. Every wrong answer permanently lowers the proficiency certificate score. The engine automatically detects the Progress Test (`exerciseType: "progress_test_choice"`), active safeguards disallow `solve choice` and `auto`, preventing accidental score degradation.
2. **LINGUISTIC DERIVATION:** Every option must be derived through careful grammatical, semantic, and context-specific linguistic analysis.
3. **SUBMISSION:** Use `efekta batch "pick opt-X; next" --json -c` after deriving the exact grammatically correct choice.
