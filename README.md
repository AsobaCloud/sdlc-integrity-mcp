# sdlc-integrity-mcp

MCP server for enterprise SDLC code integrity. It exposes audit and safety-check tools over the [Model Context Protocol](https://modelcontextprotocol.io/) so AI coding agents can scan a workspace for lifecycle teardown gaps, mock-theater tests, DRY violations, and language-specific safety issues in shell, JavaScript/HTML, and Python.

## Tools

| Tool | Runtime | What it checks |
|------|---------|----------------|
| `AuditCodeIntegrity` | `python3` | Lifecycle teardown parity, mock-theater test detection, naming invariants, swallowed exceptions, DRY / duplicative functions. Returns structured JSON. |
| `ShellSafetyChecker` | `bash` | Missing `set -euo pipefail`, shebang issues, hardcoded credentials, background-job silent-failure risk; optionally [shellcheck](https://www.shellcheck.net/) errors. |
| `JsSafetyChecker` | `node` | JS/HTML syntax errors, duplicate function definitions, duplicate HTML element IDs (AST-based via esprima). |
| `PythonSafetyChecker` | `python3` | [bandit](https://bandit.readthedocs.io/) (High/Critical), [ruff](https://docs.astral.sh/ruff/), AST checks for `eval`/`exec`, pickle loads, hardcoded credentials, mutable default args. |

Each tool accepts:

- `target` — file or directory to scan (relative paths resolve against the workspace root)
- `timeout` — optional timeout in ms (default `120000`, max `600000`)

Exit code `1` with findings is surfaced as `isError: true` on the MCP tool result; unexpected crashes are reported as errors.

## Requirements

- **Node.js** ≥ 22
- **Python 3** (for `AuditCodeIntegrity` and `PythonSafetyChecker`)
- **bash** (for `ShellSafetyChecker`)

### Optional / tool-specific

| Dependency | Used by | Notes |
|------------|---------|--------|
| `shellcheck` | `ShellSafetyChecker` | Strongly recommended; without it, custom heuristic checks still run |
| `bandit` | `PythonSafetyChecker` | `pip install bandit` |
| `ruff` | `PythonSafetyChecker` | `pip install ruff` or install via package manager |

`esprima` is a declared npm dependency and is used by `JsSafetyChecker`.

## Install

```bash
npm install
npm run build
```

Or run via the published package / local bin:

```bash
npx sdlc-integrity-mcp
# or after install:
sdlc-integrity-mcp
```

## Cursor / MCP client config

Point your MCP client at the server over stdio. Set `SDLC_WORKSPACE` to the repo the agent should audit (defaults to the process cwd).

**Cursor** (`~/.cursor/mcp.json` or project `.cursor/mcp.json`):

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

For a local checkout instead of npx:

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

## Custom rules (workspace overlay)

Drop JSON tool configs into `<workspace>/.sdlc-rules/`. Local rules **override** bundled tools with the same `name`, or add new ones. Script paths in local rules are resolved relative to `.sdlc-rules/`.

Example `.sdlc-rules/MyCustomAudit.json`:

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

`{{placeholder}}` args are interpolated from the tool call arguments. If a flag’s value is omitted, that flag and its placeholder are skipped.

## Architecture

```
rules/*.json          → declarative tool schemas + execution specs
scripts/*             → language-specific checker subprocesses
src/loader.ts         → load bundled rules, overlay .sdlc-rules/
src/runner.ts         → spawn runtime, timeouts, exit-code → isError
src/index.ts          → MCP stdio server (tools/list, tools/call)
bin/cli.js            → thin launcher for npx / bin
```

1. On start, the server loads `rules/*.json`, then overlays `<workspace>/.sdlc-rules/`.
2. `tools/list` returns each tool’s name, description, and `inputSchema`.
3. `tools/call` resolves `target` against `SDLC_WORKSPACE` (or cwd), interpolates args, and runs `runtime script ...` with a capped timeout (stdout/stderr capped at 1MB).

## Development

```bash
npm install
npm run build
npm test
npm start          # run MCP server on stdio
npm run dev        # rebuild-watch via node --watch on dist/
```

Integration tests in `tests/mcp-server.test.mjs` cover:

- `tools/list` returns all four bundled tools
- `AuditCodeIntegrity` and `ShellSafetyChecker` execute against a temp workspace
- Unknown tools return a structured error instead of crashing

## License

MIT © AsobaCloud
