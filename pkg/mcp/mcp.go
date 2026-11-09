package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"

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
	// Allow up to 10MB messages
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

		// Notifications have no ID and expect no response
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
					"version": "2.0.0",
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
			"description": "Inspect the current learn.better.efekta.com lesson page. Returns exerciseType (multiple_choice, fill_in_the_blanks, order_sentence, categorize_columns, speaking_avatar), prompt, contextText with inline [input-N]/[slot-N] markers, feedback, video status, canProceed flag, and all interactive elements with virtual IDs (opt-1, item-1, slot-1, input-1, next-1, mic-1, stage-1).",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
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
						"description": "Element virtual ID (e.g. opt-1, next-1), CSS selector, or x,y coordinates",
					},
				},
				"required": []string{"target"},
			},
		},
		{
			"name":        "efekta_drag",
			"description": "Drag a word/card/block (e.g. 'item-1') to a target slot or category column (e.g. 'slot-1'). Wait ~300ms between categorization drags so Efekta's UI commits the card.",
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
			"description": "Type text into a fill-in-the-blank input or contenteditable gap (e.g. 'input-1'). Wait ~300ms between filling multiple inputs so Efekta does not reset progress.",
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
			"name":        "efekta_wait",
			"description": "Wait for a condition ('video-end' to wait until AI video avatar finishes talking, 'next' to wait until Next button unlocks, or milliseconds like '500').",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"condition": map[string]interface{}{
						"type":        "string",
						"description": "'video-end', 'next', or duration in milliseconds (e.g. '500')",
					},
				},
				"required": []string{"condition"},
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
	case "efekta_wait":
		cmd = protocol.Command{Action: "wait", Target: strArg("condition")}
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
	default:
		return fmt.Sprintf("Unknown tool: %s", params.Name), true
	}

	resp, err := execFn(cmd)
	if err != nil {
		return fmt.Sprintf("Error: %v", err), true
	}
	b, _ := json.MarshalIndent(resp, "", "  ")
	return string(b), !resp.Success
}
