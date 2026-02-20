#!/usr/bin/env bash
# Register Audrey MCP server with Claude Code
# Usage: bash mcp-server/register.sh [--openai] [--anthropic]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_PATH="$SCRIPT_DIR/index.js"

ARGS="--transport stdio --scope user"
ENV_ARGS=""

ENV_ARGS="$ENV_ARGS --env AUDREY_DATA_DIR=$HOME/.audrey/data"

if [[ "$*" == *"--openai"* ]]; then
  ENV_ARGS="$ENV_ARGS --env AUDREY_EMBEDDING_PROVIDER=openai --env AUDREY_EMBEDDING_DIMENSIONS=1536"
  [ -n "$OPENAI_API_KEY" ] && ENV_ARGS="$ENV_ARGS --env OPENAI_API_KEY=$OPENAI_API_KEY"
else
  ENV_ARGS="$ENV_ARGS --env AUDREY_EMBEDDING_PROVIDER=mock --env AUDREY_EMBEDDING_DIMENSIONS=8"
fi

if [[ "$*" == *"--anthropic"* ]]; then
  ENV_ARGS="$ENV_ARGS --env AUDREY_LLM_PROVIDER=anthropic"
  [ -n "$ANTHROPIC_API_KEY" ] && ENV_ARGS="$ENV_ARGS --env ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
fi

echo "Registering Audrey MCP server..."
echo "  Server: $SERVER_PATH"

claude mcp add $ARGS $ENV_ARGS audrey-memory -- node "$SERVER_PATH"

echo "Done. Run 'claude mcp list' to verify."
