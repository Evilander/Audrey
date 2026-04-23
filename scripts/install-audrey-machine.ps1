[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
  [string]$DataDir = "$env:USERPROFILE\.audrey\data"
)

$ErrorActionPreference = 'Stop'

$audreyEntry = Join-Path $RepoRoot 'dist\mcp-server\index.js'
$codexConfigPath = Join-Path $env:USERPROFILE '.codex\config.toml'
$claudeCodeConfigPath = Join-Path $env:USERPROFILE '.claude.json'
$claudeDesktopConfigPath = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'

if (-not (Test-Path $audreyEntry)) {
  throw "Built Audrey MCP entrypoint not found: $audreyEntry`nRun npm run build first."
}

if (-not (Test-Path $NodeExe)) {
  throw "Node executable not found: $NodeExe"
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

function Backup-File {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupPath = "$Path.bak.$timestamp"
  Copy-Item -LiteralPath $Path -Destination $backupPath -Force
  Write-Host "Backed up $Path -> $backupPath"
}

function Update-JsonMcpEntryWithNode {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Entry,
    [Parameter(Mandatory = $true)][string]$Node,
    [Parameter(Mandatory = $true)][string]$StoreDir,
    [Parameter(Mandatory = $true)][string]$Agent
  )

  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }

  $patchScript = @'
import fs from "node:fs";
const [path, entry, storeDir, agent, nodeExe] = process.argv.slice(2);
let config = {};
if (fs.existsSync(path)) {
  config = JSON.parse(fs.readFileSync(path, "utf8"));
}
if (!config.mcpServers || typeof config.mcpServers !== "object") {
  config.mcpServers = {};
}
config.mcpServers["audrey-memory"] = {
  type: "stdio",
  command: nodeExe,
  args: [entry],
  env: {
    AUDREY_DATA_DIR: storeDir,
    AUDREY_AGENT: agent,
    AUDREY_EMBEDDING_PROVIDER: "local",
    AUDREY_DEVICE: "gpu",
    AUDREY_LLM_PROVIDER: "anthropic"
  }
};
fs.writeFileSync(path, JSON.stringify(config, null, 2));
'@

  $scriptFile = [System.IO.Path]::GetTempFileName()
  $scriptFile = [System.IO.Path]::ChangeExtension($scriptFile, '.mjs')
  Set-Content -LiteralPath $scriptFile -Value $patchScript -Encoding utf8

  try {
    & $Node $scriptFile $Path $Entry $StoreDir $Agent $Node
  } finally {
    Remove-Item -LiteralPath $scriptFile -Force -ErrorAction SilentlyContinue
  }
}

function Update-ClaudeCodeConfig {
  param(
    [string]$Path,
    [string]$Entry,
    [string]$Node,
    [string]$StoreDir
  )

  if ($PSCmdlet.ShouldProcess($Path, 'Update Claude Code Audrey MCP entry')) {
    Backup-File -Path $Path
    Update-JsonMcpEntryWithNode -Path $Path -Entry $Entry -Node $Node -StoreDir $StoreDir -Agent 'claude-code'
  }
}

function Update-ClaudeDesktopConfig {
  param(
    [string]$Path,
    [string]$Entry,
    [string]$Node,
    [string]$StoreDir
  )

  if ($PSCmdlet.ShouldProcess($Path, 'Update Claude Desktop Audrey MCP entry')) {
    Backup-File -Path $Path
    Update-JsonMcpEntryWithNode -Path $Path -Entry $Entry -Node $Node -StoreDir $StoreDir -Agent 'claude-desktop'
  }
}

function Update-CodexConfig {
  param(
    [string]$Path,
    [string]$Entry,
    [string]$Node,
    [string]$StoreDir
  )

  $existingLines = if (Test-Path $Path) {
    Get-Content -LiteralPath $Path
  } else {
    @()
  }

  $cleanLines = New-Object 'System.Collections.Generic.List[string]'
  $skippingAudrey = $false

  foreach ($line in $existingLines) {
    if (-not $skippingAudrey -and $line -eq '[mcp_servers.audrey-memory]') {
      $skippingAudrey = $true
      continue
    }

    if ($skippingAudrey) {
      if ($line -match '^\[[^\]]+\]$') {
        $skippingAudrey = $false
        $cleanLines.Add($line)
      }
      continue
    }

    $cleanLines.Add($line)
  }

  $block = @(
    '',
    '[mcp_servers.audrey-memory]',
    "command = '$Node'",
    "args = ['$Entry']",
    '',
    '[mcp_servers.audrey-memory.env]',
    "AUDREY_DATA_DIR = '$StoreDir'",
    "AUDREY_AGENT = 'codex'",
    "AUDREY_EMBEDDING_PROVIDER = 'local'",
    "AUDREY_DEVICE = 'gpu'",
    "AUDREY_LLM_PROVIDER = 'anthropic'"
  )

  $finalLines = New-Object 'System.Collections.Generic.List[string]'
  $inserted = $false

  foreach ($line in $cleanLines) {
    $finalLines.Add($line)
    if (-not $inserted -and $line -eq '[mcp_servers]') {
      foreach ($blockLine in $block) {
        $finalLines.Add($blockLine)
      }
      $inserted = $true
    }
  }

  if (-not $inserted) {
    if ($finalLines.Count -gt 0 -and $finalLines[$finalLines.Count - 1] -ne '') {
      $finalLines.Add('')
    }
    foreach ($blockLine in $block) {
      $finalLines.Add($blockLine)
    }
  }

  if ($PSCmdlet.ShouldProcess($Path, 'Update Codex Audrey MCP entry')) {
    Backup-File -Path $Path
    $parent = Split-Path -Parent $Path
    if ($parent) {
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Set-Content -LiteralPath $Path -Value $finalLines -Encoding utf8
  }
}

Write-Host "Repo root: $RepoRoot"
Write-Host "Audrey entrypoint: $audreyEntry"
Write-Host "Data dir: $DataDir"

Update-CodexConfig -Path $codexConfigPath -Entry $audreyEntry -Node $NodeExe -StoreDir $DataDir
Update-ClaudeCodeConfig -Path $claudeCodeConfigPath -Entry $audreyEntry -Node $NodeExe -StoreDir $DataDir
Update-ClaudeDesktopConfig -Path $claudeDesktopConfigPath -Entry $audreyEntry -Node $NodeExe -StoreDir $DataDir

Write-Host ''
Write-Host 'ChatGPT note: custom MCP currently requires a remote MCP server over streaming HTTP or SSE.'
Write-Host 'No local ChatGPT install was attempted by this script.'
Write-Host ''
Write-Host 'Next steps after applying:'
Write-Host "  1. Restart Codex, Claude Code, and Claude Desktop."
Write-Host "  2. Verify Audrey loads from $audreyEntry."
Write-Host "  3. Build a remote MCP deployment before trying to add Audrey to ChatGPT."
