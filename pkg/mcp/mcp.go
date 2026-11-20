package mcp

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"efekta-cli/pkg/protocol"
)

// CommandExecutor is a callback that executes a protocol.Command via the daemon
type CommandExecutor func(cmd protocol.Command) (*protocol.Response, error)

// JSON-RPC 2.0 types for Model Context Protocol (MCP)
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type toolCallParams struct {
	Name      string                 `json:"name"`
	Arguments map[string]interface{} `json:"arguments"`
}

// ServeStdio runs a standard MCP (Model Context Protocol) server over stdin/stdout
func ServeStdio(execFn CommandExecutor) error {
	return ServeStream(os.Stdin, os.Stdout, execFn)
}

// ServeStream runs the MCP loop on arbitrary io.Reader / io.Writer (testable)
func ServeStream(in io.Reader, out io.Writer, execFn CommandExecutor) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 10*1024*1024)
	enc := json.NewEncoder(out)

	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}

		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			_ = enc.Encode(rpcResponse{
				JSONRPC: "2.0",
				ID:      json.RawMessage("null"),
				Error:   &rpcError{Code: -32700, Message: "Parse error: " + err.Error()},
			})
			continue
		}

		trimmedID := bytes.TrimSpace(req.ID)
		if len(trimmedID) == 0 || string(trimmedID) == "null" {
			continue
		}
		req.ID = trimmedID

		resp := handleRPC(req, execFn)
		if err := enc.Encode(resp); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func handleRPC(req rpcRequest, execFn CommandExecutor) rpcResponse {
	switch req.Method {
	case "initialize":
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"protocolVersion": "2024-11-05",
				"capabilities": map[string]interface{}{
					"tools": map[string]interface{}{},
				},
				"serverInfo": map[string]interface{}{
					"name":    "efekta-cli-mcp",
					"version": "3.0.0",
				},
			},
		}

	case "ping":
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]interface{}{},
		}

	case "tools/list":
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"tools": getToolDefinitions(),
			},
		}

	case "tools/call":
		var params toolCallParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return rpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   &rpcError{Code: -32602, Message: "Invalid tool call params: " + err.Error()},
			}
		}
		res, isErr := executeTool(params, execFn)
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"content": []map[string]interface{}{
					{
						"type": "text",
						"text": res,
					},
				},
				"isError": isErr,
			},
		}

	default:
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32601, Message: "Method not found: " + req.Method},
		}
	}
}

