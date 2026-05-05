import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PALETTE = {
  audrey: '#0f766e',
  vector: '#0369a1',
  keyword: '#6d28d9',
  recent: '#b45309',
  external: '#1d4ed8',
  accent: '#111827',
  muted: '#6b7280',
  surface: '#f8fafc',
  border: '#cbd5e1',
};

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function chartBarColor(label) {
  if (label === 'Audrey') return PALETTE.audrey;
  if (label.includes('Vector')) return PALETTE.vector;
  if (label.includes('Keyword')) return PALETTE.keyword;
  if (label.includes('Recent')) return PALETTE.recent;
  return PALETTE.external;
}

function renderBarChart({ title, rows, valueSuffix = '%', maxValue = 100 }) {
  const width = 960;
  const height = 420;
  const margin = { top: 56, right: 32, bottom: 88, left: 64 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const barWidth = Math.max(32, Math.floor(plotWidth / Math.max(rows.length, 1)) - 18);
  const gap = rows.length > 1 ? (plotWidth - barWidth * rows.length) / (rows.length - 1) : 0;

  const bars = rows.map((row, index) => {
    const value = Math.max(0, Math.min(maxValue, row.value));
    const barHeight = (value / maxValue) * plotHeight;
    const x = margin.left + index * (barWidth + gap);
    const y = margin.top + plotHeight - barHeight;
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="8" fill="${chartBarColor(row.label)}" />
      <text x="${x + barWidth / 2}" y="${y - 10}" text-anchor="middle" font-size="15" fill="${PALETTE.accent}">${value.toFixed(1)}${valueSuffix}</text>
      <text x="${x + barWidth / 2}" y="${height - 42}" text-anchor="middle" font-size="14" fill="${PALETTE.muted}">${escapeHtml(row.label)}</text>
    `;
  }).join('\n');

  const grid = [0, 25, 50, 75, 100].map(tick => {
    const y = margin.top + plotHeight - (tick / maxValue) * plotHeight;
    return `
      <line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${PALETTE.border}" stroke-dasharray="4 4" />
      <text x="${margin.left - 10}" y="${y + 5}" text-anchor="end" font-size="13" fill="${PALETTE.muted}">${tick}${valueSuffix}</text>
    `;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
  <rect width="100%" height="100%" fill="white" />
  <text x="${margin.left}" y="34" font-size="24" font-weight="700" fill="${PALETTE.accent}">${escapeHtml(title)}</text>
  ${grid}
  ${bars}
</svg>`;
}

function renderTrendList(trends) {
  return trends.map(trend => `
    <li>
      <strong>${escapeHtml(trend.title)}</strong><br />
      ${escapeHtml(trend.summary)}<br />
      <a href="${trend.source}">${escapeHtml(trend.source)}</a>
    </li>
  `).join('\n');
}

function renderCaseRows(localCases) {
  return localCases.map(caseResult => `
    <tr>
      <td>${escapeHtml(caseResult.title)}</td>
      <td>${escapeHtml(caseResult.suite)}</td>
      <td>${escapeHtml(caseResult.family)}</td>
      ${caseResult.results.map(result => {
        const bg = result.passed ? '#ecfdf5' : result.score >= 0.5 ? '#fff7ed' : '#fef2f2';
        const fg = result.passed ? '#065f46' : result.score >= 0.5 ? '#9a3412' : '#991b1b';
        return `<td style="background:${bg};color:${fg}">${result.score.toFixed(2)}<br /><span style="font-size:12px">${escapeHtml(result.summary)}</span></td>`;
      }).join('')}
    </tr>
  `).join('\n');
}

function renderSuiteSections(suiteCharts) {
  if (suiteCharts.length === 0) return '';
  return suiteCharts.map(chart => `
    <section class="callout">
      <h2>${escapeHtml(chart.title)}</h2>
      <p>${escapeHtml(chart.description)}</p>
      <img src="./${escapeHtml(chart.fileName)}" alt="${escapeHtml(chart.title)} chart" />
    </section>
  `).join('\n');
}

export function writeBenchmarkArtifacts({
  outputDir,
  summary,
  localOverall,
  localSuites,
  externalOverall,
  trends,
  readmeAssetsDir,
}) {
  mkdirSync(outputDir, { recursive: true });

  const localChartTitle = summary.local?.overall_scope === 'comparable_suites'
    ? 'Audrey vs Comparable Local Memory Baselines'
    : 'Selected Audrey Regression Suite';
  const localChart = renderBarChart({
    title: localChartTitle,
    rows: localOverall.map(row => ({ label: row.system, value: row.scorePercent })),
  });
  const externalChart = renderBarChart({
    title: 'Published LLM Memory Standards (LoCoMo)',
    rows: externalOverall.map(row => ({ label: row.system, value: row.score })),
  });

  writeFileSync(join(outputDir, 'local-overall.svg'), localChart, 'utf8');
  writeFileSync(join(outputDir, 'published-locomo.svg'), externalChart, 'utf8');
  writeFileSync(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  const suiteCharts = localSuites.map(suite => {
    const fileName = `${suite.id}-overall.svg`;
    const chart = renderBarChart({
      title: `${suite.title} Benchmark`,
      rows: suite.overall.map(row => ({ label: row.system, value: row.scorePercent })),
    });
    writeFileSync(join(outputDir, fileName), chart, 'utf8');
    return {
      id: suite.id,
      title: `${suite.title} Benchmark`,
      description: suite.description,
      fileName,
      path: join(outputDir, fileName),
    };
  });

  let readmeAssets = null;
  if (readmeAssetsDir) {
    mkdirSync(readmeAssetsDir, { recursive: true });
    const localReadmeChart = join(readmeAssetsDir, 'local-benchmark.svg');
    const externalReadmeChart = join(readmeAssetsDir, 'published-memory-standards.svg');
    writeFileSync(localReadmeChart, localChart, 'utf8');
    writeFileSync(externalReadmeChart, externalChart, 'utf8');

    const operationsSuite = suiteCharts.find(chart => chart.id === 'operations');
    let operationsReadmeChart = null;
    if (operationsSuite) {
      operationsReadmeChart = join(readmeAssetsDir, 'operations-benchmark.svg');
      writeFileSync(
        operationsReadmeChart,
        renderBarChart({
          title: 'Audrey Memory Operations Benchmark',
          rows: (localSuites.find(suite => suite.id === 'operations')?.overall || [])
            .map(row => ({ label: row.system, value: row.scorePercent })),
        }),
        'utf8',
      );
    }

    readmeAssets = {
      localChart: localReadmeChart,
      operationsChart: operationsReadmeChart,
      externalChart: externalReadmeChart,
    };
  }

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Audrey Memory Benchmark</title>
  <style>
    body { font-family: "Segoe UI", Arial, sans-serif; margin: 32px; color: ${PALETTE.accent}; background: ${PALETTE.surface}; }
    main { max-width: 1120px; margin: 0 auto; }
    h1, h2 { margin-bottom: 12px; }
    p, li { line-height: 1.5; }
    .callout { background: white; border: 1px solid ${PALETTE.border}; border-radius: 16px; padding: 20px; margin-bottom: 24px; }
    .grid { display: grid; gap: 24px; grid-template-columns: 1fr; }
    img { width: 100%; border: 1px solid ${PALETTE.border}; border-radius: 16px; background: white; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 16px; overflow: hidden; }
    th, td { border: 1px solid ${PALETTE.border}; padding: 12px; vertical-align: top; text-align: left; }
    th { background: #e2e8f0; }
    code { background: #e2e8f0; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <main>
    <h1>Audrey Memory Benchmark</h1>
    <div class="callout">
      <p><strong>Method:</strong> Audrey is scored on a local regression suite inspired by LongMemEval-style retrieval, operation-level lifecycle behavior, and agent guard-loop benchmarks. The combined local chart uses comparable retrieval/lifecycle suites when available; the guard loop is reported as its own controller regression suite. Published external LoCoMo numbers stay separate so the comparison remains honest.</p>
      <p><strong>Scope:</strong> ${escapeHtml(summary.local?.overall_scope ?? 'unknown')} across ${escapeHtml((summary.local?.overall_suite_ids ?? []).join(', '))}; ${summary.local?.cases?.length ?? 0} total cases.</p>
      <p><strong>Run:</strong> <code>${escapeHtml(summary.command)}</code></p>
      <p><strong>Generated:</strong> ${escapeHtml(summary.generatedAt)}</p>
    </div>

    <div class="grid">
      <section class="callout">
        <h2>Combined Local Benchmark</h2>
        <img src="./local-overall.svg" alt="Combined local benchmark bar chart" />
      </section>

      ${renderSuiteSections(suiteCharts)}

      <section class="callout">
        <h2>Published Leaderboard</h2>
        <img src="./published-locomo.svg" alt="Published LoCoMo leaderboard bar chart" />
      </section>
    </div>

    <section class="callout">
      <h2>Case Matrix</h2>
      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>Suite</th>
            <th>Family</th>
            ${summary.local.overall.map(row => `<th>${escapeHtml(row.system)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${renderCaseRows(summary.local.cases)}
        </tbody>
      </table>
    </section>

    <section class="callout">
      <h2>March 23, 2026 Memory Trends</h2>
      <ul>
        ${renderTrendList(trends)}
      </ul>
    </section>
  </main>
</body>
</html>`;

  writeFileSync(join(outputDir, 'report.html'), html, 'utf8');

  return {
    json: join(outputDir, 'summary.json'),
    html: join(outputDir, 'report.html'),
    localChart: join(outputDir, 'local-overall.svg'),
    suiteCharts,
    externalChart: join(outputDir, 'published-locomo.svg'),
    readmeAssets,
  };
}
