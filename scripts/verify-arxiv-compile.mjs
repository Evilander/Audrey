import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { validateSchema } from '../benchmarks/validate-guardbench-artifacts.mjs';
import { publicPath } from '../benchmarks/public-paths.mjs';
import { verifyArxivSourcePackage } from './verify-arxiv-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE_DIR = 'docs/paper/output/arxiv';
const DEFAULT_OUT_DIR = 'docs/paper/output/arxiv-compile';
const DEFAULT_REPORT = 'docs/paper/output/arxiv-compile-report.json';
const DEFAULT_SCHEMA = 'docs/paper/arxiv-compile-report.schema.json';
const MAIN_TEX = 'main.tex';
const REFERENCES_BIB = 'references.bib';
const TECTONIC_BUNDLE_URL = 'https://data1.fullyjustified.net/tlextras-2022.0r0.tar';

function fromRoot(path) {
  return resolve(ROOT, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(fromRoot(path), 'utf-8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function pathForReport(path) {
  const rel = relative(ROOT, path);
  if (rel && !rel.startsWith('..')) return rel.replaceAll('\\', '/');
  return publicPath(path);
}

function commandExists(command) {
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'where', command], { encoding: 'utf-8' })
    : spawnSync('sh', ['-lc', `command -v ${command}`], { encoding: 'utf-8' });
  return result.status === 0;
}

function compilerPlan(exists = commandExists) {
  if (exists('tectonic')) {
    return {
      name: 'tectonic',
      stages: [
        { command: 'tectonic', args: ['--keep-logs', '--keep-intermediates', MAIN_TEX] },
      ],
    };
  }
  if (exists('latexmk')) {
    return {
      name: 'latexmk',
      stages: [
        { command: 'latexmk', args: ['-pdf', '-interaction=nonstopmode', '-halt-on-error', MAIN_TEX] },
      ],
    };
  }
  if (exists('pdflatex') && exists('bibtex')) {
    return {
      name: 'pdflatex+bibtex',
      stages: [
        { command: 'pdflatex', args: ['-interaction=nonstopmode', '-halt-on-error', MAIN_TEX] },
        { command: 'bibtex', args: ['main'] },
        { command: 'pdflatex', args: ['-interaction=nonstopmode', '-halt-on-error', MAIN_TEX] },
        { command: 'pdflatex', args: ['-interaction=nonstopmode', '-halt-on-error', MAIN_TEX] },
      ],
    };
  }
  if (exists('uvx')) {
    return {
      name: 'uvx-tecto',
      bundleProxy: true,
      stages: [
        {
          command: 'uvx',
          args: ['tecto', '-X', 'compile', '--bundle', '__TECTONIC_BUNDLE_URL__', '--keep-logs', '--keep-intermediates', '--reruns', '2', MAIN_TEX],
        },
      ],
    };
  }
  return null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dir: DEFAULT_SOURCE_DIR,
    outDir: DEFAULT_OUT_DIR,
    report: DEFAULT_REPORT,
    schema: DEFAULT_SCHEMA,
    allowMissing: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--dir' || token === '--source-dir') && argv[i + 1]) args.dir = argv[++i];
    else if (token === '--out-dir' && argv[i + 1]) args.outDir = argv[++i];
    else if (token === '--report' && argv[i + 1]) args.report = argv[++i];
    else if (token === '--schema' && argv[i + 1]) args.schema = argv[++i];
    else if (token === '--allow-missing') args.allowMissing = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return `Usage: node scripts/verify-arxiv-compile.mjs [options]

Options:
  --dir <path>       arXiv source directory. Default: ${DEFAULT_SOURCE_DIR}.
  --out-dir <path>   Compile output directory. Default: ${DEFAULT_OUT_DIR}.
  --report <path>    Compile report JSON. Default: ${DEFAULT_REPORT}.
  --schema <path>    Compile report schema. Default: ${DEFAULT_SCHEMA}.
  --allow-missing    Exit 0 when no supported TeX toolchain is installed.
  --json             Print the machine-readable compile report.
`;
}

function sourceSnapshot(sourceDir) {
  const manifestPath = join(sourceDir, 'arxiv-manifest.json');
  const mainPath = join(sourceDir, MAIN_TEX);
  const bibPath = join(sourceDir, REFERENCES_BIB);
  return {
    sourceDir: pathForReport(sourceDir),
    manifest: pathForReport(manifestPath),
    manifestSha256: sha256File(manifestPath),
    mainTex: pathForReport(mainPath),
    mainTexSha256: sha256File(mainPath),
    referencesBib: pathForReport(bibPath),
    referencesBibSha256: sha256File(bibPath),
  };
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
}

