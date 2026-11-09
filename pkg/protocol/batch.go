package protocol

import (
	"strconv"
	"strings"
)

// ParseBatchString parses a semicolon-separated chain of commands into BatchSubCommands.
// Supports quoted multi-word targets for click, type, and eval.
func ParseBatchString(batchStr string) []BatchSubCommand {
	var subs []BatchSubCommand
	parts := strings.Split(batchStr, ";")
	for _, raw := range parts {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		tokens := strings.Fields(item)
		if len(tokens) == 0 {
			continue
		}
		act := strings.ToLower(tokens[0])
		switch act {
		case "click":
			if len(tokens) >= 2 {
				target := strings.Trim(strings.Join(tokens[1:], " "), "\"'")
				subs = append(subs, BatchSubCommand{Action: "click", Target: target})
			}
		case "drag":
			if len(tokens) >= 3 {
				subs = append(subs, BatchSubCommand{Action: "drag", Source: tokens[1], Target: tokens[2]})
			}
		case "type":
			if len(tokens) >= 3 {
				text := strings.Trim(strings.Join(tokens[2:], " "), "\"'")
				subs = append(subs, BatchSubCommand{Action: "type", Target: tokens[1], Text: text})
			}
		case "press", "key":
			if len(tokens) >= 2 {
				subs = append(subs, BatchSubCommand{Action: "press", Target: tokens[1]})
			}
		case "scroll":
			dir := "down"
			amt := 400
			if len(tokens) >= 2 {
				if tokens[1] == "up" || tokens[1] == "down" {
					dir = tokens[1]
				} else if n, err := strconv.Atoi(tokens[1]); err == nil {
					amt = n
				}
			}
			subs = append(subs, BatchSubCommand{Action: "scroll", Direction: dir, Amount: amt})
		case "wait", "sleep":
			if len(tokens) >= 2 {
				if ms, err := strconv.Atoi(tokens[1]); err == nil && ms > 0 {
					subs = append(subs, BatchSubCommand{Action: "sleep", DelayMs: ms, Target: tokens[1]})
				} else {
					subs = append(subs, BatchSubCommand{Action: "wait", Target: tokens[1]})
				}
			}
		case "solve":
			strat := "choice"
			if len(tokens) >= 2 {
				strat = strings.ToLower(tokens[1])
			}
			switch strat {
			case "sentence", "order":
				subs = append(subs, BatchSubCommand{Action: "solve_sentence"})
			case "speak", "voice":
				subs = append(subs, BatchSubCommand{Action: "skip_speaking"})
			default:
				subs = append(subs, BatchSubCommand{Action: "solve_choice"})
			}
		}
	}
	return subs
}
