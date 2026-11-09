# Efekta CLI & MCP Server (`efekta-cli`)

**Ultra-fast Cross-Browser CLI & Model Context Protocol (MCP) Server for AI Agents to automate English lessons on [learn.better.efekta.com](https://learn.better.efekta.com).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.23+-00ADD8.svg)](https://go.dev/)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-brightgreen.svg)](#installation)
[![MCP Ready](https://img.shields.io/badge/MCP-Stdio%20Server-purple.svg)](#mcp-integration-claude-cursor-windsurf-cline-antigravity)

---

## Why `efekta-cli`?

- **Blazing Fast (< 5ms CLI latency):** Single compiled Go binary with an auto-starting background WebSocket daemon.
- **Universal Browser Support:** Works in **Chrome, Brave, Edge, Firefox, Zen, Opera, and Vivaldi** via a Manifest V3 WebExtension (`extension/`). Automatically routes commands to whichever browser has an active `learn.better.efekta.com` tab.
- **Zero Anti-Bot Detection:** Runs inside your genuine browser session with real cookies, native pointer/mouse event sequences, and React 16–19 controlled input compatibility.
- **WebRTC Synthetic Speech Bypass:** Hooks `navigator.mediaDevices.getUserMedia` to synthesize speech-modulated audio, burning 3 voice attempts in seconds to unlock manual text answers on AI avatar dialogue stages.
- **Universal AI Agent Compatibility:**
  - **CLI Mode:** Structured `--json` output, deterministic virtual IDs (`opt-1`, `item-1`, `slot-1`, `input-1`, `next-1`, `mic-1`, `stage-1`), and single-roundtrip `batch` execution.
  - **MCP Server Mode (`efekta mcp`):** Built-in JSON-RPC 2.0 stdio server for Claude Desktop, Claude Code, Cursor, Windsurf, Cline, OpenAI Codex, and Google Antigravity.
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
   efekta status
   ```

---

## CLI Usage & Turbo Commands (1-Command-Per-Screen)

```bash
# Inspect current exercise with Compact Mode (-c saves 80% tokens & highlights agentHint)
efekta status --json -c

# Auto-advance & fast-forward through all consecutive passive/reading/summary screens
efekta next --json -c

# 1-Shot Matching Pairs + Auto-Advance
efekta batch "pair slot-1:item-3, slot-2:item-1, slot-3:item-2; next" --json -c

# 1-Shot Category Sorting (immune to DOM removal) + Auto-Advance
efekta batch "sort slot-1:item-1,item-3; sort slot-2:item-2,item-4; next" --json -c

# 1-Shot Selection-Gap Drawer / Blank Filling + Auto-Advance
efekta batch "gaps wait, better, time, lifestyle, yourself; next" --json -c

# 1-Shot Multi-Select or Sentence Reordering + Auto-Advance
efekta batch "pick opt-1,opt-3,opt-5; next" --json -c

# Built-in smart solvers
efekta solve choice --json     # Brute-force multiple choice options until Next unlocks
efekta solve sentence --json   # Analyze sentence order (capital first word + ending punctuation)
efekta solve speak --json      # Burn 3 synthetic audio attempts to unlock manual choices

# Capture lossless PNG screenshot of the Efekta tab
efekta screen -o screenshot.png

# Print the 1-Look AI Agent Decision Matrix & Playbook
efekta guide
```

---

## MCP Integration (Claude, Cursor, Windsurf, Cline, Antigravity, Codex)

`efekta` includes a native **Model Context Protocol (MCP)** stdio server. Add it to your agent's MCP configuration (`claude_desktop_config.json`, `.cursor/mcp.json`, etc.):

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
- `efekta_click` — Click element by virtual ID, selector, text, or coordinates.
- `efekta_drag` — Drag word/card (`item-N`) to target slot/column (`slot-N`).
- `efekta_type` — Type text into a blank (`input-N`).
- `efekta_solve` — Run smart solver (`choice`, `sentence`, or `speak`).
- `efekta_wait` — Wait for `video-end`, `next`, or milliseconds.

---

## AI Agent Playbook & Efekta Heuristics

This repository includes ready-to-use agent instructions in [`AGENTS.md`](AGENTS.md), [`CLAUDE.md`](CLAUDE.md), [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md), and [`skills/efekta-automation/SKILL.md`](skills/efekta-automation/SKILL.md).

1. **First 3 Stages No-Voice Rule:** Inside any lesson (`Level -> Unit -> Lesson -> Stages`), the first 3 stages can be passed without speaking. Click the end stage indicator (`stage-N`) to inspect minimum requirements and complete only non-voice tasks.
2. **Multiple Choice (`multiple_choice`):** Run `efekta solve choice --json` to rapidly cycle through options until progression unlocks.
3. **Fill in the Blanks (`fill_in_the_blanks`):** Always wait **300–400ms** (`wait 350`) between filling consecutive blanks so Efekta's UI state does not reset.
4. **Order Sentence (`order_sentence`):** Run `efekta solve sentence --json`. First word is always capitalized (watch out for standalone `"I"`), last word always ends with punctuation (`.`, `?`, `!`).
5. **Categorize Columns (`categorize_columns`):** Wait **400–500ms** (`wait 450`) between dragging cards into columns so Efekta's slow acceptance animation completes.
6. **Speaking Avatar (`speaking_avatar`):** Run `efekta wait video-end && efekta solve speak --json`. After 3 failed synthetic speech recordings, Efekta unlocks manual multiple-choice selection!

---

## Security & Architecture

- **WebSocket Origin Verification:** Daemon only accepts WebSocket connections from browser extensions (`chrome-extension://`, `moz-extension://`, `safari-web-extension://`), blocking arbitrary websites from hijacking the bridge.
- **CSRF Protection:** `/api/exec` rejects requests containing browser `Origin` / `Sec-Fetch-Site` headers and requires `X-Efekta-Client: efekta-cli`.
- **Thread-Safe Multi-Browser Pool:** Concurrent requests are serialized per WebSocket session and routed automatically to the browser window with an active Efekta tab.
