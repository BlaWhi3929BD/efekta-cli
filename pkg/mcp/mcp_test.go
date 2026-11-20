package mcp

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"runtime"
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
	if len(tools) != 18 {
		t.Errorf("expected 18 MCP tools, got %d", len(tools))
	}
}

func TestMCPEdgeCasesAndValidation(t *testing.T) {
	inputLines := []string{
		`{bad json`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"efekta_batch","arguments":{"commands":""}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"efekta_solve","arguments":{"strategy":"bogus"}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"efekta_scroll","arguments":{"direction":"UP 650"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"efekta_status","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"efekta_screenshot","arguments":{}}}`,
	}

	var executed []protocol.Command
	mockExec := func(cmd protocol.Command) (*protocol.Response, error) {
		executed = append(executed, cmd)
		if cmd.Action == "status" {
			return nil, nil // test nil response guard
		}
		if cmd.Action == "screenshot" {
			return &protocol.Response{
				Success: true,
				Data: map[string]interface{}{
					"screenshotBase64": base64.StdEncoding.EncodeToString([]byte("PNGDATA")),
				},
			}, nil
		}
		return &protocol.Response{Success: true, Message: "ok"}, nil
	}

	var out bytes.Buffer
	if err := ServeStream(strings.NewReader(strings.Join(inputLines, "\n")+"\n"), &out, mockExec); err != nil {
		t.Fatalf("ServeStream failed: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 6 {
		t.Fatalf("expected 6 JSON-RPC responses (including parse error), got %d:\n%s", len(lines), out.String())
	}

	// Response 0: JSON-RPC -32700 parse error
	var parseResp map[string]interface{}
	_ = json.Unmarshal([]byte(lines[0]), &parseResp)
	errObj, _ := parseResp["error"].(map[string]interface{})
	if errObj == nil || int(errObj["code"].(float64)) != -32700 {
		t.Errorf("expected -32700 parse error, got: %s", lines[0])
	}

	// Response 1 (empty batch) & 2 (invalid solve): must be isError=true and NOT call mockExec
	for _, idx := range []int{1, 2, 4} {
		var r map[string]interface{}
		_ = json.Unmarshal([]byte(lines[idx]), &r)
		res := r["result"].(map[string]interface{})
		if res["isError"] != true {
			t.Errorf("expected isError=true for response %d, got: %s", idx, lines[idx])
		}
	}

	// Scroll command should have parsed UP 650 properly
	if len(executed) != 3 {
		t.Fatalf("expected 3 executed commands (scroll, status, screenshot), got %d: %+v", len(executed), executed)
	}
	if executed[0].Action != "scroll" || executed[0].Direction != "up" || executed[0].Amount != 650 {
		t.Errorf("unexpected scroll command: %+v", executed[0])
	}

	// Screenshot should create a unique temp file with restrictive permissions
	var shotResp map[string]interface{}
	_ = json.Unmarshal([]byte(lines[5]), &shotResp)
	shotRes := shotResp["result"].(map[string]interface{})
	if shotRes["isError"] != false {
		t.Fatalf("screenshot failed: %s", lines[5])
	}
	content := shotRes["content"].([]interface{})[0].(map[string]interface{})["text"].(string)
	var payload map[string]interface{}
	_ = json.Unmarshal([]byte(content), &payload)
	pathStr, _ := payload["path"].(string)
	if pathStr == "" {
		t.Fatalf("expected non-empty screenshot path: %s", content)
	}
	defer os.Remove(pathStr)
	info, err := os.Stat(pathStr)
	if err != nil {
		t.Fatalf("screenshot file missing: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		t.Errorf("expected private screenshot permissions (0600), got %o", info.Mode().Perm())
	}
}