func getToolDefinitions() []map[string]interface{} {
	return []map[string]interface{}{
		{
			"name":        "efekta_status",
			"description": "Inspect the current learn.better.efekta.com lesson page. Returns exerciseType (multiple_choice, progress_test_choice, selection_gaps, fill_in_the_blanks, matching_pairs, categorize_columns, order_sentence, order_dialogue, writing_essay, speaking_practice, speaking_avatar, video_stage, passive_screen, lesson_overview, lesson_completed, human_verification_required), prompt, contextText with inline [input-N]/[slot-N] markers, feedback, video status, canProceed flag, and agentHint.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"compact": map[string]interface{}{
						"type":        "boolean",
						"description": "Strip verbose coordinate dump (elements) to save 80% tokens, leaving agentHint, prompt, and state (default: true)",
					},
				},
			},
		},
		{
			"name":        "efekta_next",
			"description": "Auto-advance and fast-forward through consecutive passive screens (reading cards, 'Correct answers' reviews, 'Step passed!' celebrations, Lesson Overviews) until the next interactive exercise.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"compact": map[string]interface{}{
						"type":        "boolean",
						"description": "Strip verbose coordinate dump to save 80% tokens (default: true)",
					},
				},
			},
		},
		{
			"name":        "efekta_autopilot",
			"description": "BEST FIRST CHOICE inside a lesson. Autonomously handles lesson overview, reading cards, videos, summaries, self-evaluation, regular multiple choice, selection gaps, categorize columns, matching pairs, order_dialogue, order_sentence, table word-family blanks, essays, avatar dialogues, early >50% step-summary skipping, and optional pronunciation drills (skipped unless speak=true). Automatically stops with needsAgent=true on Progress Tests (progress_test_choice). After answering, call it again (or end a batch with '; auto').",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"maxSteps": map[string]interface{}{"type": "integer", "description": "Step budget (default 40)"},
					"speak":    map[string]interface{}{"type": "boolean", "description": "Really speak pronunciation drills instead of skipping optional ones"},
					"compact":  map[string]interface{}{"type": "boolean", "description": "Strip coordinate dump (default: true)"},
				},
			},
		},
		{
			"name":        "efekta_dialogue",
			"description": "Answer an AI-avatar dialogue (options A/B/C) end to end: waits for the avatar, speaks the chosen option via the Voice Engine, clicks Next, repeats for every turn, handles 'Finish skipped tasks'. Optional picks choose per-turn options (e.g. 'B,C,A' or 'opt-2,opt-1'); turns without a pick use a heuristic. Add 'once' to answer a single turn and read the next options first.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"picks":   map[string]interface{}{"type": "string", "description": "Per-turn choices, e.g. 'B,C,A' (optional). Append ' once' for one turn only."},
					"compact": map[string]interface{}{"type": "boolean", "description": "Strip coordinate dump (default: true)"},
				},
			},
		},
		{
			"name":        "efekta_click",
			"description": "Click an interactive element on Efekta by virtual ID (e.g. 'opt-1', 'next-1', 'stage-4'), CSS selector, exact text, or 'x,y' coordinates.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"target": map[string]interface{}{
						"type":        "string",
						"description": "Element virtual ID (e.g. opt-1, next-1), CSS selector, text, or x,y coordinates",
					},
				},
				"required": []string{"target"},
			},
		},
		{
			"name":        "efekta_drag",
			"description": "Drag a word/card/block (e.g. 'item-1') to a target slot or category column (e.g. 'slot-1'). Wait ~450ms between categorization drags so Efekta's UI commits the card.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"source": map[string]interface{}{
						"type":        "string",
						"description": "Source draggable virtual ID (e.g. item-1)",
					},
					"target": map[string]interface{}{
						"type":        "string",
						"description": "Target slot/column virtual ID (e.g. slot-1)",
					},
				},
				"required": []string{"source", "target"},
			},
		},
		{
			"name":        "efekta_type",
			"description": "Type text into a fill-in-the-blank input or contenteditable gap (e.g. 'input-1'). Wait ~350ms between filling multiple inputs so Efekta does not reset progress.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"target": map[string]interface{}{
						"type":        "string",
						"description": "Target input virtual ID (e.g. input-1)",
					},
					"text": map[string]interface{}{
						"type":        "string",
						"description": "Text to type into the blank",
					},
				},
				"required": []string{"target", "text"},
			},
		},
		{
			"name":        "efekta_press",
			"description": "Press a special keyboard key on the Efekta page (Enter, Escape, Backspace, Tab, Space, ArrowRight, ArrowLeft).",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"key": map[string]interface{}{
						"type":        "string",
						"description": "Key name (e.g. Enter, Backspace, Escape, Tab, Space)",
					},
				},
				"required": []string{"key"},
			},
		},
		{
			"name":        "efekta_scroll",
			"description": "Scroll the Efekta page up, down, or by a pixel offset.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"direction": map[string]interface{}{
						"type":        "string",
						"description": "'down', 'up', 'up 600', or pixel amount (e.g. '400')",
					},
					"amount": map[string]interface{}{
						"type":        "integer",
						"description": "Optional pixel offset (default: 400)",
					},
				},
				"required": []string{"direction"},
			},
		},
		{
			"name":        "efekta_wait",
			"description": "Wait for a condition ('video-end' to wait until AI video avatar finishes talking, 'next' to wait until Next button unlocks, 'unlocked' to clear cooldown locks, or duration like '350', '350ms', '2s').",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"condition": map[string]interface{}{
						"type":        "string",
						"description": "'video-end', 'next', 'unlocked', or duration (e.g. '350', '1500ms', '2s')",
					},
				},
				"required": []string{"condition"},
			},
		},
		{
			"name":        "efekta_eval",
			"description": "Query DOM elements on the Efekta page by CSS selector and return their tag, virtual ID, className, and text.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"selector": map[string]interface{}{
						"type":        "string",
						"description": "CSS selector to query (e.g. '[class*=lesson]')",
					},
				},
				"required": []string{"selector"},
			},
		},
		{
			"name":        "efekta_speak",
			"description": "Speak English phrase(s) into the Efekta microphone using native reference audio loopback ('Play audio') or synthesized English TTS via Voice Engine v3 (one-shot armed so the user's real microphone stays untouched). Pass 'all' to complete an entire multi-phrase speaking drill.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"text": map[string]interface{}{
						"type":        "string",
						"description": "'all' (default) to speak target phrase(s) automatically, or custom English text to speak",
					},
				},
			},
		},
		{
			"name":        "efekta_essay",
			"description": "Auto-write or submit an 80+ word formal email or essay, submit it into textarea, and auto-advance through the self-evaluation screen.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"text": map[string]interface{}{
						"type":        "string",
						"description": "Custom essay text or 'auto' (default) to auto-generate a fluent B2 formal email addressing all prompt bullet points",
					},
					"compact": map[string]interface{}{"type": "boolean", "description": "Strip coordinate dump (default: true)"},
				},
			},
		},
		{
			"name":        "efekta_sequence",
			"description": "Auto-order tokens in a tap-sequencing task (ef-sequencing-tap-option-task). Resets canvas if needed, clicks pool tokens in sequence, and checks.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"tokens": map[string]interface{}{
						"type":        "string",
						"description": "Target sentence, comma-separated tokens, or 'auto' (default) to sequence with capitalization & punctuation heuristics",
					},
					"compact": map[string]interface{}{"type": "boolean", "description": "Strip coordinate dump (default: true)"},
				},
			},
		},
		{
			"name":        "efekta_lesson",
			"description": "Select, list, or start a lesson autonomously. Pass 'next' (or leave empty) to start the next incomplete lesson, 'list' to view all units & lessons with completion status, or pass a lesson identifier (e.g. 'U1L2', '1.2', 'Ordering a meal', 'close', 'resume').",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"target": map[string]interface{}{
						"type":        "string",
						"description": "Lesson target: 'next' (default), 'list', unit/lesson code like 'U1L1', 'U1L2', title keyword like 'reservation', 'resume', or 'close'",
					},
					"compact": map[string]interface{}{"type": "boolean", "description": "Strip coordinate dump (default: true)"},
				},
			},
		},
		{
			"name":        "efekta_batch",
			"description": "Execute a semicolon-separated sequence of Turbo commands in one roundtrip and return the new page state. Supports: 'lesson U2L1; auto' (cross-frame launch + autopilot), 'pick opt-1,opt-3', 'pair slot-1:item-3, slot-2:item-1', 'sort slot-1:item-1,item-2', 'gaps word1, word2', 'sequence auto', 'essay', 'dialogue', 'speak all', 'skip', 'next', plus click, drag, type, press, scroll, wait (supports ms/s and conditions), eval, and solve.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"commands": map[string]interface{}{
						"type":        "string",
						"description": "Semicolon-separated command chain (always end with '; next' to auto-advance!)",
					},
					"compact": map[string]interface{}{
						"type":        "boolean",
						"description": "Strip verbose coordinate dump (elements) to save 80% tokens, leaving agentHint, prompt, and state (default: true)",
					},
				},
				"required": []string{"commands"},
			},
		},
		{
			"name":        "efekta_solve",
			"description": "Run built-in smart solver for Efekta exercises (blocked on Progress Tests to protect exam score): 'auto' (solves current exercise automatically), 'choice' (multiple choice), 'gaps' (selection gaps & blanks), 'sort' (category columns), 'pair' (matching pairs), 'order' (dialogue/item ordering), 'sentence' (word ordering), or 'speak' (pronunciation drills).",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"strategy": map[string]interface{}{
						"type":        "string",
						"enum":        []string{"auto", "choice", "gaps", "sort", "pair", "order", "sentence", "speak"},
						"description": "Solver strategy to execute: auto | choice | gaps | sort | pair | order | sentence | speak",
					},
				},
				"required": []string{"strategy"},
			},
		},
		{
			"name":        "efekta_screenshot",
			"description": "Capture a lossless PNG screenshot of the Efekta browser tab and save it to disk.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"outputPath": map[string]interface{}{
						"type":        "string",
						"description": "File path to save the PNG screenshot (default: system temp directory / efekta_screenshot.png)",
					},
				},
			},
		},
	}
}

