# CLAUDE.md

See [AGENTS.md](./AGENTS.md) for complete instructions on using the `efekta` CLI and MCP server to automate English lessons on `learn.better.efekta.com`.

## Quick Reference
- Inspect page state: `efekta status --json`
- Full AI agent playbook: `efekta guide`
- Solve multiple choice: `efekta solve choice --json`
- Analyze sentence order: `efekta solve sentence --json`
- Bypass speaking avatar (3 attempts): `efekta wait video-end && efekta solve speak --json`
- Run tests: `go test -race ./...`
- Build binary: `go build -o bin/efekta ./cmd/efekta`
