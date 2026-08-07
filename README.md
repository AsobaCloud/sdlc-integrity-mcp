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
| `bandit` | `PythonSafetyChecker` | Optional; skipped with a warning if missing (`pip install bandit`) |
| `ruff` | `PythonSafetyChecker` | Optional; skipped with a warning if missing |

`esprima` is a declared npm dependency and is used by `JsSafetyChecker`.

## Install

```bash
npm install
npm run build
```

Or run the published package:

```bash
npx -y @asobacloud/sdlc-integrity-mcp
```

## CI & publishing

- **CI** (`.github/workflows/ci.yml`) — on push/PR to `master`/`main`: `npm ci`, build, E2E tests.
- **Publish** (`.github/workflows/publish.yml`) — on a published GitHub Release (or manual `workflow_dispatch`).

### First npm publish (bootstrap)

Scoped package `@asobacloud/sdlc-integrity-mcp` needs publish rights on the `asobacloud` npm org.

1. Create an npm automation/granular token with publish access to `@asobacloud/*`.
2. Add it as a repo (or org) Actions secret named `NPM_TOKEN`.
3. Create and publish a GitHub Release tagged `v1.0.0` (tag must match `package.json` version, or bump the version first).

```bash
gh release create v1.0.0 --title "v1.0.0" --notes "Initial npm release"
```

### Ongoing publishes (OIDC, preferred)

After the package exists on npm:

1. On https://www.npmjs.com/package/@asobacloud/sdlc-integrity-mcp → **Settings → Trusted Publisher**:
   - Organization: `AsobaCloud`
   - Repository: `sdlc-integrity-mcp`
   - Workflow filename: `publish.yml`
2. You can remove `NPM_TOKEN`; subsequent releases publish via OIDC + provenance.

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

Integration tests in `tests/mcp-server.test.mjs` drive the **real MCP Client** (`StdioClientTransport`) against the built server and assert concrete findings from fixture files for every bundled tool (pass and fail paths), relative `target` resolution, and unknown-tool error handling.

## License

MIT © AsobaCloud
