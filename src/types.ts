// Shared TypeScript types for sdlc-integrity-mcp

export interface ToolPhases {
  explore_only?: boolean
  planning_blocked?: boolean
  mandatory_in?: string[]
}

export interface ToolPrompt {
  mandatory_instruction?: string
  available_hint?: string
}

export interface ToolExecution {
  runtime: 'python3' | 'bash' | 'node'
  script: string
  args: string[]
  default_timeout?: number
  max_timeout?: number
}

export interface ToolConfig {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required?: string[]
  }
  phases?: ToolPhases
  prompt?: ToolPrompt
  execution: ToolExecution
}

export interface ToolResult {
  content: string
  is_error: boolean
}
