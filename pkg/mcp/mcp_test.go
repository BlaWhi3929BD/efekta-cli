package mcp

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"efekta-cli/pkg/protocol"
)

func TestMCPServeStream(t *testing.T) {
	inputLines := []string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"efekta_click","arguments":{"target":"opt-1"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"efekta_solve","arguments":{"strategy":"speak"}}}`,
	}

	in := strings.NewReader(strings.Join(inputLines, "\n") + "\n")
	var out bytes.Buffer

	var executed []protocol.Command
	mockExec := func(cmd protocol.Command) (*protocol.Response, error) {
		executed = append(executed, cmd)
		return &protocol.Response{
			Success: true,
			Message: "Executed " + cmd.Action,
		}, nil
	}

	if err := ServeStream(in, &out, mockExec); err != nil {
		t.Fatalf("ServeStream returned error: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	// 4 requests had IDs (1 notification had no ID)
	if len(lines) != 4 {
		t.Fatalf("expected 4 JSON-RPC responses, got %d:\n%s", len(lines), out.String())
	}

	if len(executed) != 2 {
		t.Fatalf("expected 2 tool executions, got %d", len(executed))
	}
	if executed[0].Action != "click" || executed[0].Target != "opt-1" {
		t.Errorf("unexpected first command: %+v", executed[0])
	}
	if executed[1].Action != "skip_speaking" {
		t.Errorf("unexpected second command: %+v", executed[1])
	}

	var listResp map[string]interface{}
	if err := json.Unmarshal([]byte(lines[1]), &listResp); err != nil {
		t.Fatalf("failed to parse tools/list response: %v", err)
	}
	resMap := listResp["result"].(map[string]interface{})
	tools := resMap["tools"].([]interface{})
	if len(tools) != 12 {
		t.Errorf("expected 12 MCP tools, got %d", len(tools))
	}
}
