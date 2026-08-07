# @asobacloud/sdlc-integrity-mcp

MCP server for enterprise SDLC code integrity. AI coding agents call its tools over the [Model Context Protocol](https://modelcontextprotocol.io/) to scan a workspace for lifecycle teardown gaps, mock-theater tests, DRY violations, and language-specific safety issues in shell, JavaScript/HTML, and Python.

[![npm](https://img.shields.io/npm/v/@asobacloud/sdlc-integrity-mcp.svg)](https://www.npmjs.com/package/@asobacloud/sdlc-integrity-mcp)
[![CI](https://github.com/AsobaCloud/sdlc-integrity-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AsobaCloud/sdlc-integrity-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Quick start

Set `SDLC_WORKSPACE` to the absolute path of the repo to audit. If omitted, the server uses its process working directory. The server speaks MCP over **stdio** (no HTTP port).

### Cursor

Add to `~/.cursor/mcp.json` or the project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sdlc-integrity": {
      "command": "npx",
      "args": ["-y", "@asobacloud/sdlc-integrity-mcp"],
      "env": {
        "SDLC_WORKSPACE": "/absolute/path/to/your/repo"
      }
    }
  }
}
```

Restart Cursor (or reload MCP servers), then ask the agent to run the integrity tools.

### Claude Code

CLI (user scope):

```bash
claude mcp add --transport stdio --scope user \
  --env SDLC_WORKSPACE=/absolute/path/to/your/repo \
  sdlc-integrity -- npx -y @asobacloud/sdlc-integrity-mcp
```

Or put the same JSON under `mcpServers` in project `.mcp.json` (team-shared) or `~/.claude.json` (user-wide):

```json
{
  "mcpServers": {
    "sdlc-integrity": {
      "command": "npx",
      "args": ["-y", "@asobacloud/sdlc-integrity-mcp"],
      "env": {
        "SDLC_WORKSPACE": "/absolute/path/to/your/repo"
      }
    }
  }
}
```

Verify with `claude mcp list`. Project `.mcp.json` servers need approval the first time you open the repo in Claude Code.

### Codex

CLI:

```bash
codex mcp add sdlc-integrity --env SDLC_WORKSPACE=/absolute/path/to/your/repo -- npx -y @asobacloud/sdlc-integrity-mcp
```

Or edit `~/.codex/config.toml` (or project `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.sdlc-integrity]
command = "npx"
args = ["-y", "@asobacloud/sdlc-integrity-mcp"]

[mcp_servers.sdlc-integrity.env]
SDLC_WORKSPACE = "/absolute/path/to/your/repo"
```

Codex CLI, the IDE extension, and the ChatGPT desktop Codex host share this config.

### Run directly

```bash
npx -y @asobacloud/sdlc-integrity-mcp
```

## Tools

| Tool | Runtime | What it checks |
|------|---------|----------------|
| `AuditCodeIntegrity` | `python3` | Lifecycle teardown parity, mock-theater test detection, naming invariants, swallowed exceptions, DRY / duplicative functions. Returns structured JSON. |
| `ShellSafetyChecker` | `bash` | Missing `set -euo pipefail`, shebang issues, hardcoded credentials, background-job silent-failure risk; optionally [shellcheck](https://www.shellcheck.net/) errors. |
| `JsSafetyChecker` | `node` | JS/HTML syntax errors, duplicate function definitions, duplicate HTML element IDs (AST-based via [esprima](https://www.npmjs.com/package/esprima)). |
| `PythonSafetyChecker` | `python3` | [bandit](https://bandit.readthedocs.io/) (High/Critical), [ruff](https://docs.astral.sh/ruff/), AST checks for `eval`/`exec`, pickle loads, hardcoded credentials, mutable default args. |

Each tool accepts:

- `target` — file or directory to scan (relative paths resolve against `SDLC_WORKSPACE`)
- `timeout` — optional timeout in ms (default `120000`, max `600000`)

Checker exit code `1` (findings) becomes `isError: true` on the MCP result. Unexpected crashes are reported as errors.

## Requirements

| Runtime | Required for |
|---------|----------------|
| Node.js ≥ 22 | MCP server + `JsSafetyChecker` |
| Python 3 | `AuditCodeIntegrity`, `PythonSafetyChecker` |
| bash | `ShellSafetyChecker` |

Optional (skipped with a warning if missing):

| Tool | Improves |
|------|----------|
| [shellcheck](https://www.shellcheck.net/) | `ShellSafetyChecker` |
| [bandit](https://bandit.readthedocs.io/) | `PythonSafetyChecker` |
| [ruff](https://docs.astral.sh/ruff/) | `PythonSafetyChecker` |

## Custom rules

Drop JSON tool configs into `<workspace>/.sdlc-rules/`. Local rules **override** bundled tools with the same `name`, or add new ones. Script paths resolve relative to `.sdlc-rules/`.

```json
{
  "name": "MyCustomAudit",
  "description": "Project-specific integrity check",
  "input_schema": {
    "type": "object",
    "properties": {
      "target": { "type": "string", "description": "File or directory to scan" },
      "timeout": { "type": "integer", "description": "Timeout in ms (max 600000)" }
    }
  },
  "execution": {
    "runtime": "python3",
    "script": "./my-audit.py",
    "args": ["--target", "{{target}}"],
    "default_timeout": 120000,
    "max_timeout": 600000
  }
}
```

`{{placeholder}}` values are filled from the tool call. If a value is omitted, that flag and its placeholder are skipped.

## Architecture

```
rules/*.json   → tool schemas + execution specs
scripts/*      → checker subprocesses
src/loader.ts  → bundled rules + .sdlc-rules/ overlay
src/runner.ts  → spawn, timeouts, exit-code → isError
src/index.ts   → MCP stdio server
bin/cli.js     → npx / bin entrypoint
```

## Development

```bash
git clone https://github.com/AsobaCloud/sdlc-integrity-mcp.git
cd sdlc-integrity-mcp
npm install
npm run build
npm test
```

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm test` | E2E via real MCP `Client` + fixture assertions for all tools |
| `npm start` | Run the server on stdio |
| `npm run dev` | `node --watch` on `dist/` |

Local MCP config (instead of npx):

```json
{
  "mcpServers": {
    "sdlc-integrity": {
      "command": "node",
      "args": ["/absolute/path/to/sdlc-integrity-mcp/dist/index.js"],
      "env": {
        "SDLC_WORKSPACE": "/absolute/path/to/your/repo"
      }
    }
  }
}
```

## Releasing

CI runs build + E2E on every push/PR. To publish a new version:

1. Bump `version` in `package.json`
2. Commit, push, and create a GitHub Release (`gh release create vX.Y.Z --generate-notes`)
3. `.github/workflows/publish.yml` publishes to npm (Trusted Publisher / OIDC, or `NPM_TOKEN` if configured)

## License

MIT © [AsobaCloud](https://github.com/AsobaCloud)
