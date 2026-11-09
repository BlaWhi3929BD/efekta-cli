package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"efekta-cli/pkg/daemon"
	"efekta-cli/pkg/mcp"
	"efekta-cli/pkg/protocol"
)

const (
	ApiURL    = "http://127.0.0.1:8765/api/exec"
	HealthURL = "http://127.0.0.1:8765/api/health"
)

func isDaemonRunning() bool {
	client := http.Client{Timeout: 400 * time.Millisecond}
	resp, err := client.Get(HealthURL)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func ensureDaemon() error {
	if isDaemonRunning() {
		return nil
	}

	exePath, err := os.Executable()
	if err != nil {
		exePath = "efekta"
	}

	cmd := exec.Command(exePath, "daemon", "run")
	configureBackgroundProcess(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to auto-start daemon: %w", err)
	}

	for i := 0; i < 20; i++ {
		time.Sleep(100 * time.Millisecond)
		if isDaemonRunning() {
			return nil
		}
	}
	return fmt.Errorf("daemon started (pid: %d) but health check timed out", cmd.Process.Pid)
}

func execCommand(cmd protocol.Command) (*protocol.Response, error) {
	if err := ensureDaemon(); err != nil {
		return nil, err
	}

	bodyBytes, err := json.Marshal(cmd)
	if err != nil {
		return nil, err
	}

	timeout := 20 * time.Second
	if cmd.Action == "skip_speaking" || cmd.Action == "solve_choice" || cmd.Action == "wait" || cmd.Action == "batch" {
		timeout = 40 * time.Second
	}

	req, err := http.NewRequest(http.MethodPost, ApiURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(daemon.ClientHeader, daemon.ClientValue)

	client := http.Client{Timeout: timeout}
	httpResp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to query daemon: %w", err)
	}
	defer httpResp.Body.Close()

	var resp protocol.Response
	if err := json.NewDecoder(httpResp.Body).Decode(&resp); err != nil {
		return nil, fmt.Errorf("failed to parse daemon response: %w", err)
	}

	return &resp, nil
}

// ParseBatchString parses a semicolon-separated chain of commands into BatchSubCommands.
func ParseBatchString(batchStr string) []protocol.BatchSubCommand {
	var subs []protocol.BatchSubCommand
	parts := strings.Split(batchStr, ";")
	for _, raw := range parts {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		tokens := strings.Fields(item)
		if len(tokens) == 0 {
			continue
		}
		act := strings.ToLower(tokens[0])
		switch act {
		case "click":
			if len(tokens) >= 2 {
				subs = append(subs, protocol.BatchSubCommand{Action: "click", Target: tokens[1]})
			}
		case "drag":
			if len(tokens) >= 3 {
				subs = append(subs, protocol.BatchSubCommand{Action: "drag", Source: tokens[1], Target: tokens[2]})
			}
		case "type":
			if len(tokens) >= 3 {
				text := strings.Join(tokens[2:], " ")
				text = strings.Trim(text, "\"'")
				subs = append(subs, protocol.BatchSubCommand{Action: "type", Target: tokens[1], Text: text})
			}
		case "press", "key":
			if len(tokens) >= 2 {
				subs = append(subs, protocol.BatchSubCommand{Action: "press", Target: tokens[1]})
			}
		case "scroll":
			dir := "down"
			amt := 400
			if len(tokens) >= 2 {
				if tokens[1] == "up" || tokens[1] == "down" {
					dir = tokens[1]
				} else if n, err := strconv.Atoi(tokens[1]); err == nil {
					amt = n
				}
			}
			subs = append(subs, protocol.BatchSubCommand{Action: "scroll", Direction: dir, Amount: amt})
		case "wait", "sleep":
			if len(tokens) >= 2 {
				if ms, err := strconv.Atoi(tokens[1]); err == nil && ms > 0 {
					subs = append(subs, protocol.BatchSubCommand{Action: "sleep", DelayMs: ms, Target: tokens[1]})
				} else {
					subs = append(subs, protocol.BatchSubCommand{Action: "wait", Target: tokens[1]})
				}
			}
		case "solve":
			strat := "choice"
			if len(tokens) >= 2 {
				strat = strings.ToLower(tokens[1])
			}
			switch strat {
			case "sentence", "order":
				subs = append(subs, protocol.BatchSubCommand{Action: "solve_sentence"})
			case "speak", "voice":
				subs = append(subs, protocol.BatchSubCommand{Action: "skip_speaking"})
			default:
				subs = append(subs, protocol.BatchSubCommand{Action: "solve_choice"})
			}
		}
	}
	return subs
}

func printHelp() {
	fmt.Println(`efekta v2.0 - Ultra-fast CLI & MCP Server for learn.better.efekta.com (AI Agent Ready)

USAGE:
  efekta <command> [arguments] [flags]

CORE COMMANDS:
  state / status               Inspect page: exerciseType, prompt, contextText, feedback & element IDs
  click <target>              Click element by virtual ID (opt-1, next-1), CSS selector, text, or x,y
  drag <source> <target>      Drag element (item-1) to target slot/column (slot-1)
  type <target> "<text>"      Type text into input/blank (React & contenteditable compatible)
  press <key>                 Press keyboard key (Enter, Backspace, Escape, Tab, Space)
  scroll <up|down|pixels>     Scroll page smoothly
  wait <ms|video-end|next>    Wait for milliseconds, avatar video end, or Next button unlock
  eval "<css_selector>"       Inspect matching DOM elements by CSS selector
  screen [-o file.png]        Capture lossless PNG screenshot of the Efekta tab
  batch "<cmd1>; <cmd2>..."   Execute chained commands in one roundtrip (click, drag, type, wait, solve)
  solve <strategy>            Run smart solver: choice | sentence | speak

AI & SYSTEM COMMANDS:
  guide                       Print the complete AI Agent Playbook & Efekta Domain Heuristics
  mcp                         Start Model Context Protocol (MCP) JSON-RPC 2.0 server over stdio
  daemon [run|stop|status]    Manage background WebSocket daemon (auto-starts on any command)

FLAGS:
  --json                      Output machine-readable JSON (recommended for AI agents)
  -o, --output <path>         File output path (for screen)

EXAMPLES:
  efekta status --json
  efekta solve choice --json
  efekta drag item-1 slot-1
  efekta batch "drag item-1 slot-1; wait 300; drag item-2 slot-1; wait 300; click next-1"
  efekta wait video-end && efekta solve speak
  efekta guide`)
}

func printAgentGuide() {
	fmt.Println(`# EFEKTA AI AGENT PLAYBOOK (learn.better.efekta.com)

## 1. Course Hierarchy & Stage Skipping Rule
- Hierarchy: Level -> Unit -> Lesson -> Stages (inside a lesson).
- FIRST 3 STAGES NO-VOICE RULE: The first 3 stages inside a lesson can be completed without microphone speech. Click the end/stage navigation elements (stage-N) to see minimum completion requirements for advancing to the next stage, and complete only the non-voice activities required.

## 2. Exercise Types & Optimal Agent Strategies
1. MULTIPLE CHOICE (exerciseType: "multiple_choice"):
   - Easiest task. Run: 'efekta solve choice --json'
   - Or rapidly click options via batch: 'efekta batch "click opt-1; wait 90; click opt-2; wait 90; click opt-3"'
   - Clicking the right option immediately unlocks 'next-1' (canProceed: true).

2. FILL IN THE BLANKS (exerciseType: "fill_in_the_blanks"):
   - Read 'prompt' and 'contextText' from 'efekta status --json' (blanks appear inline as [input-1]).
   - IMPORTANT TIMING: Always wait 300-400ms after filling or guessing each word before filling the next one:
     'efekta batch "type input-1 word1; wait 350; type input-2 word2; wait 350; click next-1"'
   - Doing it without delay may cause Efekta's UI state to reset the previous blank.

3. ORDER BLOCKS / SENTENCE REORDERING (exerciseType: "order_sentence"):
   - Run 'efekta solve sentence --json' to get heuristic analysis:
     * First word ALWAYS starts with an uppercase letter (Note: pronoun "I" is always capitalized in English, so check if another capitalized word exists first!).
     * Last word ALWAYS has ending punctuation ('.', '?', '!').
   - Move blocks using 'efekta drag item-X slot-Y' or 'efekta click item-X', then check state.

4. CATEGORIZE COLUMNS (exerciseType: "categorize_columns"):
   - Words/phrases ('item-1', 'item-2'...) must be placed into category columns ('slot-1', 'slot-2'...).
   - IMPORTANT TIMING: Efekta takes ~300-500ms to animate and accept a card into a column. Always wait between drags:
     'efekta batch "drag item-1 slot-1; wait 450; drag item-2 slot-2; wait 450"'

5. SPEAKING / AI VIDEO AVATAR DIALOGUE (exerciseType: "speaking_avatar"):
   - Inevitable voice stage with AI video human.
   - 3-ATTEMPT BYPASS HACK:
     Step 1: Wait for the AI video avatar to finish speaking: 'efekta wait video-end'
     Step 2: Run 'efekta solve speak --json'
     How it works: The extension injects speech-modulated synthetic audio into WebRTC and triggers recording 3 times. Speech recognition fails 3 times and Efekta automatically unlocks manual multiple-choice buttons ('opt-1', 'opt-2'...)!
     Step 3: Select the correct option using 'efekta click opt-X' or 'efekta solve choice'.`)
}

func stripFlags(args []string) []string {
	var clean []string
	for i := 0; i < len(args); i++ {
		if args[i] == "--json" {
			continue
		}
		if (args[i] == "-o" || args[i] == "--output") && i+1 < len(args) {
			i++
			continue
		}
		clean = append(clean, args[i])
	}
	return clean
}

func main() {
	if len(os.Args) < 2 {
		printHelp()
		os.Exit(0)
	}

	jsonOutput := false
	for _, arg := range os.Args[1:] {
		if arg == "--json" {
			jsonOutput = true
			break
		}
	}

	posArgs := stripFlags(os.Args[1:])
	if len(posArgs) == 0 {
		printHelp()
		return
	}

	cmdName := strings.ToLower(posArgs[0])

	switch cmdName {
	case "help", "-h", "--help":
		printHelp()
		return

	case "guide", "playbook", "ai-help":
		printAgentGuide()
		return

	case "mcp":
		if err := mcp.ServeStdio(execCommand); err != nil {
			fmt.Fprintf(os.Stderr, "MCP server error: %v\n", err)
			os.Exit(1)
		}
		return

	case "daemon":
		subCmd := "status"
		if len(posArgs) >= 2 {
			subCmd = posArgs[1]
		}
		handleDaemonCmd(subCmd, jsonOutput)
		return

	case "status", "state":
		resp, err := execCommand(protocol.Command{Action: "status"})
		if err != nil {
			outputError(err, jsonOutput)
			os.Exit(1)
		}
		if jsonOutput {
			printJSON(resp)
			return
		}
		printStateHuman(resp)

	case "click":
		if len(posArgs) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: efekta click <id|selector|x,y>")
			os.Exit(1)
		}
		resp, err := execCommand(protocol.Command{Action: "click", Target: posArgs[1]})
		handleSimpleResponse(resp, err, jsonOutput)

	case "drag":
		if len(posArgs) < 3 {
			fmt.Fprintln(os.Stderr, "Usage: efekta drag <source_id> <target_id>")
			os.Exit(1)
		}
		resp, err := execCommand(protocol.Command{Action: "drag", Source: posArgs[1], Target: posArgs[2]})
		handleSimpleResponse(resp, err, jsonOutput)

	case "type":
		if len(posArgs) < 3 {
			fmt.Fprintln(os.Stderr, "Usage: efekta type <target_id> <text>")
			os.Exit(1)
		}
		text := strings.Join(posArgs[2:], " ")
		resp, err := execCommand(protocol.Command{Action: "type", Target: posArgs[1], Text: text})
		handleSimpleResponse(resp, err, jsonOutput)

	case "press", "key":
		if len(posArgs) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: efekta press <Enter|Escape|Backspace|Tab|Space>")
			os.Exit(1)
		}
		resp, err := execCommand(protocol.Command{Action: "press", Target: posArgs[1]})
		handleSimpleResponse(resp, err, jsonOutput)

	case "scroll":
		direction := "down"
		amount := 400
		if len(posArgs) >= 2 {
			arg := posArgs[1]
			if arg == "up" || arg == "down" {
				direction = arg
			} else if num, err := strconv.Atoi(arg); err == nil {
				amount = num
			}
		}
		resp, err := execCommand(protocol.Command{Action: "scroll", Direction: direction, Amount: amount})
		handleSimpleResponse(resp, err, jsonOutput)

	case "wait", "sleep":
		cond := "200"
		if len(posArgs) >= 2 {
			cond = posArgs[1]
		}
		resp, err := execCommand(protocol.Command{Action: "wait", Target: cond})
		handleSimpleResponse(resp, err, jsonOutput)

	case "eval", "query":
		if len(posArgs) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: efekta eval \"<css_selector>\"")
			os.Exit(1)
		}
		resp, err := execCommand(protocol.Command{Action: "eval", Target: posArgs[1]})
		handleSimpleResponse(resp, err, jsonOutput)

	case "screen", "screenshot":
		outputPath := "screenshot.png"
		for i := 1; i < len(os.Args); i++ {
			if (os.Args[i] == "-o" || os.Args[i] == "--output") && i+1 < len(os.Args) {
				outputPath = os.Args[i+1]
				break
			}
		}
		resp, err := execCommand(protocol.Command{Action: "screenshot"})
		if err != nil {
			outputError(err, jsonOutput)
			os.Exit(1)
		}
		if !resp.Success {
			outputError(fmt.Errorf("%s", resp.Error), jsonOutput)
			os.Exit(1)
		}

		dataMap, ok := resp.Data.(map[string]interface{})
		if !ok || dataMap["screenshotBase64"] == nil {
			outputError(fmt.Errorf("no screenshot data returned"), jsonOutput)
			os.Exit(1)
		}

		b64Str := dataMap["screenshotBase64"].(string)
		imgBytes, err := base64.StdEncoding.DecodeString(b64Str)
		if err != nil {
			outputError(err, jsonOutput)
			os.Exit(1)
		}

		if err := os.WriteFile(outputPath, imgBytes, 0644); err != nil {
			outputError(err, jsonOutput)
			os.Exit(1)
		}

		if jsonOutput {
			printJSON(map[string]interface{}{"success": true, "path": outputPath, "bytes": len(imgBytes)})
		} else {
			fmt.Printf("✓ Screenshot saved to %s (%d bytes)\n", outputPath, len(imgBytes))
		}

	case "batch":
		if len(posArgs) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: efekta batch \"click opt-1; wait 80; click next-1\"")
			os.Exit(1)
		}
		subCmds := ParseBatchString(posArgs[1])
		resp, err := execCommand(protocol.Command{Action: "batch", Commands: subCmds})
		handleSimpleResponse(resp, err, jsonOutput)

	case "solve":
		strategy := "choice"
		if len(posArgs) >= 2 {
			strategy = strings.ToLower(posArgs[1])
		}

		var action string
		switch strategy {
		case "choice", "multiple_choice":
			action = "solve_choice"
		case "sentence", "order":
			action = "solve_sentence"
		case "speak", "voice", "dialog":
			action = "skip_speaking"
		default:
			outputError(fmt.Errorf("unknown solve strategy: %s. Valid: choice | sentence | speak", strategy), jsonOutput)
			os.Exit(1)
		}

		resp, err := execCommand(protocol.Command{Action: action})
		handleSimpleResponse(resp, err, jsonOutput)

	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s. Run 'efekta help' for usage.\n", cmdName)
		os.Exit(1)
	}
}

