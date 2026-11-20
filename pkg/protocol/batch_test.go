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
	if subs[0].Action != "skip" || !subs[0].StopOnError {
		t.Errorf("bad skip sub: %+v", subs[0])
	}
	if subs[1].Action != "next" || !subs[1].StopOnError {
		t.Errorf("bad next sub: %+v", subs[1])
	}
}

func TestParseBatchQuotesSemicolonsAndContractions(t *testing.T) {
	// Semicolon inside double quotes must not split the command
	subs := ParseBatchString(`type input-1 "Hello; world"; gaps "a, b", "c, d"; sequence 'First time. Yeah, that's right.'; next`)
	if len(subs) != 4 {
		t.Fatalf("expected 4 subcommands, got %d: %+v", len(subs), subs)
	}
	if subs[0].Action != "type" || subs[0].Target != "input-1" || subs[0].Text != "Hello; world" {
		t.Errorf("unexpected type sub: %+v", subs[0])
	}
	if subs[1].Action != "gaps" || subs[1].Target != `"a, b", "c, d"` {
		t.Errorf("expected preserved multiple quoted gap args, got: %+v", subs[1])
	}
	if subs[2].Action != "sequence" || subs[2].Target != "First time. Yeah, that's right." {
		t.Errorf("expected contraction preserved inside single quotes, got: %+v", subs[2])
	}
	if subs[3].Action != "next" {
		t.Errorf("unexpected next sub: %+v", subs[3])
	}

	// Internal nested quotes and possessives must not be stripped
	subs2 := ParseBatchString(`type input-1 "he said 'hi'"; gaps don't, students'; next`)
	if len(subs2) != 3 {
		t.Fatalf("expected 3 subcommands, got %d: %+v", len(subs2), subs2)
	}
	if subs2[0].Text != "he said 'hi'" {
		t.Errorf("inner trailing quote was corrupted: %q", subs2[0].Text)
	}
	if subs2[1].Target != "don't, students'" {
		t.Errorf("possessive apostrophe was corrupted: %q", subs2[1].Target)
	}
}

func TestParseBatchScrollWaitAndSolveEdgeCases(t *testing.T) {
	subs := ParseBatchString(`scroll UP 650; wait; solve dialog; solve bogus`)
	if len(subs) != 4 {
		t.Fatalf("expected 4 subcommands, got %d: %+v", len(subs), subs)
	}
	if subs[0].Action != "scroll" || subs[0].Direction != "up" || subs[0].Amount != 650 {
		t.Errorf("unexpected scroll sub: %+v", subs[0])
	}
	if subs[1].Action != "sleep" || subs[1].DelayMs != 200 {
		t.Errorf("unexpected default wait sub: %+v", subs[1])
	}
	if subs[2].Action != "skip_speaking" {
		t.Errorf("expected solve dialog -> skip_speaking, got: %+v", subs[2])
	}
	if subs[3].Action == "solve_choice" {
		t.Errorf("unknown solve strategy must not silently fall back to solve_choice: %+v", subs[3])
	}
}

func TestParseBatchStatusAndState(t *testing.T) {
	subs := ParseBatchString(`click act-2; status; state; solve gaps; solve sort; solve pair; solve order; solve auto`)
	if len(subs) != 8 {
		t.Fatalf("expected 8 subcommands, got %d: %+v", len(subs), subs)
	}
	if subs[1].Action != "status" || !subs[1].StopOnError {
		t.Errorf("expected status subcommand, got %+v", subs[1])
	}
	if subs[2].Action != "status" || !subs[2].StopOnError {
		t.Errorf("expected state -> status subcommand, got %+v", subs[2])
	}
	if subs[3].Action != "solve_gaps" || subs[4].Action != "solve_sort" || subs[5].Action != "solve_pair" || subs[6].Action != "solve_order" || subs[7].Action != "solve_auto" {
		t.Errorf("unexpected solve subcommands: %+v", subs[3:])
	}
}
