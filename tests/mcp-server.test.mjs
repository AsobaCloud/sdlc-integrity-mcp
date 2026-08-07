/**
 * tests/mcp-server.test.mjs
 * Integration test for sdlc-integrity-mcp MCP Server.
 *
 * Behavioral Coverage:
 *  BS-1: tools/list returns all 4 tool schemas
 *  BS-2: tools/call AuditCodeIntegrity executes against a temp workspace
 *  BS-2: tools/call ShellSafetyChecker detects bad scripts
 *  BS-3: tools/call routes unknown tool with error (not crash)
 */

import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(__dirname, '..', 'dist', 'index.js')

// ─── JSON-RPC over stdio helpers ─────────────────────────────

function startServer(workspace) {
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, SDLC_WORKSPACE: workspace },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function sendRequest(proc, id, method, params = {}) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  proc.stdin.write(msg + '\n')
}

async function readResponse(proc) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          proc.stdout.off('data', onData)
          resolve(parsed)
          return
        } catch (_) { /* accumulate */ }
      }
      buf = lines[lines.length - 1]
    }
    proc.stdout.on('data', onData)
    setTimeout(() => reject(new Error('Timeout waiting for server response')), 10000)
  })
}

// ─── Test runner ─────────────────────────────────────────────

async function runTests() {
  console.log('\nTesting sdlc-integrity-mcp MCP Server...\n')

  // Create a temp workspace with fixture files
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-mcp-test-'))

  // Good shell script
  fs.writeFileSync(path.join(workspace, 'good.sh'), `#!/usr/bin/env bash\nset -euo pipefail\necho "OK"\n`)
  // Bad shell script (no strict mode)
  fs.writeFileSync(path.join(workspace, 'bad.sh'), `#!/usr/bin/env bash\necho "NO STRICT"\n`)

  const proc = startServer(workspace)

  // Capture stderr for debugging if needed
  proc.stderr.on('data', d => process.stderr.write(d))

  try {
    // ─ BS-1: tools/list ───────────────────────────────────────
    console.log('Test 1: tools/list returns all 4 tool schemas...')
    sendRequest(proc, 1, 'tools/list')
    const listResp = await readResponse(proc)
    assert.ok(!listResp.error, `tools/list returned error: ${JSON.stringify(listResp.error)}`)
    const toolNames = listResp.result.tools.map(t => t.name)
    assert.ok(toolNames.includes('AuditCodeIntegrity'), 'AuditCodeIntegrity must be listed')
    assert.ok(toolNames.includes('ShellSafetyChecker'), 'ShellSafetyChecker must be listed')
    assert.ok(toolNames.includes('JsSafetyChecker'), 'JsSafetyChecker must be listed')
    assert.ok(toolNames.includes('PythonSafetyChecker'), 'PythonSafetyChecker must be listed')
    // Verify each has name, description, inputSchema
    for (const tool of listResp.result.tools) {
      assert.ok(tool.name, `Tool missing name`)
      assert.ok(tool.description, `Tool ${tool.name} missing description`)
      assert.ok(tool.inputSchema, `Tool ${tool.name} missing inputSchema`)
    }
    console.log(`  ✓ ${toolNames.length} tools listed: ${toolNames.join(', ')}`)

    // ─ BS-2: tools/call AuditCodeIntegrity ───────────────────
    console.log('\nTest 2: tools/call AuditCodeIntegrity runs against workspace...')
    sendRequest(proc, 2, 'tools/call', { name: 'AuditCodeIntegrity', arguments: { target: workspace } })
    const auditResp = await readResponse(proc)
    assert.ok(!auditResp.error, `tools/call AuditCodeIntegrity returned error: ${JSON.stringify(auditResp.error)}`)
    const auditContent = auditResp.result.content[0].text
    assert.ok(auditContent.length > 0, 'AuditCodeIntegrity should return non-empty output')
    console.log('  ✓ AuditCodeIntegrity executed and returned output')

    // ─ BS-2: tools/call ShellSafetyChecker (bad script) ──────
    console.log('\nTest 3: tools/call ShellSafetyChecker detects missing strict mode...')
    sendRequest(proc, 3, 'tools/call', { name: 'ShellSafetyChecker', arguments: { target: path.join(workspace, 'bad.sh') } })
    const shellResp = await readResponse(proc)
    assert.ok(!shellResp.error, `tools/call ShellSafetyChecker returned RPC error: ${JSON.stringify(shellResp.error)}`)
    assert.ok(shellResp.result.isError, 'Bad shell script should produce isError: true')
    console.log('  ✓ ShellSafetyChecker detected bad script correctly')

    // ─ BS-3: tools/call unknown tool ─────────────────────────
    console.log('\nTest 4: tools/call unknown tool returns structured error (no crash)...')
    sendRequest(proc, 4, 'tools/call', { name: 'NonExistentTool', arguments: {} })
    const unknownResp = await readResponse(proc)
    // Server should return a result with isError, not an unhandled RPC error crash
    assert.ok(unknownResp.result?.isError, 'Unknown tool should return isError result, not crash')
    console.log('  ✓ Unknown tool handled gracefully')

    console.log('\n✓ All MCP server integration tests passed!\n')
  } finally {
    proc.kill()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

runTests().catch(e => {
  console.error('\n✗ Test failed:', e.message)
  process.exit(1)
})
