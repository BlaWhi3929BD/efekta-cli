package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"efekta-cli/pkg/protocol"
)

func TestParseBatchString(t *testing.T) {
	input := `click "Start Lesson"; wait 120; drag item-1 slot-2; type input-1 "goes to work"; press Enter; scroll down; wait video-end; solve choice`
	cmds := ParseBatchString(input)

	if len(cmds) != 8 {
		t.Fatalf("expected 8 parsed batch commands, got %d: %+v", len(cmds), cmds)
	}

	if cmds[0].Action != "click" || cmds[0].Target != "Start Lesson" {
		t.Errorf("unexpected cmd[0]: %+v", cmds[0])
	}
	if cmds[1].Action != "sleep" || cmds[1].DelayMs != 120 {
		t.Errorf("unexpected cmd[1]: %+v", cmds[1])
	}
	if cmds[2].Action != "drag" || cmds[2].Source != "item-1" || cmds[2].Target != "slot-2" {
		t.Errorf("unexpected cmd[2]: %+v", cmds[2])
	}
	if cmds[3].Action != "type" || cmds[3].Target != "input-1" || cmds[3].Text != "goes to work" {
		t.Errorf("unexpected cmd[3]: %+v", cmds[3])
	}
	if cmds[4].Action != "press" || cmds[4].Target != "Enter" {
		t.Errorf("unexpected cmd[4]: %+v", cmds[4])
	}
	if cmds[5].Action != "scroll" || cmds[5].Direction != "down" {
		t.Errorf("unexpected cmd[5]: %+v", cmds[5])
	}
	if cmds[6].Action != "wait" || cmds[6].Target != "video-end" {
		t.Errorf("unexpected cmd[6]: %+v", cmds[6])
	}
	if cmds[7].Action != "solve_choice" {
		t.Errorf("unexpected cmd[7]: %+v", cmds[7])
	}
}

func TestParseTurboBatchCommands(t *testing.T) {
	input := `pick opt-1,opt-3; pair slot-1:item-3, slot-2:item-1; sort slot-1:item-1,item-2; gaps wait, better, time; essay auto; sequence First time; speak all; lesson U1L2; next`
	cmds := ParseBatchString(input)

	if len(cmds) != 9 {
		t.Fatalf("expected 9 turbo batch commands, got %d: %+v", len(cmds), cmds)
	}
	if cmds[0].Action != "pick" || cmds[0].Target != "opt-1,opt-3" {
		t.Errorf("unexpected pick cmd: %+v", cmds[0])
	}
	if cmds[1].Action != "pair" || cmds[1].Target != "slot-1:item-3, slot-2:item-1" {
		t.Errorf("unexpected pair cmd: %+v", cmds[1])
	}
	if cmds[2].Action != "sort" || cmds[2].Target != "slot-1:item-1,item-2" {
		t.Errorf("unexpected sort cmd: %+v", cmds[2])
	}
	if cmds[3].Action != "gaps" || cmds[3].Target != "wait, better, time" {
		t.Errorf("unexpected gaps cmd: %+v", cmds[3])
	}
	if cmds[4].Action != "essay" || cmds[4].Target != "auto" {
		t.Errorf("unexpected essay cmd: %+v", cmds[4])
	}
	if cmds[5].Action != "sequence" || cmds[5].Target != "First time" {
		t.Errorf("unexpected sequence cmd: %+v", cmds[5])
	}
	if cmds[6].Action != "speak" || cmds[6].Target != "all" {
		t.Errorf("unexpected speak cmd: %+v", cmds[6])
	}
	if cmds[7].Action != "lesson" || cmds[7].Target != "U1L2" {
		t.Errorf("unexpected lesson cmd: %+v", cmds[7])
	}
	if cmds[8].Action != "next" || cmds[8].Amount != 9 {
		t.Errorf("unexpected next cmd: %+v", cmds[8])
	}
}

func TestJoinCLIArgs(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "single quoted arg from cmd.exe",
			args: []string{"'pick", "opt-1;", "next'"},
			want: "pick opt-1; next",
		},
		{
			name: "double quoted single token",
			args: []string{"pick opt-1; next"},
			want: "pick opt-1; next",
		},
		{
			name: "unquoted multi-arg sequence",
			args: []string{"sequence", "First", "time.", "Yeah; next"},
			want: "sequence First time. Yeah; next",
		},
		{
			name: "preserves internal quotes without outer pair",
			args: []string{`sequence 'hi'; say 'bye'`},
			want: `sequence 'hi'; say 'bye'`,
		},
		{
			name: "preserves mismatched quote edges",
			args: []string{`sequence 'hi`},
			want: `sequence 'hi`,
		},
		{
			name: "preserves multiple quoted args",
			args: []string{`"a, b", "c, d"`},
			want: `"a, b", "c, d"`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := joinCLIArgs(tc.args); got != tc.want {
				t.Errorf("joinCLIArgs(%q) = %q, want %q", tc.args, got, tc.want)
			}
		})
	}
}

