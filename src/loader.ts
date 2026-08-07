import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolConfig } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Bundled rules directory (shipped with the package)
const BUNDLED_RULES_DIR = path.join(__dirname, '..', 'rules')

/**
 * Load tool configs from the bundled rules dir, then overlay any workspace-local
 * .sdlc-rules/ directory if it exists. Local rules can override bundled ones by name,
 * or add entirely new custom tools.
 */
export function loadToolConfigs(workspaceRoot: string): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>()

  // 1. Load bundled rules
  if (fs.existsSync(BUNDLED_RULES_DIR)) {
    for (const file of fs.readdirSync(BUNDLED_RULES_DIR)) {
      if (file.endsWith('.json')) {
        try {
          const config: ToolConfig = JSON.parse(
            fs.readFileSync(path.join(BUNDLED_RULES_DIR, file), 'utf8')
          )
          tools.set(config.name, config)
        } catch (e) {
          console.error(`[sdlc-integrity-mcp] Failed to load bundled rule: ${file}`, e)
        }
      }
    }
  }

  // 2. Overlay workspace-local .sdlc-rules/ (zero-code enterprise extension point)
  const localRulesDir = path.join(workspaceRoot, '.sdlc-rules')
  if (fs.existsSync(localRulesDir)) {
    for (const file of fs.readdirSync(localRulesDir)) {
      if (file.endsWith('.json')) {
        try {
          const config: ToolConfig = JSON.parse(
            fs.readFileSync(path.join(localRulesDir, file), 'utf8')
          )
          // Resolve script path relative to .sdlc-rules/
          if (!path.isAbsolute(config.execution.script)) {
            config.execution.script = path.resolve(localRulesDir, config.execution.script)
          }
          tools.set(config.name, config)
        } catch (e) {
          console.error(`[sdlc-integrity-mcp] Failed to load local rule: ${file}`, e)
        }
      }
    }
  }

  return tools
}

/**
 * Resolve the absolute script path for a tool config.
 * Bundled scripts are relative to the package root; custom rules are already absolute.
 */
export function resolveScriptPath(config: ToolConfig): string {
  const scriptPath = config.execution.script
  if (path.isAbsolute(scriptPath)) return scriptPath
  // Relative to package root (one level up from dist/)
  return path.resolve(__dirname, '..', scriptPath)
}
