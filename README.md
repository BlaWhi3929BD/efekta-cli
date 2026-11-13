# Efekta CLI & MCP Server (`efekta-cli`)

**Ultra-fast Cross-Browser CLI & Model Context Protocol (MCP) Server to automate English lessons on [learn.better.efekta.com](https://learn.better.efekta.com).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.23+-00ADD8.svg)](https://go.dev/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg)](#-quick-start-in-3-steps--быстрый-старт-за-3-шага)
[![Browsers](https://img.shields.io/badge/Browsers-Chrome%20%7C%20Edge%20%7C%20Brave%20%7C%20Firefox%20%7C%20Zen-orange.svg)](#step-2-load-browser-extension-2-minutes)
[![MCP Ready](https://img.shields.io/badge/MCP-Stdio%20Server-purple.svg)](#-mcp-integration-for-ai-agents)

---

## ⚡ Quick Start in 3 Steps / Быстрый старт за 3 шага

### Step 1: Install `efekta` / Шаг 1: Установка

Choose your operating system / Выберите вашу систему:

#### 🪟 Windows (PowerShell)
Open **PowerShell** and run:
```powershell
git clone https://github.com/BlaWhi3929BD/efekta-cli.git
cd efekta-cli
powershell -ExecutionPolicy Bypass -File .\install.ps1
```
*Tip: If you don't have Go installed, run `winget install GoLang.Go`, restart PowerShell so the updated `PATH` loads, and run the installer command above.*

---

#### 🍎 macOS (Apple Silicon M1/M2/M3/M4 & Intel)
Open **Terminal** and run:
```bash
git clone https://github.com/BlaWhi3929BD/efekta-cli.git
cd efekta-cli
bash install.sh
```
*Tip: If you don't have Go installed: `brew install go`*

---

#### 🐧 Linux (Ubuntu, Debian, Fedora, Arch, openSUSE, etc.)
Open **Terminal** and run:
```bash
git clone https://github.com/BlaWhi3929BD/efekta-cli.git
cd efekta-cli
bash install.sh
```
*Or using make:* `make install` *(copies static binary to `~/.local/bin/efekta`)*

---

### Step 2: Load Browser Extension (2 minutes) / Шаг 2: Расширение в браузер

Works in **Google Chrome, Microsoft Edge, Brave, Opera, Vivaldi, Firefox, and Zen Browser**:

1. Open your browser's extension manager:
   - **Chrome, Brave, Opera, Vivaldi:** enter `chrome://extensions` in the address bar.
   - **Microsoft Edge:** enter `edge://extensions` in the address bar.
   - **Firefox, Zen:** enter `about:debugging#/runtime/this-firefox` in the address bar.
2. Turn ON **"Developer mode"** (переключатель «Режим разработчика» в правом верхнем углу).
3. Click **"Load unpacked"** (кнопка «Загрузить распакованное») and select the `extension` folder inside this repository:
   - Example path: `C:\Users\YourName\efekta-cli\extension` (Windows) or `~/efekta-cli/extension` (macOS/Linux).
   - *(In Firefox/Zen: click "Load Temporary Add-on..." and choose `extension/manifest.json`)*.
4. Pin the **Efekta** extension icon in your browser toolbar!
   - **Microsoft Edge tip (Windows):** If Edge puts background tabs to sleep, add `learn.better.efekta.com` to **"Never put these sites to sleep"** in `edge://settings/system` so active lessons keep running uninterrupted.

---

### Step 3: Start Learning! / Шаг 3: Запуск

1. Open [learn.better.efekta.com](https://learn.better.efekta.com) in your browser and log in.
2. In your terminal, type:
```bash
# Check connection:
efekta status

# Run full autopilot (reads cards, skips drills, conducts dialogues, solves questions):
efekta auto

# Find & launch the next incomplete lesson automatically:
efekta lesson next
```
**That's it! Everything works automatically in the background.** 🎉

---

## 🎮 Everyday Commands (Простые команды для людей)

| What you want to do / Что сделать | Command / Команда |
| :--- | :--- |
| **Полный автопилот** (решает тесты, говорит с аватаром, листает теорию) | `efekta auto` |
| **Найти и начать следующий урок** автоматически | `efekta lesson next` |
| **Показать список всех уроков** и процент прохождения | `efekta lesson list` |
| **Перейти к конкретному уроку** (например, Unit 2 Lesson 3) | `efekta lesson U2L3` |
| **Промотать карточки чтения / результаты** к следующему заданию | `efekta next` |
| **Пропустить тренировку произношения** за 1 секунду | `efekta skip` |
| **Пройти диалог с видео-аватаром** (ролевая игра) | `efekta dialogue` |
| **Написать эссе / формальное письмо** (120+ слов B2 уровня) | `efekta essay` |
| **Проверить статус подключения** к браузеру | `efekta daemon status` |
| **Сделать снимок экрана урока** | `efekta screen -o screenshot.png` |

---

## 🛡️ Progress Test Safeguard ("Take the final test")

On regular lessons, trial-and-error (`solve choice`) is allowed. However, on the **Final Progress Test**:
- **Automatic Test Score Protection:** Every question on the Progress Test is a single-shot formal assessment that directly determines your certificate score (minimum 70% required).
- The program **automatically detects** when you are on the Progress Test (`exerciseType: "progress_test_choice"`).
- Dangerous brute-force commands (`solve choice` and `auto`) are **strictly blocked** on tests to protect you from losing points!
- The CLI prompts you to derive the correct answer grammatically and submit safely with:
  ```bash
  efekta batch "pick opt-2; next"
  ```

---

## ❓ Frequently Asked Questions & Troubleshooting (FAQ)

<details>
<summary><b>1. Command not found: efekta / "efekta" не распознано как команда</b></summary>

Your terminal hasn't loaded the installation directory into your `PATH`.
- **Windows:** Close and reopen PowerShell. The installer already added `%USERPROFILE%\.local\bin` to your User PATH.
- **Linux & macOS:** Run:
  ```bash
  export PATH="$HOME/.local/bin:$PATH"
  ```
  And add that line to your `~/.bashrc` or `~/.zshrc`.
</details>

<details>
<summary><b>2. "Browser extension: NOT CONNECTED" / Расширение не подключено</b></summary>

Make sure:
1. The extension is loaded and active in your browser (`chrome://extensions` or `edge://extensions`).
2. You have a tab open at `https://learn.better.efekta.com`.
3. Check the extension popup in your browser toolbar — it will show a green dot when connected to the background daemon.
</details>

<details>
<summary><b>3. Do I need to start the daemon manually? / Нужно ли запускать сервер вручную?</b></summary>

**No!** The background daemon starts automatically the first time you run any `efekta` command. You never need to manage it manually.
If you ever want to check its status: `efekta daemon status`. To stop it: `efekta daemon stop`.
</details>

<details>
<summary><b>4. Does it touch my real microphone? / Трогает ли программа микрофон?</b></summary>

**No.** Voice Engine v3 leaves your real microphone 100% untouched. During avatar roleplays, it injects synthetic English speech directly into the browser's Web Audio pipeline inside the tab. No OS microphone permissions needed.
</details>

<details>
<summary><b>5. Can I use it on multiple browsers? / Можно ли использовать в разных браузерах?</b></summary>

**Yes!** Chrome, Edge, Brave, Opera, Vivaldi, Firefox, and Zen are all supported. If multiple browsers are open, `efekta` automatically routes commands to whichever browser currently has an active Efekta lesson tab.
</details>

---

## 🤖 MCP Integration for AI Agents (Claude, Cursor, Windsurf, Antigravity)

`efekta` includes a native **Model Context Protocol (MCP)** stdio server. Add it to your AI tool configuration:

### Configuration (`mcp_config.json` / Claude Desktop / Cursor / Windsurf)
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
> **Windows Note:** If your MCP client was already running when you ran `install.ps1`, restart it completely so it picks up the new `PATH` — or set `"command"` to the full path `"C:\\Users\\<YourName>\\.local\\bin\\efekta.exe"`.

### Available MCP Tools

| MCP Tool | Description |
| :--- | :--- |
| `efekta_autopilot` | Full autonomous progression across passive screens, drills, dialogues, and multiple choice |
| `efekta_status` | Inspect exercise type, prompt, blanks (`[input-1]`), feedback, video state, and virtual IDs |
| `efekta_next` | Fast-forward through consecutive passive screens and summaries until interactive exercise |
| `efekta_batch` | Execute chained commands in a single roundtrip (e.g. `"gaps word1, word2; next"`) |
| `efekta_lesson` | Select, list, or start lessons and the final progress test (`target: "next" \| "list" \| "U1L1" \| "TEST"`) |
| `efekta_dialogue` | Complete multi-turn AI avatar roleplays end to end with speech and tap options |
| `efekta_essay` | Auto-write and submit 120+ word B2 formal email/essay and pass self-evaluation |
| `efekta_sequence` | Auto-order tokens in tap-sequencing tasks (`tokens: "auto"` or sentence text) |
| `efekta_solve` | Smart solvers: `choice` (regular lessons), `sentence` (word ordering), `speak` (skip drills) |
| `efekta_click` | Click element by virtual ID (`opt-1`, `next-1`), selector, text, or coordinates |
| `efekta_drag` | Drag word/card (`item-N`) to target slot/column (`slot-N`) |
| `efekta_type` | Type text into a blank input (`input-N`) |
| `efekta_wait` | Wait for `video-end`, `next`, or milliseconds |
| `efekta_screenshot` | Capture lossless PNG screenshot of the Efekta tab |

---

## 🧠 Instant Decision Matrix for AI Agents

When interacting with the CLI, always pass `--json -c` for 80% smaller compact output. Read `data.agentHint.exerciseType`:

| `exerciseType` | What You See in `agentHint` | 1-Roundtrip CLI Command | MCP Tool Equivalent |
| :--- | :--- | :--- | :--- |
| `course_overview` / dashboard | On `/gap/ui/self-study` | `efekta lesson next --json -c` | `efekta_lesson(target="next")` |
| `passive_screen` / `lesson_overview` | `canProceed: true` or `stage-N` | `efekta next --json -c` *(or `efekta auto`)* | `efekta_autopilot()` |
| `multiple_choice` (Lesson) | `options: ["opt-1: ...", ...]` | `efekta batch "solve choice; next" --json -c` | `efekta_solve(strategy="choice")` |
| **`progress_test_choice` (Final Test)** | Graded single-shot exam question | `efekta batch "pick opt-X; next" --json -c` *(Analyze first!)* | `efekta_batch(commands="pick opt-X; next")` |
| `speaking_practice` | Pronunciation drill (Stages 1–5) | `efekta skip --json -c` | `efekta_solve(strategy="speak")` |
| `speaking_avatar` | Final avatar dialogue | `efekta batch "dialogue; next" --json -c` | `efekta_dialogue()` |
| `selection_gaps` | `[slot-N]` + drawer options | `efekta batch "gaps word1, word2; next" --json -c` | `efekta_batch(commands="gaps ...; next")` |
| `fill_in_the_blanks` | `[input-N]` text blanks | `efekta batch "gaps ans1, ans2; next" --json -c` | `efekta_batch(commands="gaps ...; next")` |
| `writing_essay` | 80–120+ word textarea | `efekta batch "essay; next" --json -c` | `efekta_essay(text="auto")` |
| `matching_pairs` | `slots` + `items` | `efekta batch "pair slot-1:item-2; next" --json -c` | `efekta_batch(commands="pair ...; next")` |
| `categorize_columns` | Category `slots` + `items` | `efekta batch "sort slot-1:item-1; next" --json -c` | `efekta_batch(commands="sort ...; next")` |
| `order_sentence` (tap sequence) | `ef-sequencing-tap-option-task` | `efekta batch "sequence auto; next" --json -c` | `efekta_sequence(tokens="auto")` |
| `order_sentence` (token picker) | Shuffled words in `items` | `efekta batch "pick item-3,item-1; next" --json -c` | `efekta_batch(commands="pick ...; next")` |
| `order_dialogue` | Dialogue turns (`cdk-drag`) | `efekta batch "drag item-2 item-1; next" --json -c` | `efekta_batch(commands="drag ...; next")` |

---

## 🔧 Troubleshooting & Windows Notes

- **Port `8765` conflict / daemon startup failure:** The CLI daemon listens on `127.0.0.1:8765` to match the browser extension. On Windows with Hyper-V/WSL2, dynamic port exclusions or another local service can occasionally block `8765`. Check the startup log `efekta-daemon.log` in `%TEMP%` (Windows) or `$TMPDIR` / `/tmp` (macOS/Linux), and stop conflicting processes with `efekta daemon stop`.
- **Quoting in Windows `cmd.exe` vs PowerShell:** `cmd.exe` does not strip single quotes `'...'`, so prefer double quotes for commands like `efekta batch "pick opt-1; next"` (matching PowerShell/bash).

---

## 🛠️ Building From Source

Requirements: **Go 1.23+** and **Node.js** (for extension syntax verification).

```bash
git clone https://github.com/BlaWhi3929BD/efekta-cli.git
cd efekta-cli

# Run tests
make test

# Build static binary
make build

# Build cross-platform release binaries (Linux, macOS, Windows)
make release
```

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