func executeTool(params toolCallParams, execFn CommandExecutor) (string, bool) {
	strArg := func(k string) string {
		if v, ok := params.Arguments[k]; ok && v != nil {
			return fmt.Sprintf("%v", v)
		}
		return ""
	}

	var cmd protocol.Command
	switch params.Name {
	case "efekta_status":
		cmd = protocol.Command{Action: "status"}
	case "efekta_next":
		cmd = protocol.Command{Action: "next"}
	case "efekta_autopilot":
		t := ""
		if n, ok := params.Arguments["maxSteps"].(float64); ok && n > 0 {
			t = strconv.Itoa(int(n))
		}
		if b, ok := params.Arguments["speak"].(bool); ok && b {
			t = strings.TrimSpace(t + " speak")
		}
		cmd = protocol.Command{Action: "autopilot", Target: t}
	case "efekta_dialogue":
		cmd = protocol.Command{Action: "dialogue", Target: strArg("picks")}
	case "efekta_click":
		cmd = protocol.Command{Action: "click", Target: strArg("target")}
	case "efekta_drag":
		cmd = protocol.Command{Action: "drag", Source: strArg("source"), Target: strArg("target")}
	case "efekta_type":
		cmd = protocol.Command{Action: "type", Target: strArg("target"), Text: strArg("text")}
	case "efekta_press":
		cmd = protocol.Command{Action: "press", Target: strArg("key")}
	case "efekta_scroll":
		rawDir := strings.TrimSpace(strArg("direction"))
		dir := "down"
		amt := 400
		if n, ok := params.Arguments["amount"].(float64); ok && n != 0 {
			amt = int(n)
		}
		fields := strings.Fields(rawDir)
		if len(fields) >= 1 {
			first := strings.ToLower(fields[0])
			if first == "up" || first == "down" {
				dir = first
				if len(fields) >= 2 {
					if n, err := strconv.Atoi(fields[1]); err == nil {
						amt = n
					}
				}
			} else if n, err := strconv.Atoi(first); err == nil {
				amt = n
			}
		}
		cmd = protocol.Command{Action: "scroll", Direction: dir, Amount: amt}
	case "efekta_wait":
		cmd = protocol.Command{Action: "wait", Target: strArg("condition")}
	case "efekta_eval":
		cmd = protocol.Command{Action: "eval", Target: strArg("selector")}
	case "efekta_speak":
		txt := strArg("text")
		if txt == "" {
			txt = "all"
		}
		cmd = protocol.Command{Action: "speak", Target: txt}
	case "efekta_batch":
		subCmds := protocol.ParseBatchString(strArg("commands"))
		if len(subCmds) == 0 {
			return "Error: no valid commands parsed from batch string", true
		}
		cmd = protocol.Command{Action: "batch", Commands: subCmds}
	case "efekta_essay":
		txt := strArg("text")
		if txt == "" {
			txt = "auto"
		}
		cmd = protocol.Command{Action: "essay", Target: txt}
	case "efekta_sequence":
		tokens := strArg("tokens")
		if tokens == "" {
			tokens = "auto"
		}
		cmd = protocol.Command{Action: "sequence", Target: tokens}
	case "efekta_lesson":
		target := strArg("target")
		if target == "" {
			target = "next"
		}
		cmd = protocol.Command{Action: "lesson", Target: target}
	case "efekta_solve":
		strat := strings.ToLower(strings.TrimSpace(strArg("strategy")))
		switch strat {
		case "choice", "multiple_choice":
			cmd = protocol.Command{Action: "solve_choice"}
		case "gaps", "fill", "selection_gaps", "fill_in_the_blanks":
			cmd = protocol.Command{Action: "solve_gaps"}
		case "sort", "categorize", "categorize_columns":
			cmd = protocol.Command{Action: "solve_sort"}
		case "pair", "match", "matching_pairs":
			cmd = protocol.Command{Action: "solve_pair"}
		case "order", "order_dialogue", "sequencing":
			cmd = protocol.Command{Action: "solve_order"}
		case "sentence":
			cmd = protocol.Command{Action: "solve_sentence"}
		case "speak", "voice", "dialog", "skip":
			cmd = protocol.Command{Action: "skip_speaking"}
		case "auto", "all":
			cmd = protocol.Command{Action: "solve_auto"}
		default:
			return fmt.Sprintf("Error: unknown solve strategy %q (valid: auto | choice | gaps | sort | pair | order | sentence | speak)", strat), true
		}
	case "efekta_screenshot":
		outPath := strings.TrimSpace(strArg("outputPath"))
		resp, err := execFn(protocol.Command{Action: "screenshot"})
		if err != nil {
			return fmt.Sprintf("Error: %v", err), true
		}
		if resp == nil {
			return "Error: empty response from daemon", true
		}
		if !resp.Success {
			return fmt.Sprintf("Error: %s", resp.Error), true
		}
		dataMap, ok := resp.Data.(map[string]interface{})
		if !ok {
			return "Error: no screenshot data returned", true
		}
		b64Str, ok := dataMap["screenshotBase64"].(string)
		if !ok || b64Str == "" {
			return "Error: no screenshot data returned", true
		}
		imgBytes, err := base64.StdEncoding.DecodeString(b64Str)
		if err != nil {
			return fmt.Sprintf("Error decoding screenshot: %v", err), true
		}
		if outPath == "" {
			tmpFile, err := os.CreateTemp("", "efekta_screenshot_*.png")
			if err != nil {
				return fmt.Sprintf("Error creating temp screenshot: %v", err), true
			}
			outPath = tmpFile.Name()
			if _, writeErr := tmpFile.Write(imgBytes); writeErr != nil {
				_ = tmpFile.Close()
				_ = os.Remove(outPath)
				return fmt.Sprintf("Error saving screenshot: %v", writeErr), true
			}
			if closeErr := tmpFile.Close(); closeErr != nil {
				return fmt.Sprintf("Error closing screenshot: %v", closeErr), true
			}
		} else {
			if err := os.WriteFile(outPath, imgBytes, 0600); err != nil {
				return fmt.Sprintf("Error saving screenshot: %v", err), true
			}
		}
		b, _ := json.MarshalIndent(map[string]interface{}{
			"success": true,
			"path":    outPath,
			"bytes":   len(imgBytes),
		}, "", "  ")
		return string(b), false
	default:
		return fmt.Sprintf("Unknown tool: %s", params.Name), true
	}

	resp, err := execFn(cmd)
	if err != nil {
		return fmt.Sprintf("Error: %v", err), true
	}
	if resp == nil {
		return "Error: empty response from daemon", true
	}
	compact := true
	if v, ok := params.Arguments["compact"]; ok {
		if b, ok := v.(bool); ok {
			compact = b
		}
	}
	if compact && resp.Data != nil {
		if m, ok := resp.Data.(map[string]interface{}); ok {
			delete(m, "elements")
		}
	}
	b, _ := json.MarshalIndent(resp, "", "  ")
	return string(b), !resp.Success
}
