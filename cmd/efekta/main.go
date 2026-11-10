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

var localHTTPClient = &http.Client{
	Transport: &http.Transport{},
}

func isDaemonRunning() bool {
	resp, err := localHTTPClient.Get(HealthURL)
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

	req, err := http.NewRequest(http.MethodPost, ApiURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(daemon.ClientHeader, daemon.ClientValue)

	httpResp, err := localHTTPClient.Do(req)
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
	return protocol.ParseBatchString(batchStr)
}

func printHelp() {
	fmt.Println(`efekta v3.0 (Turbo + Voice Engine) - Ultra-fast CLI & MCP Server for learn.better.efekta.com

USAGE:
  efekta <command> [arguments] [flags]

TURBO MACRO COMMANDS (1-Command-Per-Screen):
  next / ff                    Auto-advance & fast-forward through all passive/reading/summary/eval screens
  auto / autopilot             Autonomous progression (auto-solves multiple choice, skips drills, navigates passive screens)
  skip                         Skip all remaining phrases in a pronunciation drill in 1 shot & advance
  pick <id1,id2,...>           Click 1 or more options/tokens with auto-unlock wait (e.g. pick opt-1,opt-3)
  pair "<slot:item, ...>"      Match all left:right pairs in 1 roundtrip (e.g. pair "slot-1:item-3, slot-2:item-1")
  sort "<slot:item1,item2>"    Sort items into categories (immune to DOM removal across batch steps)
  gaps "<word1, word2, ...>"   Fill selection-gap drawers or text blanks in order (auto-opens drawers)
  speak [all|"<phrase>"]       Speak target English phrase(s) via native reference audio loopback or TTS!
  dialogue [picks]             Conduct multi-turn AI avatar dialogues (handles speech & tap turns)
  essay ["<text>"]             Auto-write or type 80+ word formal essay/email, submit & pass evaluation
  sequence ["<words>"]         Auto-order tokens in tap-sequencing task, reset if needed & advance
  lesson [next|list|<id>]      Select and start lesson autonomously (e.g. lesson next, lesson list, lesson U1L2)
  batch "<cmd1>; <cmd2>; next" Execute full exercise + auto-advance in a single roundtrip!

CORE COMMANDS:
  state / status               Inspect page: exerciseType, agentHint, prompt, contextText & element IDs
  click <target>               Click element by virtual ID (opt-1, next-1), comma list, CSS selector, or text
  drag <source> <target>       Drag element (item-1) to target slot/column (slot-1)
  type <target> "<text>"       Type text into input/blank (instant bulk-fill for long essays)
  press <key>                  Press keyboard key (Enter, Backspace, Escape, Tab, Space)
  scroll <up|down|pixels>      Scroll page smoothly
  wait <ms|video-end|next>     Wait for milliseconds, avatar video end, or Next button unlock
  eval "<css_selector>"        Inspect matching DOM elements by CSS selector
  screen [-o file.png]         Capture lossless PNG screenshot of the Efekta tab
  solve <strategy>             Run smart solver: choice | sentence | speak
  voice [status|disarm|events] Inspect Voice Engine v3 status or disarm microphone override
  reload [all|ext|tab]         Reload browser extension and/or Efekta tab

AI & SYSTEM COMMANDS:
  guide                        Print the Genius 1-Look AI Agent Decision Matrix & Playbook
  mcp                          Start Model Context Protocol (MCP) JSON-RPC 2.0 server over stdio
  daemon [run|stop|status]     Manage background WebSocket daemon (auto-starts on any command)

FLAGS:
  --json                       Output machine-readable JSON (recommended for AI agents)
  -c, --compact                Strip raw elements list from JSON (keeps agentHint & context, saves 80% tokens)
  -o, --output <path>          File output path (for screen)

TURBO EXAMPLES:
  efekta next --json -c
  efekta batch "pick opt-1,opt-3; next" --json -c
  efekta batch "pair slot-1:item-3, slot-2:item-1, slot-3:item-2; next" --json -c
  efekta batch "sort slot-1:item-1,item-3; sort slot-2:item-2,item-4; next" --json -c
  efekta batch "gaps wait, better, time, lifestyle, yourself; next" --json -c
  efekta batch "speak all; next" --json -c`)
}

func printAgentGuide() {
	fmt.Println(`# EFEKTA TURBO v3.0 AGENT GUIDE (1-COMMAND-PER-SCREEN PLAYBOOK)

## 0. THE 5 GOLDEN RULES (MEMORIZE THESE!)
1. **LET THE PROGRAM DO THE WORK FIRST ('efekta auto'):**
   'efekta auto --json -c' autonomously navigates passive reading cards, auto-skips pronunciation drills, auto-solves multiple choice, conducts avatar dialogues, and submits essays. It only stops when human knowledge exercises ('gaps', 'sort', 'pair') need an answer!
2. **ALWAYS end every exercise batch with '; next' (or '; auto'):**
   Appending '; next' clicks Next AND automatically fast-forwards through all consecutive reading cards, "Correct answers" reviews, self-evaluations, "Step passed!" summaries, and Lesson Overviews until the next interactive exercise!
3. **ALWAYS read 'agentHint' first (use '--json -c' for 80% smaller output):**
   'agentHint' gives you 'exerciseType', 'slots', 'items', 'options' (pre-populated even on selection_gaps!), and a ready-to-fill 'actionTemplate'.
4. **SKIP MULTI-PHRASE PRONUNCIATION DRILLS IN 1 COMMAND ('efekta skip'):**
   Whenever a pronunciation drill appears in Stages 1–5, run 'efekta skip --json -c' to skip all phrases in 1 shot and advance.
5. **PROGRESS TEST MANDATE ("Take the final test") — ZERO TRIAL-AND-ERROR:**
   - TRIAL-AND-ERROR / BRUTE-FORCE ('solve choice') IS STRICTLY FORBIDDEN ON FORMAL TESTS!
   - On the Progress Test, every question is an unrepeatable formal assessment; incorrect choices directly degrade the certificate score below the mandatory 70% threshold.
   - The engine automatically detects Progress Tests and safely blocks brute-force solvers. Always analyze questions grammatically and submit with 'efekta batch "pick opt-X; next" --json -c'.

---

## 1. INSTANT DECISION MATRIX (SEE TYPE -> RUN 1 COMMAND)

| 'exerciseType' in State | Instant 1-Roundtrip Command | MCP Tool Equivalent |
| :--- | :--- | :--- |
| 'course_overview' / dashboard | 'efekta lesson next --json -c' | efekta_lesson(target="next") |
| 'passive_screen' / 'lesson_overview' | 'efekta next --json -c' (or 'efekta auto --json -c') | efekta_next() / efekta_autopilot() |
| 'multiple_choice' (regular lesson) | 'efekta batch "solve choice; next" --json -c' | efekta_solve(strategy="choice") |
| 'progress_test_choice' (Final Test) | 'efekta batch "pick opt-X; next" --json -c' (Analyze first!) | efekta_batch(commands="pick opt-X; next") |
| 'speaking_practice' (Stages 1–5 drill) | 'efekta skip --json -c' | efekta_solve(strategy="speak") |
| 'speaking_avatar' (AI video roleplay) | 'efekta batch "dialogue; next" --json -c' | efekta_dialogue() |
| 'selection_gaps' / 'fill_in_the_blanks' | 'efekta batch "gaps word1, word2, word3; next" --json -c' | efekta_batch(commands="gaps ...; next") |
| 'writing_essay' (80–120+ words) | 'efekta batch "essay; next" --json -c' | efekta_essay(text="auto") |
| 'matching_pairs' | 'efekta batch "pair slot-1:item-3, slot-2:item-1; next" --json -c' | efekta_batch(commands="pair ...; next") |
| 'categorize_columns' (sorting) | 'efekta batch "sort slot-1:item-1,item-4; sort slot-2:item-2; next" --json -c' | efekta_batch(commands="sort ...; next") |
| 'order_sentence' (tap sequence) | 'efekta batch "sequence auto; next" --json -c' | efekta_sequence(tokens="auto") |
| 'order_sentence' (token picker) | 'efekta batch "pick item-3,item-1,item-4,item-2; next" --json -c' | efekta_batch(commands="pick ...; next") |
| 'order_dialogue' (cdk-drag reordering) | 'efekta batch "drag item-2 item-1; next" --json -c' | efekta_batch(commands="drag ...; next") |

---

## 2. AUTONOMOUS LESSON NAVIGATION
  efekta lesson next --json -c       # Automatically find & start next incomplete lesson
  efekta lesson list --json -c       # View structured units, lessons & progress summary
  efekta lesson U3L1 --json -c       # Jump directly to Unit 3 Lesson 1
  efekta lesson TEST --json -c       # Jump directly to Final Progress Test
  efekta lesson resume --json -c     # Continue current in-progress lesson
  efekta lesson close --json -c      # Exit active lesson back to course overview`)
}

func stripFlags(args []string) []string {
	var clean []string
	for i := 0; i < len(args); i++ {
		if args[i] == "--json" || args[i] == "--compact" || args[i] == "-c" {
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

func applyCompactFilter(resp *protocol.Response, compact bool) {
	if !compact || resp == nil || resp.Data == nil {
		return
	}
	if dataMap, ok := resp.Data.(map[string]interface{}); ok {
		delete(dataMap, "elements")
	}
}

func main() {
	if len(os.Args) < 2 {
		printHelp()
		os.Exit(0)
	}

	jsonOutput := false
	compactOutput := false
	for _, arg := range os.Args[1:] {
		if arg == "--json" {
			jsonOutput = true
		}
		if arg == "--compact" || arg == "-c" {
			compactOutput = true
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
		applyCompactFilter(resp, compactOutput)
		if jsonOutput {
			printJSON(resp)
			return
		}
		printStateHuman(resp)

	case "next", "ff":
		hops := 9
		if len(posArgs) >= 2 {
			if n, err := strconv.Atoi(posArgs[1]); err == nil && n > 0 {
				hops = n
			}
		}
		resp, err := execCommand(protocol.Command{Action: "next", Amount: hops})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "pick":
		if len(posArgs) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: efekta pick <opt-1,opt-2,...>")
			os.Exit(1)
		}
		target := strings.Join(posArgs[1:], " ")
		resp, err := execCommand(protocol.Command{Action: "pick", Target: target})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "pair", "match":
		if len(posArgs) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: efekta pair \"slot-1:item-3, slot-2:item-1\"")
			os.Exit(1)
		}
		target := strings.Join(posArgs[1:], " ")
		resp, err := execCommand(protocol.Command{Action: "pair", Target: target})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "sort":
		if len(posArgs) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: efekta sort \"slot-1:item-1,item-2 | slot-2:item-3,item-4\"")
			os.Exit(1)
		}
		target := strings.Join(posArgs[1:], " ")
		resp, err := execCommand(protocol.Command{Action: "sort", Target: target})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "gaps", "fill":
		if len(posArgs) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: efekta gaps \"word1, word2, word3\"")
			os.Exit(1)
		}
		target := strings.Join(posArgs[1:], " ")
		resp, err := execCommand(protocol.Command{Action: "gaps", Target: target})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "speak", "say":
		target := "all"
		if len(posArgs) >= 2 {
			target = strings.Join(posArgs[1:], " ")
		}
		resp, err := execCommand(protocol.Command{Action: "speak", Target: target})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "dialogue", "avatar":
		target := ""
		if len(posArgs) >= 2 {
			target = strings.Join(posArgs[1:], " ")
		}
		resp, err := execCommand(protocol.Command{Action: "dialogue", Target: target})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "skip":
		resp, err := execCommand(protocol.Command{Action: "skip"})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "auto", "autopilot":
		target := ""
		if len(posArgs) >= 2 {
			target = strings.Join(posArgs[1:], " ")
		}
		resp, err := execCommand(protocol.Command{Action: "autopilot", Target: target})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "essay", "write":
		target := "auto"
		if len(posArgs) >= 2 {
			target = strings.Join(posArgs[1:], " ")
		}
		resp, err := execCommand(protocol.Command{Action: "essay", Target: target})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "sequence":
		target := "auto"
		if len(posArgs) >= 2 {
			target = strings.Join(posArgs[1:], " ")
		}
		resp, err := execCommand(protocol.Command{Action: "sequence", Target: target})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "lesson", "unit":
		target := "next"
		if len(posArgs) >= 2 {
			target = strings.Join(posArgs[1:], " ")
		}
		resp, err := execCommand(protocol.Command{Action: "lesson", Target: target})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "voice":
		target := "status"
		if len(posArgs) >= 2 {
			target = posArgs[1]
		}
		resp, err := execCommand(protocol.Command{Action: "voice", Target: target})
		handleSimpleResponse(resp, err, jsonOutput)

	case "reload":
		mode := "all"
		if len(posArgs) >= 2 {
			mode = strings.ToLower(posArgs[1])
		}
		switch mode {
		case "tab":
			resp, err := execCommand(protocol.Command{Action: "reload_tab"})
			handleSimpleResponse(resp, err, jsonOutput)
		case "ext", "extension":
			resp, err := execCommand(protocol.Command{Action: "reload_extension"})
			handleSimpleResponse(resp, err, jsonOutput)
		default:
			_, _ = execCommand(protocol.Command{Action: "reload_extension"})
			time.Sleep(700 * time.Millisecond)
			resp, err := execCommand(protocol.Command{Action: "reload_tab"})
			handleSimpleResponse(resp, err, jsonOutput)
		}

	case "click":
		if len(posArgs) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: efekta click <id|id1,id2|selector|x,y>")
			os.Exit(1)
		}
		target := strings.Join(posArgs[1:], " ")
		resp, err := execCommand(protocol.Command{Action: "click", Target: target})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "drag":
		if len(posArgs) < 3 {
			fmt.Fprintln(os.Stderr, "Usage: efekta drag <source_id> <target_id>")
			os.Exit(1)
		}
		resp, err := execCommand(protocol.Command{Action: "drag", Source: posArgs[1], Target: posArgs[2]})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "type":
		if len(posArgs) < 3 {
			fmt.Fprintln(os.Stderr, "Usage: efekta type <target_id> <text>")
			os.Exit(1)
		}
		text := strings.Join(posArgs[2:], " ")
		resp, err := execCommand(protocol.Command{Action: "type", Target: posArgs[1], Text: text})
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "press", "key":
		if len(posArgs) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: efekta press <Enter|Escape|Backspace|Tab|Space>")
			os.Exit(1)
		}
		resp, err := execCommand(protocol.Command{Action: "press", Target: posArgs[1]})
		applyCompactFilter(resp, compactOutput)
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
		applyCompactFilter(resp, compactOutput)
		handleSimpleResponse(resp, err, jsonOutput)

	case "wait", "sleep":
		cond := "200"
		if len(posArgs) >= 2 {
			cond = posArgs[1]
		}
		resp, err := execCommand(protocol.Command{Action: "wait", Target: cond})
		applyCompactFilter(resp, compactOutput)
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
			fmt.Fprintln(os.Stderr, "Usage: efekta batch \"pair slot-1:item-2, slot-2:item-1; next\"")
			os.Exit(1)
		}
		subCmds := ParseBatchString(posArgs[1])
		resp, err := execCommand(protocol.Command{Action: "batch", Commands: subCmds})
		applyCompactFilter(resp, compactOutput)
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
		applyCompactFilter(resp, compactOutput)
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
		resp, err := localHTTPClient.Get(HealthURL)
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
		if !isDaemonRunning() {
			daemon.RemovePID()
			fmt.Println("Daemon was not running (cleaned up stale PID file).")
			return
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
		if err != nil {
			daemon.RemovePID()
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
		errMsg := resp.Error
		if errMsg == "" {
			if resSlice, ok := resp.Results.([]interface{}); ok && len(resSlice) > 0 {
				for _, r := range resSlice {
					if rMap, ok := r.(map[string]interface{}); ok {
						if success, _ := rMap["success"].(bool); !success {
							if e, _ := rMap["error"].(string); e != "" {
								errMsg = e
								break
							}
							if m, _ := rMap["message"].(string); m != "" {
								errMsg = m
								break
							}
						}
					}
				}
			}
			if errMsg == "" && resp.Message != "" {
				errMsg = resp.Message
			}
			if errMsg == "" {
				errMsg = "Command execution failed"
			}
		}
		outputError(fmt.Errorf("%s", errMsg), jsonOut)
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
	if state.IsProgressTest {
		fmt.Printf("Exercise Type : %s [PROGRESS TEST - ZERO ERROR MANDATE]\n", strings.ToUpper(state.ExerciseType))
	} else {
		fmt.Printf("Exercise Type : %s\n", strings.ToUpper(state.ExerciseType))
	}
	if state.AgentHint != nil && state.AgentHint.ActionTemplate != "" {
		fmt.Printf("Turbo Command : %s\n", state.AgentHint.ActionTemplate)
	}
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
		fmt.Printf(" • %-10s [%-12s] (%4d,%4d) \"%s\"%s\n", el.ID, el.Type, el.X, el.Y, el.Text, flags)
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