func handleDaemonCmd(subCmd string, jsonOut bool) {
	switch subCmd {
	case "run":
		srv := daemon.NewServer()
		if err := srv.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "Daemon failed: %v\n", err)
			os.Exit(1)
		}

	case "status":
		client := http.Client{Timeout: 1 * time.Second}
		resp, err := client.Get(HealthURL)
		if err != nil {
			if jsonOut {
				printJSON(map[string]interface{}{"status": "stopped", "browserConnected": false})
			} else {
				fmt.Println("Daemon status: STOPPED (not running)")
			}
			return
		}
		defer resp.Body.Close()
		var data map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&data)
		if jsonOut {
			printJSON(data)
			return
		}
		browserConnected := data["browserConnected"] == true
		hasTab := data["hasEfektaTab"] == true
		fmt.Printf("Daemon status: RUNNING on port %s\n", daemon.WsPort)
		if browserConnected {
			fmt.Printf("Browser extension: CONNECTED ✓ (Efekta tab active: %v)\n", hasTab)
		} else {
			fmt.Println("Browser extension: NOT CONNECTED ✗ (load extension & open learn.better.efekta.com)")
		}

	case "stop":
		pidBytes, err := os.ReadFile(daemon.GetPIDFilePath())
		if err != nil {
			fmt.Println("Daemon PID file not found, may already be stopped.")
			return
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
		if err != nil {
			fmt.Println("Invalid PID in file.")
			return
		}
		if err := terminateProcess(pid); err == nil {
			fmt.Printf("Stopped daemon (PID %d)\n", pid)
		}
		daemon.RemovePID()

	default:
		fmt.Println("Usage: efekta daemon [run|status|stop]")
	}
}

