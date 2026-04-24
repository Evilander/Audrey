# Audrey MCP Host Guide

Audrey ships as a local stdio MCP server. Claude Code is only one host; the same server is meant to be used from Codex, Claude Desktop, Cursor, Windsurf, VS Code, JetBrains, and any MCP-compatible local agent shell.

For pinned configs that launch the built Audrey entrypoint directly:

```bash
npx audrey mcp-config codex
npx audrey mcp-config generic
npx audrey mcp-config vscode
```

For portable configs that always resolve the latest published package, launch with `npx`:

```json
{
  "mcpServers": {
    "audrey-memory": {
      "command": "npx",
      "args": ["-y", "audrey"],
      "env": {
        "AUDREY_AGENT": "host-name"
      }
    }
  }
}
```

If a Windows host fails to locate `npx`, use:

```json
{
  "mcpServers": {
    "audrey-memory": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "audrey"]
    }
  }
}
```

## Codex

Codex uses TOML under `C:\Users\<you>\.codex\config.toml` on Windows.

Generate a pinned block:

```bash
npx audrey mcp-config codex
```

Example shape:

```toml
[mcp_servers.audrey-memory]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\audrey\\dist\\mcp-server\\index.js"]

[mcp_servers.audrey-memory.env]
AUDREY_AGENT = "codex"
AUDREY_DATA_DIR = "C:\\Users\\you\\.audrey\\data"
AUDREY_EMBEDDING_PROVIDER = "local"
AUDREY_DEVICE = "gpu"
```

Use one shared `AUDREY_DATA_DIR` if Codex and other hosts should remember the same work. Use separate data directories if you need hard separation between clients or projects.

## Claude Code

Claude Code can use Audrey through the built-in installer:

```bash
npx audrey install
claude mcp list
```

The installer persists a Claude Code `AUDREY_AGENT=claude-code` identity while still using the same Audrey MCP runtime as every other host.

## Claude Desktop

Claude Desktop uses `claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "audrey-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "audrey"],
      "env": {
        "AUDREY_AGENT": "claude-desktop"
      }
    }
  }
}
```

## Cursor

Official docs: <https://docs.cursor.com/en/context/mcp>

- Project-local config: `.cursor/mcp.json`
- Global config: `~/.cursor/mcp.json`
- Cursor supports variable interpolation in `command`, `args`, `env`, `url`, and `headers`

Recommended project-local example:

```json
{
  "mcpServers": {
    "audrey-memory": {
      "command": "npx",
      "args": ["-y", "audrey"],
      "env": {
        "AUDREY_AGENT": "cursor",
        "AUDREY_DATA_DIR": "${workspaceFolder}/.audrey-data"
      }
    }
  }
}
```

## Windsurf

Official docs: <https://docs.windsurf.com/windsurf/cascade/mcp>

- Open the MCP Marketplace from the `MCPs` button in Cascade, or go to `Windsurf Settings` -> `Cascade` -> `MCP Servers`
- Windsurf also supports file-based config via `~/.codeium/windsurf/mcp_config.json`

Example:

```json
{
  "mcpServers": {
    "audrey-memory": {
      "command": "npx",
      "args": ["-y", "audrey"],
      "env": {
        "AUDREY_AGENT": "windsurf"
      }
    }
  }
}
```

## VS Code Copilot

Official docs: <https://code.visualstudio.com/docs/copilot/chat/mcp-servers>

- VS Code supports MCP servers in chat and local agents
- Add Audrey through the MCP server UI or a workspace file such as `.vscode/mcp.json`

Example:

```json
{
  "servers": {
    "audrey-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "audrey"],
      "env": {
        "AUDREY_AGENT": "vscode-copilot"
      }
    }
  }
}
```

## JetBrains AI Assistant

Official docs: <https://www.jetbrains.com/help/ai-assistant/settings-reference-mcp.html>

- Go to `Settings` -> `Tools` -> `AI Assistant` -> `Model Context Protocol (MCP)`
- Add a server directly, or use JetBrains' `Import from Claude` action if you already have Audrey configured there

Example JSON:

```json
{
  "mcpServers": {
    "audrey-memory": {
      "command": "npx",
      "args": ["-y", "audrey"],
      "env": {
        "AUDREY_AGENT": "jetbrains"
      }
    }
  }
}
```

## Audrey Surfaces To Expect

Once connected, hosts can use:

- Tools: the 19 `memory_*` Audrey tools, including `memory_preflight` and `memory_reflexes`
- Resources: `audrey://status`, `audrey://recent`, `audrey://principles`
- Prompts: `audrey-session-briefing`, `audrey-memory-recall`, `audrey-memory-reflection`
