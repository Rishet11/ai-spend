# codex-spend

> See where your OpenAI Codex tokens go. One command, zero setup.

Inspired by [claude-spend](https://github.com/writetoaniketparihar-collab/claude-spend).

## Usage

```bash
node index.js
```

Opens `http://localhost:4321` with a dashboard showing:

- Total tokens used & estimated cost
- Daily usage chart
- Per-conversation breakdown ranked by token usage
- Usage by provider/model

## Options

```bash
node index.js --port 8080   # custom port (default: 4321)
node index.js --no-open     # don't auto-open browser
```

## Requirements

- Node.js 16+
- `sqlite3` CLI (`brew install sqlite3`)
- OpenAI Codex CLI (writes to `~/.codex/state_5.sqlite`)

## Privacy

All data stays local. Reads `~/.codex/state_5.sqlite` and serves on localhost. Nothing leaves your machine.

## License

MIT
