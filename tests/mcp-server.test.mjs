/**
 * End-to-end validation of sdlc-integrity-mcp.
 *
 * Uses the real MCP Client + StdioClientTransport against the built server.
 * Fixture files assert concrete findings from each checker — not just "got a response".
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const SERVER = path.join(ROOT, 'dist', 'index.js')

const REQUIRED_TOOLS = [
  'AuditCodeIntegrity',
  'ShellSafetyChecker',
  'JsSafetyChecker',
  'PythonSafetyChecker',
]

function textOf(result) {
  assert.ok(Array.isArray(result.content), 'tool result must include content[]')
  const text = result.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n')
  assert.ok(text.length > 0, 'tool result text must be non-empty')
  return text
}

function writeFixtures(workspace) {
  fs.writeFileSync(
    path.join(workspace, 'good.sh'),
    `#!/usr/bin/env bash\nset -euo pipefail\necho "OK"\n`
  )
  fs.writeFileSync(
    path.join(workspace, 'bad.sh'),
    `#!/usr/bin/env bash\necho "NO STRICT"\n`
  )
  fs.writeFileSync(
    path.join(workspace, 'lifecycle.sh'),
    `#!/usr/bin/env bash\nset -euo pipefail\ndocker buildx create --name ephemeral\necho "leaked builder"\n`
  )
  fs.writeFileSync(
    path.join(workspace, 'dup.html'),
    `<!doctype html><html><body><script>
function handleClick() { return 1; }
function handleClick() { return 2; }
</script></body></html>\n`
  )
  fs.writeFileSync(
    path.join(workspace, 'clean.html'),
    `<!doctype html><html><body><script>
function handleClick() { return 1; }
handleClick();
</script></body></html>\n`
  )
  fs.writeFileSync(path.join(workspace, 'clean.py'), `x = 1\n`)
  fs.writeFileSync(path.join(workspace, 'creds.py'), `PASSWORD = "supersecretvalue"\n`)
  fs.writeFileSync(
    path.join(workspace, 'swallow.py'),
    `def load():\n    try:\n        return 1\n    except Exception:\n        pass\n`
  )
}

async function withClient(workspace, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...getDefaultEnvironment(),
      SDLC_WORKSPACE: workspace,
      PATH: process.env.PATH ?? '',
    },
    stderr: 'pipe',
  })

  const client = new Client({ name: 'sdlc-integrity-test', version: '1.0.0' })
  await client.connect(transport)

  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => {})
  }
}

async function runTests() {
  console.log('\nE2E: sdlc-integrity-mcp via real MCP Client\n')

  assert.ok(fs.existsSync(SERVER), `Build missing: ${SERVER} (run npm run build)`)

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-mcp-e2e-'))
  writeFixtures(workspace)

  try {
    await withClient(workspace, async client => {
      // ── listTools ──────────────────────────────────────────
      console.log('1. listTools returns the four bundled tools...')
      const listed = await client.listTools()
      const names = listed.tools.map(t => t.name).sort()
      for (const required of REQUIRED_TOOLS) {
        assert.ok(names.includes(required), `missing tool: ${required}`)
      }
      for (const tool of listed.tools) {
        assert.ok(tool.description?.length > 0, `${tool.name} missing description`)
        assert.equal(tool.inputSchema?.type, 'object', `${tool.name} inputSchema.type`)
        assert.ok(tool.inputSchema?.properties?.target, `${tool.name} must accept target`)
      }
      console.log(`   ✓ ${names.join(', ')}`)

      // ── ShellSafetyChecker ─────────────────────────────────
      console.log('2. ShellSafetyChecker fails bad.sh (no set -euo pipefail)...')
      const shellBad = await client.callTool({
        name: 'ShellSafetyChecker',
        arguments: { target: path.join(workspace, 'bad.sh') },
      })
      assert.equal(shellBad.isError, true, 'bad.sh must set isError')
      const shellBadText = textOf(shellBad)
      assert.match(shellBadText, /set -euo pipefail|strict mode|Missing.*set -e/i)
      console.log('   ✓ findings reference missing strict mode')

      console.log('3. ShellSafetyChecker passes good.sh...')
      const shellGood = await client.callTool({
        name: 'ShellSafetyChecker',
        arguments: { target: 'good.sh' }, // relative path → SDLC_WORKSPACE
      })
      assert.equal(shellGood.isError, false, `good.sh failed: ${textOf(shellGood)}`)
      assert.match(textOf(shellGood), /passed|OK:/i)
      console.log('   ✓ relative target resolved and passed')

      // ── JsSafetyChecker ────────────────────────────────────
      console.log('4. JsSafetyChecker detects duplicate function in dup.html...')
      const jsBad = await client.callTool({
        name: 'JsSafetyChecker',
        arguments: { target: path.join(workspace, 'dup.html') },
      })
      assert.equal(jsBad.isError, true, 'dup.html must set isError')
      assert.match(textOf(jsBad), /Duplicate function/i)
      console.log('   ✓ duplicate handleClick reported')

      console.log('5. JsSafetyChecker passes clean.html...')
      const jsGood = await client.callTool({
        name: 'JsSafetyChecker',
        arguments: { target: path.join(workspace, 'clean.html') },
      })
      assert.equal(jsGood.isError, false, `clean.html failed: ${textOf(jsGood)}`)
      console.log('   ✓ clean HTML passed')

      // ── PythonSafetyChecker ────────────────────────────────
      console.log('6. PythonSafetyChecker detects hardcoded PASSWORD...')
      const pyBad = await client.callTool({
        name: 'PythonSafetyChecker',
        arguments: { target: path.join(workspace, 'creds.py') },
      })
      assert.equal(pyBad.isError, true, 'creds.py must set isError')
      assert.match(textOf(pyBad), /Hardcoded credential/i)
      console.log('   ✓ credential finding returned')

      console.log('7. PythonSafetyChecker passes clean.py (missing bandit must not fail)...')
      const pyGood = await client.callTool({
        name: 'PythonSafetyChecker',
        arguments: { target: path.join(workspace, 'clean.py') },
      })
      assert.equal(pyGood.isError, false, `clean.py failed: ${textOf(pyGood)}`)
      console.log('   ✓ clean Python passed')

      // ── AuditCodeIntegrity ─────────────────────────────────
      console.log('8. AuditCodeIntegrity returns JSON with lifecycle FAIL for buildx create without teardown...')
      const audit = await client.callTool({
        name: 'AuditCodeIntegrity',
        arguments: { target: path.join(workspace, 'lifecycle.sh') },
      })
      assert.equal(audit.isError, true, 'lifecycle asymmetry must set isError')
      const auditJson = JSON.parse(textOf(audit))
      assert.ok(auditJson.findings, `expected findings wrapper, got keys: ${Object.keys(auditJson)}`)
      assert.ok(Array.isArray(auditJson.findings.lifecycle_parity), 'lifecycle_parity array required')
      const lifecycleFail = auditJson.findings.lifecycle_parity.find(
        f => f.severity === 'FAIL' && /buildx create/i.test(f.message ?? '')
      )
      assert.ok(lifecycleFail, `expected LIFECYCLE buildx finding, got: ${JSON.stringify(auditJson.findings.lifecycle_parity)}`)
      console.log(`   ✓ rule=${lifecycleFail.rule}`)

      console.log('9. AuditCodeIntegrity flags swallowed exception in swallow.py...')
      const swallow = await client.callTool({
        name: 'AuditCodeIntegrity',
        arguments: { target: path.join(workspace, 'swallow.py') },
      })
      const swallowJson = JSON.parse(textOf(swallow))
      const swallowed = (swallowJson.findings?.error_handling ?? []).find(f => f.rule === 'SWALLOWED_EXCEPTION')
      assert.ok(swallowed, `expected SWALLOWED_EXCEPTION, got: ${JSON.stringify(swallowJson.findings?.error_handling)}`)
      console.log('   ✓ SWALLOWED_EXCEPTION present')

      // ── unknown tool ───────────────────────────────────────
      console.log('10. Unknown tool returns isError without crashing the session...')
      const unknown = await client.callTool({
        name: 'NonExistentTool',
        arguments: {},
      })
      assert.equal(unknown.isError, true)
      assert.match(textOf(unknown), /Unknown tool/i)

      const stillAlive = await client.listTools()
      assert.ok(stillAlive.tools.length >= 4, 'server must still respond after unknown tool')
      console.log('   ✓ session still healthy')
    })

    console.log('\n✓ All E2E MCP validations passed\n')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

runTests().catch(err => {
  console.error('\n✗ E2E failed:', err)
  process.exit(1)
})
