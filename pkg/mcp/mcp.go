package mcp

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

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
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}

		if len(req.ID) == 0 || string(req.ID) == "null" {
			continue
		}

		resp := handleRPC(req, execFn)
		_ = enc.Encode(resp)
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
					"version": "2.2.0",
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
			"description": "Inspect the current learn.better.efekta.com lesson page. Returns exerciseType (multiple_choice, fill_in_the_blanks, order_sentence, categorize_columns, speaking_avatar), prompt, contextText with inline [input-N]/[slot-N] markers, feedback, video status, canProceed flag, and agentHint with pre-built actions.",
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
						"description": "'down', 'up', or pixel amount (e.g. '400')",
					},
				},
				"required": []string{"direction"},
			},
		},
		{
			"name":        "efekta_wait",
			"description": "Wait for a condition ('video-end' to wait until AI video avatar finishes talking, 'next' to wait until Next button unlocks, or milliseconds like '350').",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"condition": map[string]interface{}{
						"type":        "string",
						"description": "'video-end', 'next', or duration in milliseconds (e.g. '350')",
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
			"name":        "efekta_batch",
			"description": "Execute a semicolon-separated sequence of Turbo commands in one roundtrip and return the new page state. Supports: 'pick opt-1,opt-3', 'pair slot-1:item-3, slot-2:item-1', 'sort slot-1:item-1,item-2', 'gaps word1, word2, word3', 'speak all', 'next' (auto-fast-forwards through passive screens), plus click, drag, type, press, scroll, wait, solve.",
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
			"description": "Run built-in smart solver for Efekta exercises: 'choice' (brute-forces multiple choice options until next unlocks), 'sentence' (analyzes word ordering using capital first letter / 'I' rule and ending punctuation .?!), or 'speak' (waits for video avatar to finish talking, then injects 3 synthetic speech attempts to unlock manual text choices).",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"strategy": map[string]interface{}{
						"type":        "string",
						"enum":        []string{"choice", "sentence", "speak"},
						"description": "Solver strategy to execute: choice | sentence | speak",
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
						"description": "File path to save the PNG screenshot (default: /tmp/efekta_screenshot.png)",
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
	case "efekta_click":
		cmd = protocol.Command{Action: "click", Target: strArg("target")}
	case "efekta_drag":
		cmd = protocol.Command{Action: "drag", Source: strArg("source"), Target: strArg("target")}
	case "efekta_type":
		cmd = protocol.Command{Action: "type", Target: strArg("target"), Text: strArg("text")}
	case "efekta_press":
		cmd = protocol.Command{Action: "press", Target: strArg("key")}
	case "efekta_scroll":
		dir := strArg("direction")
		amt := 400
		if n, err := strconv.Atoi(dir); err == nil {
			amt = n
			dir = "down"
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
		cmd = protocol.Command{Action: "batch", Commands: subCmds}
	case "efekta_solve":
		strat := strArg("strategy")
		switch strat {
		case "sentence", "order":
			cmd = protocol.Command{Action: "solve_sentence"}
		case "speak", "voice":
			cmd = protocol.Command{Action: "skip_speaking"}
		default:
			cmd = protocol.Command{Action: "solve_choice"}
		}
	case "efekta_screenshot":
		outPath := strArg("outputPath")
		if outPath == "" {
			outPath = filepath.Join(os.TempDir(), "efekta_screenshot.png")
		}
		resp, err := execFn(protocol.Command{Action: "screenshot"})
		if err != nil {
			return fmt.Sprintf("Error: %v", err), true
		}
		if !resp.Success {
			return fmt.Sprintf("Error: %s", resp.Error), true
		}
		dataMap, ok := resp.Data.(map[string]interface{})
		if !ok || dataMap["screenshotBase64"] == nil {
			return "Error: no screenshot data returned", true
		}
		imgBytes, err := base64.StdEncoding.DecodeString(fmt.Sprintf("%v", dataMap["screenshotBase64"]))
		if err != nil {
			return fmt.Sprintf("Error decoding screenshot: %v", err), true
		}
		if err := os.WriteFile(outPath, imgBytes, 0644); err != nil {
			return fmt.Sprintf("Error saving screenshot: %v", err), true
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
	compact := true
	if v, ok := params.Arguments["compact"]; ok {
		if b, ok := v.(bool); ok {
			compact = b
		}
	}
	if compact && resp != nil && resp.Data != nil {
		if m, ok := resp.Data.(map[string]interface{}); ok {
			delete(m, "elements")
		}
	}
	b, _ := json.MarshalIndent(resp, "", "  ")
	return string(b), !resp.Success
}
