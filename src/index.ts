import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import path from 'node:path'
import { loadToolConfigs } from './loader.js'
import { runTool } from './runner.js'

// Workspace root = directory from which the MCP server was launched
// (e.g. the repo the AI coding agent has open)
const workspaceRoot = process.env.SDLC_WORKSPACE ?? process.cwd()

// Load bundled tools + any workspace-local .sdlc-rules/ overlay
const tools = loadToolConfigs(workspaceRoot)

// ─── MCP Server ──────────────────────────────────────────────

const server = new Server(
  { name: 'sdlc-integrity-mcp', version: '1.0.2' },
  { capabilities: { tools: {} } }
)

// tools/list — return all registered tool schemas
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Array.from(tools.values()).map(config => ({
    name: config.name,
    description: config.description,
    inputSchema: config.input_schema,
  })),
}))

// tools/call — route to the subprocess runner
server.setRequestHandler(CallToolRequestSchema, async request => {
  const toolName = request.params.name
  const rawInput = (request.params.arguments ?? {}) as Record<string, string | number | boolean>

  const config = tools.get(toolName)
  if (!config) {
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${toolName}` }],
      isError: true,
    }
  }

  // Resolve target relative to workspace root if not absolute
  const input = { ...rawInput }
  if (typeof input.target === 'string' && !path.isAbsolute(input.target)) {
    input.target = path.resolve(workspaceRoot, input.target)
  }

  const result = await runTool(config, input, workspaceRoot)

  return {
    content: [{ type: 'text' as const, text: result.content }],
    isError: result.is_error,
  }
})

// ─── Start ───────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[sdlc-integrity-mcp] Server ready. Workspace: ${workspaceRoot}. Tools: ${[...tools.keys()].join(', ')}`)