func TestParseScrollArgs(t *testing.T) {
	tests := []struct {
		args    []string
		wantDir string
		wantAmt int
	}{
		{nil, "down", 400},
		{[]string{"up"}, "up", 400},
		{[]string{"UP", "650"}, "up", 650},
		{[]string{"down", "250"}, "down", 250},
		{[]string{"-300"}, "down", -300},
		{[]string{"800"}, "down", 800},
	}
	for _, tc := range tests {
		dir, amt := parseScrollArgs(tc.args)
		if dir != tc.wantDir || amt != tc.wantAmt {
			t.Errorf("parseScrollArgs(%v) = (%q, %d), want (%q, %d)", tc.args, dir, amt, tc.wantDir, tc.wantAmt)
		}
	}
}

func TestCheckDaemonHealthRejectsNonDaemon200(t *testing.T) {
	// Unrelated server serving 200 HTML must NOT pass daemon health check
	htmlSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<html>Not Efekta</html>"))
	}))
	defer htmlSrv.Close()
	if _, ok := checkDaemonHealth(htmlSrv.URL); ok {
		t.Error("expected HTML 200 response to fail daemon health check")
	}

	// Valid efekta daemon JSON response must pass
	okSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"running","browserConnected":true}`))
	}))
	defer okSrv.Close()
	data, ok := checkDaemonHealth(okSrv.URL)
	if !ok || data["browserConnected"] != true {
		t.Errorf("expected valid daemon health response to pass, got ok=%v data=%v", ok, data)
	}
}

func TestSendCommandHTTPReportsHTTPErrorStatus(t *testing.T) {
	errSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "Forbidden host", http.StatusForbidden)
	}))
	defer errSrv.Close()

	_, err := sendCommandHTTP(errSrv.URL, protocol.Command{Action: "status"})
	if err == nil || !strings.Contains(err.Error(), "HTTP 403") || !strings.Contains(err.Error(), "Forbidden host") {
		t.Fatalf("expected HTTP 403 error message, got: %v", err)
	}
}

func TestParseOutputFlagRejectsMissingOrFlagPath(t *testing.T) {
	if p, err := parseOutputFlag([]string{"screen", "-o", "out.png", "--json"}); err != nil || p != "out.png" {
		t.Fatalf("expected out.png, got (%q, %v)", p, err)
	}
	if _, err := parseOutputFlag([]string{"screen", "-o", "--json"}); err == nil {
		t.Error("expected error when -o is immediately followed by --json")
	}
	if _, err := parseOutputFlag([]string{"screen", "--output"}); err == nil {
		t.Error("expected error when --output is missing a path")
	}
}

func TestResolveExecutablePathHandlesDeletedBinary(t *testing.T) {
	tmpFile := t.TempDir() + "/efekta"
	if err := os.WriteFile(tmpFile, []byte("bin"), 0755); err != nil {
		t.Fatalf("write tmp binary: %v", err)
	}
	got := resolveExecutablePath(tmpFile+" (deleted)", os.Stat, func(string) (string, error) {
		return "/fallback/efekta", nil
	})
	if got != tmpFile {
		t.Fatalf("expected cleaned path %q, got %q", tmpFile, got)
	}

	gotFallback := resolveExecutablePath("/nonexistent/efekta (deleted)", os.Stat, func(string) (string, error) {
		return "/usr/local/bin/efekta", nil
	})
	if gotFallback != "/usr/local/bin/efekta" {
		t.Fatalf("expected LookPath fallback, got %q", gotFallback)
	}
}

func TestWaitForBrowserConnected(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		if calls < 2 {
			_, _ = w.Write([]byte(`{"status":"running","browserConnected":false}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"running","browserConnected":true}`))
	}))
	defer srv.Close()

	if !waitForBrowserConnected(srv.URL, 500*time.Millisecond, 10*time.Millisecond) {
		t.Fatal("expected waitForBrowserConnected to succeed on second poll")
	}
	if calls < 2 {
		t.Fatalf("expected at least 2 polls, got %d", calls)
	}
}