func handleSimpleResponse(resp *protocol.Response, err error, jsonOut bool) {
	if err != nil {
		outputError(err, jsonOut)
		os.Exit(1)
	}
	if !resp.Success {
		outputError(fmt.Errorf("%s", resp.Error), jsonOut)
		os.Exit(1)
	}
	if jsonOut {
		printJSON(resp)
	} else {
		if resp.Message != "" {
			fmt.Printf("✓ %s\n", resp.Message)
		}
		if resp.Data != nil {
			printJSON(resp.Data)
		} else if resp.Results != nil {
			printJSON(resp.Results)
		}
	}
}

func printStateHuman(resp *protocol.Response) {
	if !resp.Success {
		fmt.Printf("Error inspecting page: %s\n", resp.Error)
		return
	}

	stateBytes, _ := json.Marshal(resp.Data)
	var state protocol.PageState
	_ = json.Unmarshal(stateBytes, &state)

	fmt.Println("==================================================")
	fmt.Printf("Exercise Type : %s\n", strings.ToUpper(state.ExerciseType))
	if state.Prompt != "" {
		fmt.Printf("Prompt        : %s\n", state.Prompt)
	}
	if len(state.ContextText) > 0 {
		fmt.Printf("Context       : %s\n", strings.Join(state.ContextText, " | "))
	}
	if state.Feedback != "" {
		fmt.Printf("Feedback      : %s\n", state.Feedback)
	}
	fmt.Printf("Can Proceed   : %v (Next ID: %s)\n", state.CanProceed, state.NextButtonID)
	if state.Video.HasVideo || state.Video.HasAudio {
		fmt.Printf("Media Status  : Playing=%v, Time=%.1fs/%.1fs\n",
			state.Video.IsPlaying, state.Video.CurrentTime, state.Video.Duration)
	}
	fmt.Println("--------------------------------------------------")
	fmt.Printf("Interactive Elements (%d):\n", len(state.Elements))
	for _, el := range state.Elements {
		flags := ""
		if el.Selected {
			flags += " [SELECTED]"
		}
		if el.Disabled {
			flags += " [DISABLED]"
		}
		fmt.Printf(" • %-10s [%-11s] (%4d,%4d) \"%s\"%s\n", el.ID, el.Type, el.X, el.Y, el.Text, flags)
	}
	fmt.Println("==================================================")
}

func printJSON(v interface{}) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func outputError(err error, jsonOut bool) {
	if jsonOut {
		printJSON(map[string]interface{}{"success": false, "error": err.Error()})
	} else {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
	}
}
