import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = 'docs/paper/output/arxiv';
const SOURCE_MARKDOWN = 'docs/paper/audrey-paper-v1.md';
const SOURCE_BIB = 'docs/paper/references.bib';
const PUBLICATION_PACK = 'docs/paper/publication-pack.json';
const MANIFEST_FILE = 'arxiv-manifest.json';
const SEEDED_SECRET = 'sk-guardbench-secret-0000000000000000000000000000';

function fromRoot(path) {
  return resolve(ROOT, path);
}

function readText(path) {
  return readFileSync(fromRoot(path), 'utf-8');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function countBibEntries(text) {
  return [...text.matchAll(/@\w+\s*\{/g)].length;
}

function sanitizePublicText(text) {
  return text
    .replaceAll(SEEDED_SECRET, '[REDACTED:guardbench_seeded_secret]')
    .replace(/\b[A-Z]:\\[^\s`|)\]]+/g, '[LOCAL-PATH]');
}

function latexEscape(text) {
  return text
    .replaceAll('\\', '\\textbackslash{}')
    .replaceAll('&', '\\&')
    .replaceAll('%', '\\%')
    .replaceAll('$', '\\$')
    .replaceAll('#', '\\#')
    .replaceAll('_', '\\_')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}')
    .replaceAll('~', '\\textasciitilde{}')
    .replaceAll('^', '\\textasciicircum{}');
}

function protectInline(text) {
  const tokens = [];
  const protect = value => {
    const token = `@@AUDREY_LATEX_TOKEN_${tokens.length}@@`;
    tokens.push([token, value]);
    return token;
  };

  let next = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) =>
    protect(`\\href{${latexEscape(url)}}{${latexEscape(label)}}`));
  next = next.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
    protect(`\\texttt{${latexEscape(label)}} (${latexEscape(url)})`));
  next = next.replace(/\[@([^\]]+)\]/g, (_, rawIds) => {
    const ids = rawIds
      .split(/;\s*@?|\s*,\s*@?/)
      .map(id => id.replace(/^@/, '').trim())
      .filter(Boolean);
    return protect(`\\cite{${ids.join(',')}}`);
  });
  next = next.replace(/`([^`]+)`/g, (_, value) => protect(`\\texttt{${latexEscape(value)}}`));
  next = latexEscape(next);
  for (const [token, value] of tokens) next = next.replaceAll(latexEscape(token), value);
  return next;
}

function latexCommandForHeading(level) {
  if (level <= 2) return 'section';
  if (level === 3) return 'subsection';
  return 'subsubsection';
}

function isTableLine(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function flushParagraph(lines, output) {
  if (!lines.length) return;
  output.push(`${protectInline(lines.join(' ').replace(/\s+/g, ' ').trim())}\n`);
  lines.length = 0;
}

function flushList(items, output, environment) {
  if (!items.length) return;
  output.push(`\\begin{${environment}}`);
  for (const item of items) output.push(`\\item ${protectInline(item)}`);
  output.push(`\\end{${environment}}\n`);
  items.length = 0;
}

function markdownToLatex(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const output = [];
  const paragraph = [];
  const bullets = [];
  const numbers = [];
  let inCode = false;
  let code = [];
  let codeBlocks = 0;
  let tableBlocks = 0;
  let skippedTitle = false;

  function flushInlineBlocks() {
    flushParagraph(paragraph, output);
    flushList(bullets, output, 'itemize');
    flushList(numbers, output, 'enumerate');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      if (inCode) {
        output.push('\\begin{verbatim}');
        output.push(...code);
        output.push('\\end{verbatim}\n');
        code = [];
        inCode = false;
        codeBlocks += 1;
      } else {
        flushInlineBlocks();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (isTableLine(line)) {
      flushInlineBlocks();
      const table = [];
      while (i < lines.length && isTableLine(lines[i])) {
        if (!isTableSeparator(lines[i])) table.push(lines[i]);
        i += 1;
      }
      i -= 1;
      output.push('\\begin{verbatim}');
      output.push(...table);
      output.push('\\end{verbatim}\n');
      tableBlocks += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushInlineBlocks();
      if (!skippedTitle && heading[1].length === 1) {
        skippedTitle = true;
        continue;
      }
      const command = latexCommandForHeading(heading[1].length);
      output.push(`\\${command}{${protectInline(heading[2])}}\n`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph(paragraph, output);
      flushList(numbers, output, 'enumerate');
      bullets.push(bullet[1]);
      continue;
    }
    const numbered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (numbered) {
      flushParagraph(paragraph, output);
      flushList(bullets, output, 'itemize');
      numbers.push(numbered[1]);
      continue;
    }
    if (!line.trim()) {
      flushInlineBlocks();
      continue;
    }
    paragraph.push(line.trim());
  }
  flushInlineBlocks();

  return {
    body: output.join('\n'),
    codeBlocks,
    tableBlocks,
    citationCount: [...output.join('\n').matchAll(/\\cite\{/g)].length,
  };
}

function publicationEntry(pack, id) {
  const entry = pack.entries.find(row => row.id === id);
  if (!entry) throw new Error(`Missing publication-pack entry: ${id}`);
  return entry.text;
}

function buildLatex() {
  const pack = readJson(PUBLICATION_PACK);
  const markdown = sanitizePublicText(readText(SOURCE_MARKDOWN));
  const converted = markdownToLatex(markdown);
  const title = publicationEntry(pack, 'arxiv-title');
  const abstract = sanitizePublicText(publicationEntry(pack, 'arxiv-abstract'));

  const tex = `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{hyperref}
\\usepackage{url}
\\usepackage{verbatim}

\\title{${protectInline(title)}}
\\author{Tyler Eveland}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
${protectInline(abstract)}
\\end{abstract}

${converted.body}

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`;

  return {
    tex,
    citationCount: converted.citationCount,
    codeBlocks: converted.codeBlocks,
    tableBlocks: converted.tableBlocks,
  };
}

function fileRecord(outDir, path, source) {
  const absolute = join(outDir, path);
  return {
    path,
    source,
    bytes: readFileSync(absolute).byteLength,
    sha256: sha256File(absolute),
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    outDir: DEFAULT_OUT_DIR,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--out-dir' && argv[i + 1]) args.outDir = argv[++i];
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return `Usage: node scripts/create-arxiv-source.mjs [options]

Options:
  --out-dir <path>  Output directory. Default: ${DEFAULT_OUT_DIR}.
  --json            Print the machine-readable manifest.
`;
}

export function writeArxivSourcePackage(options = {}) {
  const outDir = resolve(ROOT, options.outDir ?? DEFAULT_OUT_DIR);
  const bib = readText(SOURCE_BIB);
  const built = buildLatex();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, 'main.tex'), built.tex, 'utf-8');
  cpSync(fromRoot(SOURCE_BIB), join(outDir, 'references.bib'));
  writeFileSync(join(outDir, 'README-arxiv.txt'), [
    'Audrey arXiv source package',
    '',
    'Main file: main.tex',
    'Bibliography: references.bib',
    '',
    'Generated from docs/paper/audrey-paper-v1.md and docs/paper/publication-pack.json.',
    'This host did not require a local TeX compiler to generate the source package.',
    'Before final arXiv upload, compile with a TeX toolchain and preview the PDF in arXiv.',
    '',
  ].join('\n'), 'utf-8');

  const files = [
    fileRecord(outDir, 'main.tex', SOURCE_MARKDOWN),
    fileRecord(outDir, 'references.bib', SOURCE_BIB),
    fileRecord(outDir, 'README-arxiv.txt', 'generated'),
  ];
  const manifest = {
    schemaVersion: '1.0.0',
    suite: 'Audrey arXiv source package',
    generatedAt: new Date().toISOString(),
    sourceMarkdown: SOURCE_MARKDOWN,
    publicationPack: PUBLICATION_PACK,
    sourceHashes: {
      sourceMarkdown: sha256File(fromRoot(SOURCE_MARKDOWN)),
      publicationPack: sha256File(fromRoot(PUBLICATION_PACK)),
      referencesBib: sha256File(fromRoot(SOURCE_BIB)),
    },
    files,
    tex: {
      mainFile: 'main.tex',
      titleEntry: 'arxiv-title',
      abstractEntry: 'arxiv-abstract',
      citationCount: built.citationCount,
      bibEntryCount: countBibEntries(bib),
      codeBlocks: built.codeBlocks,
      tableBlocks: built.tableBlocks,
    },
  };
  writeFileSync(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  return {
    outDir,
    manifestPath: join(outDir, MANIFEST_FILE),
    manifest,
    files: files.map(file => file.path),
  };
}

function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = writeArxivSourcePackage(args);
  if (args.json) console.log(JSON.stringify(result.manifest, null, 2));
  else {
    console.log(`arXiv source package: ${result.outDir}`);
    console.log(`Files: ${result.files.length}`);
    console.log(`Manifest: ${result.manifestPath}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exit(1);
  }
}
