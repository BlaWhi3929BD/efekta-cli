package protocol

import "testing"

func TestParseBatchDialogueAndAuto(t *testing.T) {
	subs := ParseBatchString("dialogue B,C once; auto 20 speak; next")
	if len(subs) != 3 {
		t.Fatalf("expected 3 subcommands, got %d", len(subs))
	}
	if subs[0].Action != "dialogue" || subs[0].Target != "B,C once" {
		t.Errorf("bad dialogue sub: %+v", subs[0])
	}
	if subs[1].Action != "autopilot" || subs[1].Target != "20 speak" {
		t.Errorf("bad autopilot sub: %+v", subs[1])
	}
	if subs[2].Action != "next" {
		t.Errorf("bad next sub: %+v", subs[2])
	}
}

func TestParseBatchSkip(t *testing.T) {
	subs := ParseBatchString("skip; next")
	if len(subs) != 2 {
		t.Fatalf("expected 2 subcommands, got %d", len(subs))
	}
	if subs[0].Action != "skip" {
		t.Errorf("bad skip sub: %+v", subs[0])
	}
	if subs[1].Action != "next" {
		t.Errorf("bad next sub: %+v", subs[1])
	}
}
