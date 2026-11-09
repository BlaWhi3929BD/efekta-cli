package main

import (
	"testing"
)

func TestParseBatchString(t *testing.T) {
	input := `click opt-1; wait 120; drag item-1 slot-2; type input-1 "goes to work"; press Enter; scroll down; wait video-end; solve choice`
	cmds := ParseBatchString(input)

	if len(cmds) != 8 {
		t.Fatalf("expected 8 parsed batch commands, got %d: %+v", len(cmds), cmds)
	}

	if cmds[0].Action != "click" || cmds[0].Target != "opt-1" {
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
