package main

import (
	"testing"
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
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := joinCLIArgs(tc.args); got != tc.want {
				t.Errorf("joinCLIArgs(%q) = %q, want %q", tc.args, got, tc.want)
			}
		})
	}
}
