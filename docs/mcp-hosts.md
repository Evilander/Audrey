# Audrey MCP Host Guide

Audrey ships as a local stdio MCP server, so the simplest cross-host setup is to launch it with `npx`.

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

- Tools: the 13 `memory_*` Audrey tools
- Resources: `audrey://status`, `audrey://recent`, `audrey://principles`
- Prompts: `audrey-session-briefing`, `audrey-memory-recall`, `audrey-memory-reflection`