async function startTectonicBundleProxy(bundleUrl = TECTONIC_BUNDLE_URL) {
  const bundle = new URL(bundleUrl);
  const tarPath = bundle.pathname;
  const indexPath = `${tarPath}.index.gz`;
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      let remoteUrl = null;
      if (requestUrl.pathname === tarPath) remoteUrl = bundleUrl;
      else if (requestUrl.pathname === indexPath) remoteUrl = `${bundleUrl}.index.gz`;
      if (!remoteUrl) {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      const headers = {};
      if (request.headers.range) headers.range = request.headers.range;
      const upstream = await fetch(remoteUrl, { headers });
      response.statusCode = upstream.status;
      for (const header of ['accept-ranges', 'content-length', 'content-range', 'content-type', 'etag', 'last-modified']) {
        const value = upstream.headers.get(header);
        if (value) response.setHeader(header, value);
      }
      if (!upstream.body) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body).pipe(response);
    } catch (error) {
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error?.message ?? 'bundle proxy error');
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}${tarPath}`,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  };
}

function stageWithBundle(stage, bundleUrl) {
  return {
    command: stage.command,
    args: stage.args.map(arg => arg === '__TECTONIC_BUNDLE_URL__' ? bundleUrl : arg),
  };
}

function runStage(stage, cwd) {
  return new Promise(resolveRun => {
    const child = spawn(stage.command, stage.args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        resolveRun({ status: 1, signal: 'TIMEOUT', stdout, stderr: `${stderr}\nTimed out after 120000ms`.trim() });
      }
    }, 120000);

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.once('error', error => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolveRun({ status: 1, error, stdout, stderr: `${stderr}\n${error.message}`.trim() });
      }
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolveRun({ status, signal, stdout, stderr });
      }
    });
  });
}

export async function verifyArxivCompile(options = {}) {
  const sourceDir = fromRoot(options.dir ?? DEFAULT_SOURCE_DIR);
  const outDir = fromRoot(options.outDir ?? DEFAULT_OUT_DIR);
  const reportPath = fromRoot(options.report ?? DEFAULT_REPORT);
  const now = options.now ?? new Date().toISOString();
  const failures = [];
  const blockers = [];
  const sourceReport = verifyArxivSourcePackage({ dir: pathForReport(sourceDir) });
  const source = sourceReport.ok ? sourceSnapshot(sourceDir) : null;

  if (!sourceReport.ok) {
    failures.push(...sourceReport.failures.map(failure => `arXiv source: ${failure}`));
    const report = {
      schemaVersion: '1.0.0',
      suite: 'Audrey arXiv compile check',
      generatedAt: now,
      source,
      outputDir: pathForReport(outDir),
      status: 'failed',
      compiler: null,
      outputPdf: null,
      outputPdfSha256: null,
      logFile: null,
      blockers,
      failures,
    };
    writeReport(reportPath, report);
    return report;
  }

  const plan = compilerPlan(options.commandExists ?? commandExists);
  if (!plan) {
    blockers.push('Install tectonic, latexmk, or pdflatex+bibtex before final arXiv compile proof');
    const report = {
      schemaVersion: '1.0.0',
      suite: 'Audrey arXiv compile check',
      generatedAt: now,
      source,
      outputDir: pathForReport(outDir),
      status: 'toolchain-missing',
      compiler: null,
      outputPdf: null,
      outputPdfSha256: null,
      logFile: null,
      blockers,
      failures,
    };
    writeReport(reportPath, report);
    return report;
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(join(sourceDir, MAIN_TEX), join(outDir, MAIN_TEX));
  cpSync(join(sourceDir, REFERENCES_BIB), join(outDir, REFERENCES_BIB));

  let proxy = null;
  const logLines = [];
  try {
    proxy = plan.bundleProxy ? await startTectonicBundleProxy() : null;
    const stages = proxy ? plan.stages.map(stage => stageWithBundle(stage, proxy.url)) : plan.stages;
    for (const stage of stages) {
      logLines.push(`$ ${stage.command} ${stage.args.join(' ')}`);
      const result = await runStage(stage, outDir);
      if (result.stdout) logLines.push(result.stdout.trim());
      if (result.stderr) logLines.push(result.stderr.trim());
      if (result.status !== 0) {
        failures.push(`${stage.command} exited ${result.status ?? result.signal ?? 'unknown'}`);
        break;
      }
    }
  } finally {
    await proxy?.close();
  }
  const logPath = join(outDir, 'arxiv-compile.log');
  writeFileSync(logPath, `${logLines.filter(Boolean).join('\n\n')}\n`, 'utf-8');

  const pdfPath = join(outDir, 'main.pdf');
  if (!existsSync(pdfPath)) failures.push('main.pdf was not produced by the TeX compiler');
  const status = failures.length ? 'failed' : 'passed';
  const report = {
    schemaVersion: '1.0.0',
    suite: 'Audrey arXiv compile check',
    generatedAt: now,
    source,
    outputDir: pathForReport(outDir),
    status,
    compiler: {
      name: plan.name,
      stages: plan.stages.map(stage => ({ command: stage.command, args: stage.args })),
    },
    outputPdf: existsSync(pdfPath) ? pathForReport(pdfPath) : null,
    outputPdfSha256: existsSync(pdfPath) ? sha256File(pdfPath) : null,
    logFile: pathForReport(logPath),
    blockers,
    failures,
  };
  writeReport(reportPath, report);
  return report;
}

export function verifyArxivCompileReport(options = {}) {
  const reportPath = fromRoot(options.report ?? DEFAULT_REPORT);
  const schemaPath = fromRoot(options.schema ?? DEFAULT_SCHEMA);
  const allowPending = options.allowPending !== false;
  const failures = [];
  const blockers = [];
  let report = null;

  try {
    report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  } catch (error) {
    return {
      ok: false,
      report: pathForReport(reportPath),
      status: 'missing',
      blockers: [],
      failures: [`arxiv-compile-report.json: ${error.message}`],
    };
  }

  try {
    failures.push(...validateSchema(report, readJson(pathForReport(schemaPath)), 'audrey-arxiv-compile-report'));
  } catch (error) {
    failures.push(`schema: ${error.message}`);
  }

  const source = report.source;
  if (source) {
    const sourceChecks = [
      ['manifestSha256', source.manifest],
      ['mainTexSha256', source.mainTex],
      ['referencesBibSha256', source.referencesBib],
    ];
    for (const [hashKey, file] of sourceChecks) {
      const absolute = fromRoot(file);
      if (!existsSync(absolute)) {
        failures.push(`arxiv-compile-report.json: source file missing: ${file}`);
      } else if (report.source?.[hashKey] !== sha256File(absolute)) {
        failures.push(`arxiv-compile-report.json: ${file} changed since compile report`);
      }
    }
  }

  if (report.status === 'toolchain-missing') {
    blockers.push(...(report.blockers?.length ? report.blockers : ['TeX toolchain is missing']));
  } else if (report.status === 'failed') {
    failures.push(...(report.failures?.length ? report.failures : ['arXiv compile failed']));
  } else if (report.status === 'passed') {
    if (!report.outputPdf || !existsSync(fromRoot(report.outputPdf))) failures.push('arxiv-compile-report.json: outputPdf is missing');
    if (report.outputPdf && report.outputPdfSha256 && sha256File(fromRoot(report.outputPdf)) !== report.outputPdfSha256) {
      failures.push('arxiv-compile-report.json: outputPdfSha256 is stale');
    }
  }

  return {
    ok: failures.length === 0 && (allowPending || blockers.length === 0),
    report: pathForReport(reportPath),
    status: report.status,
    compiler: report.compiler?.name ?? null,
    blockers,
    failures,
  };
}

function exitCode(report, allowMissing) {
  if (report.status === 'passed') return 0;
  if (report.status === 'toolchain-missing' && allowMissing) return 0;
  return 1;
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = await verifyArxivCompile(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.status === 'passed') {
    console.log(`arXiv compile check passed: ${report.outputPdf}`);
  } else if (report.status === 'toolchain-missing') {
    console.log(`arXiv compile check pending: ${report.blockers.join('; ')}`);
  } else {
    console.error('arXiv compile check failed:');
    for (const failure of report.failures) console.error(`- ${failure}`);
  }

  process.exit(exitCode(report, args.allowMissing));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exit(1);
  }
}
