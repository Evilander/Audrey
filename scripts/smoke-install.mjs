import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run through npm run smoke:install');
const temp = mkdtempSync(join(tmpdir(), 'audrey-install-'));
console.log(`Install smoke artifacts: ${temp}`);

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}

const packResult = JSON.parse(
  run(['pack', '--ignore-scripts', '--json', '--pack-destination', temp]),
);
// npm 12 keys pack results by package name; older versions return an array.
const [packed] = Array.isArray(packResult) ? packResult : Object.values(packResult);
const tarball = join(temp, packed.filename);
const project = join(temp, 'project');
mkdirSync(project);
writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
run(
  [
    'install',
    tarball,
    '--ignore-scripts',
    '--omit=dev',
    '--no-fund',
    '--cache',
    join(temp, 'install-cache'),
  ],
  project,
);
run(['audit', '--omit=dev', '--audit-level=moderate'], project);

const probe = `
  import assert from 'node:assert/strict';
  import { Audrey } from 'audrey';
  import { pipeline } from '@huggingface/transformers';
  import { listSupportedBackends } from 'onnxruntime-node';
  assert.equal(typeof pipeline, 'function');
  assert(listSupportedBackends().some(backend => backend.name === 'cpu' && backend.bundled));
  const store = new Audrey({ dataDir: './store', embedding: { provider: 'mock' }, llm: { provider: 'mock' } });
  try {
    const episode = await store.encode({ content: 'Install smoke memory', source: 'direct-observation' });
    assert(episode);
    const recalled = await store.recall('Install smoke memory');
    assert(recalled.some(memory => memory.id === episode));
  } finally { store.close(); }
`;
const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
  cwd: project,
  encoding: 'utf8',
  timeout: 30_000,
});
assert.equal(result.status, 0, result.stderr);

// Launch from a separate directory and cache, so npm exec cannot reuse the
// project installation above. On npm 12 this exercises default script denial.
const execDir = join(temp, 'exec');
mkdirSync(execDir);
writeFileSync(join(execDir, 'package.json'), '{"private":true}');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    npmCli,
    'exec',
    '--yes',
    '--cache',
    join(temp, 'exec-cache'),
    '--package',
    tarball,
    '--',
    'audrey',
  ],
  cwd: execDir,
  env: {
    ...process.env,
    AUDREY_DATA_DIR: join(temp, 'mcp-store'),
    AUDREY_EMBEDDING_PROVIDER: 'mock',
    AUDREY_LLM_PROVIDER: 'mock',
  },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', chunk => {
  stderr += String(chunk);
});
const client = new Client({ name: 'audrey-install-smoke', version: '1.0.0' });
const deadline = setTimeout(() => {
  console.error(`MCP install smoke exceeded 180 seconds\n${stderr}`);
  void transport.close().finally(() => process.exit(1));
}, 180_000);
try {
  await client.connect(transport, { timeout: 180_000 });
  const tools = await client.listTools();
  assert(tools.tools.some(tool => tool.name === 'memory_recall'));
  const status = await client.callTool({ name: 'memory_status', arguments: {} });
  assert(!status.isError, JSON.stringify(status));
  console.log(
    'PASS: packed install with scripts disabled, local inference imports, audit, encode/recall, fresh-cache npm exec MCP handshake and status',
  );
} finally {
  clearTimeout(deadline);
  await client.close();
}
