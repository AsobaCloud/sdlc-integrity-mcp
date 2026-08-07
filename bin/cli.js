#!/usr/bin/env node
// bin/cli.js — thin launcher for npx execution
import('../dist/index.js').catch(e => {
  console.error('[sdlc-integrity-mcp] Failed to start:', e.message)
  process.exit(1)
})
