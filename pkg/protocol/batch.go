package protocol

import (
	"strconv"
	"strings"
)

func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// UnwrapMatchingQuotes removes a single pair of matching outer quotes ("..." or '...')
// only when the opening quote spans the entire string without closing prematurely.
func UnwrapMatchingQuotes(s string) string {
	s = strings.TrimSpace(s)
	if len(s) < 2 {
		return s
	}
	q := s[0]
	if (q != '"' && q != '\'') || s[len(s)-1] != q {
		return s
	}
	for i := 1; i < len(s)-1; i++ {
		if s[i] == '\\' && i+1 < len(s)-1 {
			i++
			continue
		}
		if s[i] == q {
			if q == '\'' && isASCIILetter(s[i-1]) && isASCIILetter(s[i+1]) {
				continue
			}
			// Opening quote closed before the end (e.g. `"a, b", "c, d"`), so do not unwrap.
			return s
		}
	}
	inner := s[1 : len(s)-1]
	if q == '"' {
		inner = strings.ReplaceAll(inner, `\"`, `"`)
	} else {
		inner = strings.ReplaceAll(inner, `\'`, `'`)
	}
	return strings.TrimSpace(inner)
}

// splitBatchSegments splits a batch command string on unquoted semicolons while
// preserving semicolons inside quotes and ignoring English contractions/possessives.
func splitBatchSegments(batchStr string) []string {
	var parts []string
	var cur strings.Builder
	var inQuote byte

	for i := 0; i < len(batchStr); i++ {
		c := batchStr[i]
		if c == '\\' && inQuote != 0 && i+1 < len(batchStr) {
			cur.WriteByte(c)
			i++
			cur.WriteByte(batchStr[i])
			continue
		}
		if c == '"' || c == '\'' {
			if inQuote == 0 {
				// Apostrophe immediately after a letter (don't, I'm, students') is not an opening quote.
				if c == '\'' && i > 0 && isASCIILetter(batchStr[i-1]) {
					cur.WriteByte(c)
					continue
				}
				inQuote = c
			} else if c == inQuote {
				// Word-internal apostrophe inside single quotes (e.g. 'that's right') does not close the quote.
				if c == '\'' && i > 0 && i+1 < len(batchStr) && isASCIILetter(batchStr[i-1]) && isASCIILetter(batchStr[i+1]) {
					cur.WriteByte(c)
					continue
				}
				inQuote = 0
			}
			cur.WriteByte(c)
			continue
		}
		if c == ';' && inQuote == 0 {
			parts = append(parts, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteByte(c)
	}
	if cur.Len() > 0 {
		parts = append(parts, cur.String())
	}
	return parts
}

// ParseBatchString parses a semicolon-separated chain of commands into BatchSubCommands.
// Supports turbo macro actions: pick, pair/match, sort, gaps/fill, speak/say, dialogue/avatar, auto/autopilot, next/ff, plus click, drag, type, press, scroll, wait, solve, voice.
func ParseBatchString(batchStr string) []BatchSubCommand {
	var subs []BatchSubCommand
	parts := splitBatchSegments(batchStr)
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
		rawRest := strings.TrimSpace(item[len(tokens[0]):])
		rest := UnwrapMatchingQuotes(rawRest)

		switch act {
		case "click":
			if rest != "" {
				subs = append(subs, BatchSubCommand{Action: "click", Target: rest, StopOnError: true})
			}
		case "pick":
			if rest != "" {
				subs = append(subs, BatchSubCommand{Action: "pick", Target: rest, StopOnError: true})
			}
		case "pair", "match":
			if rest != "" {
				subs = append(subs, BatchSubCommand{Action: "pair", Target: rest, StopOnError: true})
			}
		case "sort":
			if rest != "" {
				subs = append(subs, BatchSubCommand{Action: "sort", Target: rest, StopOnError: true})
			}
		case "gaps", "fill":
			if rest != "" {
				subs = append(subs, BatchSubCommand{Action: "gaps", Target: rest, StopOnError: true})
			}
		case "speak", "say":
			target := rest
			if target == "" {
				target = "all"
			}
			subs = append(subs, BatchSubCommand{Action: "speak", Target: target, StopOnError: true})
		case "dialogue", "avatar":
			subs = append(subs, BatchSubCommand{Action: "dialogue", Target: rest, StopOnError: true})
		case "auto", "autopilot":
			subs = append(subs, BatchSubCommand{Action: "autopilot", Target: rest, StopOnError: true})
		case "lesson", "unit":
			target := rest
			if target == "" {
				target = "next"
			}
			subs = append(subs, BatchSubCommand{Action: "lesson", Target: target, StopOnError: true})
		case "essay", "write":
			target := rest
			if target == "" {
				target = "auto"
			}
			subs = append(subs, BatchSubCommand{Action: "essay", Target: target, StopOnError: true})
		case "sequence":
			target := rest
			if target == "" {
				target = "auto"
			}
			subs = append(subs, BatchSubCommand{Action: "sequence", Target: target, StopOnError: true})
		case "voice":
			target := rest
			if target == "" {
				target = "status"
			}
			subs = append(subs, BatchSubCommand{Action: "voice", Target: target, StopOnError: true})
		case "next", "ff":
			hops := 9
			if len(tokens) >= 2 {
				if n, err := strconv.Atoi(tokens[1]); err == nil && n > 0 {
					hops = n
				}
			}
			subs = append(subs, BatchSubCommand{Action: "next", Amount: hops, StopOnError: true})
		case "skip":
			subs = append(subs, BatchSubCommand{Action: "skip", Target: rest, StopOnError: true})
		case "seek":
			subs = append(subs, BatchSubCommand{Action: "seek", Target: rest, StopOnError: true})
		case "drag":
			if len(tokens) >= 3 {
				subs = append(subs, BatchSubCommand{Action: "drag", Source: tokens[1], Target: tokens[2], StopOnError: true})
			}
		case "type":
			if len(tokens) >= 3 {
				afterTarget := strings.TrimSpace(rawRest[len(tokens[1]):])
				text := UnwrapMatchingQuotes(afterTarget)
				subs = append(subs, BatchSubCommand{Action: "type", Target: tokens[1], Text: text, StopOnError: true})
			}
		case "press", "key":
			if len(tokens) >= 2 {
				subs = append(subs, BatchSubCommand{Action: "press", Target: tokens[1], StopOnError: true})
			}
		case "scroll":
			dir := "down"
			amt := 400
			if len(tokens) >= 2 {
				arg1 := strings.ToLower(tokens[1])
				if arg1 == "up" || arg1 == "down" {
					dir = arg1
					if len(tokens) >= 3 {
						if n, err := strconv.Atoi(tokens[2]); err == nil {
							amt = n
						}
					}
				} else if n, err := strconv.Atoi(arg1); err == nil {
					amt = n
				}
			}
			subs = append(subs, BatchSubCommand{Action: "scroll", Direction: dir, Amount: amt, StopOnError: true})
		case "wait", "sleep":
			if len(tokens) == 1 {
				subs = append(subs, BatchSubCommand{Action: "sleep", DelayMs: 200, Target: "200", StopOnError: true})
			} else if ms, err := strconv.Atoi(tokens[1]); err == nil && ms >= 0 {
				subs = append(subs, BatchSubCommand{Action: "sleep", DelayMs: ms, Target: tokens[1], StopOnError: true})
			} else {
				subs = append(subs, BatchSubCommand{Action: "wait", Target: rest, StopOnError: true})
			}
		case "solve":
			strat := "choice"
			if len(tokens) >= 2 {
				strat = strings.ToLower(tokens[1])
			}
			switch strat {
			case "choice", "multiple_choice":
				subs = append(subs, BatchSubCommand{Action: "solve_choice", StopOnError: true})
			case "sentence", "order":
				subs = append(subs, BatchSubCommand{Action: "solve_sentence", StopOnError: true})
			case "speak", "voice", "dialog", "skip":
				subs = append(subs, BatchSubCommand{Action: "skip_speaking", StopOnError: true})
			default:
				subs = append(subs, BatchSubCommand{Action: "solve_" + strat, StopOnError: true})
			}
		}
	}
	return subs
}
