import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { guardBenchManifest, loadExternalAdapters, runGuardBench, validateAdapterResult } from '../benchmarks/guardbench.js';
import mem0Adapter, { createGuardBenchAdapter as createMem0GuardBenchAdapter } from '../benchmarks/adapters/mem0-platform.mjs';
import zepAdapter, { createGuardBenchAdapter as createZepGuardBenchAdapter } from '../benchmarks/adapters/zep-cloud.mjs';
import { writeGuardBenchConformanceCard } from '../benchmarks/create-conformance-card.mjs';
import { bundleRelativeFilePath, writeGuardBenchSubmissionBundle } from '../benchmarks/create-submission-bundle.mjs';
import { writeGuardBenchLeaderboard } from '../benchmarks/build-leaderboard.mjs';
import { defineGuardBenchAdapter, defineGuardBenchResult } from '../benchmarks/adapter-kit.mjs';
import { validateAdapterModuleFile } from '../benchmarks/validate-adapter-module.mjs';
import { validateAdapterRegistry } from '../benchmarks/validate-adapter-registry.mjs';
import { runGuardBenchAdapterSelfTest, validateAdapterSelfTestReport } from '../benchmarks/adapter-self-test.mjs';
import { validateAdapterSelfTestFile } from '../benchmarks/validate-adapter-self-test.mjs';
import { validatePublicationVerificationReport, verifyGuardBenchPublicationArtifacts } from '../benchmarks/verify-publication-artifacts.mjs';
import { buildExternalGuardBenchRun, evaluateAdapterConformance, parseExternalArgs } from '../benchmarks/run-external-guardbench.mjs';
import { buildExternalAdapterDryRunMatrix, validateExternalAdapterDryRunMatrix } from '../benchmarks/dry-run-external-adapters.mjs';
import { validateExternalEvidenceReport, verifyExternalGuardBenchEvidence } from '../benchmarks/verify-external-evidence.mjs';
import { computeGuardBenchArtifactHashes, validateGuardBenchArtifacts } from '../benchmarks/validate-guardbench-artifacts.mjs';
import { verifyGuardBenchSubmissionBundle } from '../benchmarks/verify-submission-bundle.mjs';
import { writeArxivSourcePackage } from '../scripts/create-arxiv-source.mjs';
import { writePaperSubmissionBundle } from '../scripts/create-paper-submission-bundle.mjs';
import { verifyArxivSourcePackage } from '../scripts/verify-arxiv-source.mjs';
import { verifyArxivCompile, verifyArxivCompileReport } from '../scripts/verify-arxiv-compile.mjs';
import { verifyBrowserLaunchPlan } from '../scripts/verify-browser-launch-plan.mjs';
import { verifyBrowserLaunchResults } from '../scripts/verify-browser-launch-results.mjs';
import { verifyPaperClaims } from '../scripts/verify-paper-claims.mjs';
import { verifyPaperSubmissionBundle } from '../scripts/verify-paper-submission-bundle.mjs';
import { verifyPublicationPack } from '../scripts/verify-publication-pack.mjs';
import { insertChangelogSection, prepareReleaseCut, releaseChangelogSection } from '../scripts/prepare-release-cut.mjs';
import { npmPackageTargetStatus, remoteBranchFreshnessStatus, targetChangelogStatus, verifyReleaseReadiness } from '../scripts/verify-release-readiness.mjs';

function withArtifactCopy(edit) {
  const root = 'benchmarks/.tmp-guardbench';
  mkdirSync(root, { recursive: true });
  const tempDir = mkdtempSync(join(root, 'validator-'));
  try {
    for (const file of ['guardbench-manifest.json', 'guardbench-summary.json', 'guardbench-raw.json']) {
      cpSync(join('benchmarks/output', file), join(tempDir, file));
    }
    edit(tempDir);
    return validateGuardBenchArtifacts({ dir: tempDir });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('GuardBench harness', () => {
  it('publishes scenario seeds and external adapter subjects in the manifest', () => {
    const manifest = guardBenchManifest([{
      name: 'Fixture Adapter',
      description: 'Test-only adapter.',
      decide: async () => ({ decision: 'allow' }),
    }]);

    expect(manifest.subjects.some(subject => subject.name === 'Fixture Adapter' && subject.external)).toBe(true);
    expect(manifest.scenarios).toHaveLength(10);
    expect(manifest.scenarios.every(scenario => scenario.seed && scenario.expectedEvidenceClass)).toBe(true);
    const redactionScenario = manifest.scenarios.find(scenario => scenario.id === 'GB-08');
    expect(redactionScenario.seed.seededSecretRefs).toHaveLength(1);
    expect(JSON.stringify(redactionScenario)).not.toContain('sk-guardbench-secret');
  });

  it('scores external adapters without exposing expected answers at runtime', async () => {
    const seen = [];
    const report = await runGuardBench({
      externalAdapters: [{
        name: 'Fixture Adapter',
        description: 'Always allows; verifies runtime scenario shape.',
        async decide({ scenario }) {
          seen.push({
            hasExpectedDecision: Object.hasOwn(scenario, 'expectedDecision'),
            hasRequiredEvidence: Object.hasOwn(scenario, 'requiredEvidence'),
            hasSeed: Boolean(scenario.seed),
            hasPrivateSeed: Boolean(scenario.privateSeed),
          });
          return {
            decision: 'allow',
            riskScore: 0,
            evidenceIds: [],
            recommendedActions: [],
            summary: 'Fixture adapter allowed the action.',
          };
        },
      }],
    });

    const fixture = report.systemSummaries.find(summary => summary.system === 'Fixture Adapter');
    expect(fixture).toBeDefined();
    expect(fixture.scenarios).toBe(10);
    expect(fixture.decisionAccuracy).toBe(0.1);
    expect(seen).toHaveLength(10);
    expect(seen.every(entry => entry.hasSeed)).toBe(true);
    expect(seen.find((entry, index) => index === 7).hasPrivateSeed).toBe(true);
    expect(seen.some(entry => entry.hasExpectedDecision || entry.hasRequiredEvidence)).toBe(false);
  }, 20_000);

  it('rejects malformed external adapter decisions instead of silently coercing them', async () => {
    await expect(runGuardBench({
      externalAdapters: [{
        name: 'Malformed Adapter',
        description: 'Returns an invalid benchmark result.',
        async decide() {
          return {
            decision: 'maybe',
            riskScore: 2,
            evidenceIds: ['bad-evidence'],
            recommendedActions: [],
            summary: 'This should fail contract validation.',
          };
        },
      }],
    })).rejects.toThrow(/Malformed Adapter returned invalid result for GB-01: decision must be one of allow, warn, block; riskScore must be a finite number between 0 and 1/);
  }, 20_000);

  it('validates the external adapter result contract directly', () => {
    expect(validateAdapterResult({
      decision: 'warn',
      riskScore: 0.5,
      evidenceIds: ['mem-1'],
      recommendedActions: ['Review remembered procedure.'],
      summary: 'Adapter found a remembered procedure.',
    }, 'Fixture Adapter', 'GB-02')).toEqual({
      decision: 'warn',
      riskScore: 0.5,
      evidenceIds: ['mem-1'],
      recommendedActions: ['Review remembered procedure.'],
      summary: 'Adapter found a remembered procedure.',
      recallErrors: [],
    });

    expect(() => validateAdapterResult({
      decision: 'allow',
      riskScore: 0,
      evidenceIds: [42],
      recommendedActions: [],
      summary: '',
      recallErrors: 'none',
    }, 'Fixture Adapter', 'GB-02')).toThrow(/evidenceIds must contain only strings; summary must be a non-empty string; recallErrors must be an array when present/);
  });

  it('ships a Mem0 Platform external adapter without requiring credentials at import time', () => {
    const adapter = createMem0GuardBenchAdapter({ apiKey: 'test-key', baseUrl: 'https://api.mem0.ai' });

    expect(mem0Adapter.name).toBe('Mem0 Platform');
    expect(adapter.name).toBe('Mem0 Platform');
    expect(adapter.description).toContain('Mem0 Platform REST adapter');
    expect(typeof adapter.setup).toBe('function');
    expect(typeof adapter.decide).toBe('function');
    expect(typeof adapter.cleanup).toBe('function');
  });

  it('ships a Zep Cloud external adapter without requiring credentials at import time', () => {
    const adapter = createZepGuardBenchAdapter({ apiKey: 'test-key', baseUrl: 'https://api.getzep.com' });

    expect(zepAdapter.name).toBe('Zep Cloud');
    expect(adapter.name).toBe('Zep Cloud');
    expect(adapter.description).toContain('Zep Cloud REST adapter');
    expect(typeof adapter.setup).toBe('function');
    expect(typeof adapter.decide).toBe('function');
    expect(typeof adapter.cleanup).toBe('function');
  });

  it('loads external adapter modules from disk', async () => {
    const adapters = await loadExternalAdapters(['benchmarks/adapters/example-allow.mjs']);

    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toBe('Example Allow Adapter');
    expect(typeof adapters[0].decide).toBe('function');
  });

  it('exports a small adapter author kit for module and result validation', () => {
    const adapter = defineGuardBenchAdapter({
      name: 'Inline Kit Adapter',
      async decide() {
        return defineGuardBenchResult({
          decision: 'warn',
          riskScore: 0.5,
          evidenceIds: ['kit-evidence'],
          recommendedActions: ['Inspect remembered procedure.'],
          summary: 'Inline adapter produced a contract-valid warning.',
        }, 'Inline Kit Adapter', 'GB-kit');
      },
    });

    expect(adapter.name).toBe('Inline Kit Adapter');
    expect(() => defineGuardBenchAdapter({ name: 'Missing Decide' })).toThrow(/must define async decide/);
    expect(() => defineGuardBenchResult({
      decision: 'maybe',
      riskScore: 2,
      evidenceIds: [],
      recommendedActions: [],
      summary: 'bad',
    }, 'Inline Kit Adapter', 'GB-kit')).toThrow(/decision must be one of allow, warn, block/);
  });

  it('validates adapter module shape without running GuardBench scenarios', async () => {
    const validation = await validateAdapterModuleFile({
      adapter: 'benchmarks/adapters/example-allow.mjs',
    });

    expect(validation.ok).toBe(true);
    expect(validation.adapter.name).toBe('Example Allow Adapter');
    expect(validation.adapter.hasSetup).toBe(true);
    expect(validation.adapter.hasDecide).toBe(true);
    expect(validation.adapter.hasCleanup).toBe(true);
  });

  it('rejects malformed adapter modules before self-test execution', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'module-bad-'));
    const adapterPath = join(tempDir, 'missing-decide.mjs');
    try {
      writeFileSync(adapterPath, `export default {
  name: 'Missing Decide Adapter',
  description: 'Invalid adapter module.'
};
`, 'utf-8');

      const validation = await validateAdapterModuleFile({ adapter: adapterPath });

      expect(validation.ok).toBe(false);
      expect(validation.failures.join('\n')).toContain('must define async decide');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('validates the GuardBench adapter registry', async () => {
    const validation = await validateAdapterRegistry();

    expect(validation.ok).toBe(true);
    expect(validation.adapters.map(row => row.id)).toEqual(['example-allow', 'mem0-platform', 'zep-cloud']);
    expect(validation.adapters.find(row => row.id === 'example-allow').ok).toBe(true);
    expect(validation.adapters.find(row => row.id === 'mem0-platform').ok).toBe(true);
    expect(validation.adapters.find(row => row.id === 'mem0-platform').adapter.hasSetup).toBe(true);
    expect(validation.adapters.find(row => row.id === 'zep-cloud').ok).toBe(true);
    expect(validation.adapters.find(row => row.id === 'zep-cloud').adapter.hasSetup).toBe(true);
  });

  it('verifies the full public GuardBench artifact set', async () => {
    const report = await verifyGuardBenchPublicationArtifacts();

    expect(report.ok).toBe(true);
    expect(report.checks.registry.ok).toBe(true);
    expect(report.checks.adapterModule.ok).toBe(true);
    expect(report.checks.selfTest.ok).toBe(true);
    expect(report.checks.artifacts.ok).toBe(true);
    expect(report.checks.bundle.ok).toBe(true);
    expect(report.checks.externalDryRun.ok).toBe(true);
    expect(report.checks.externalEvidence.ok).toBe(true);
    expect(report.checks.leaderboard.ok).toBe(true);
    expect(report.checks.localPaths.ok).toBe(true);
    expect(validatePublicationVerificationReport(report)).toEqual([]);
  });

  it('rejects incomplete public GuardBench artifact sets', async () => {
    const report = await verifyGuardBenchPublicationArtifacts({
      leaderboard: 'benchmarks/.tmp-guardbench/missing-leaderboard.json',
    });

    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('leaderboard: Missing GuardBench leaderboard');
    expect(validatePublicationVerificationReport(report)).toEqual([]);
  });

  it('rejects missing external dry-run matrices in public GuardBench artifact sets', async () => {
    const report = await verifyGuardBenchPublicationArtifacts({
      externalDryRun: 'benchmarks/.tmp-guardbench/missing-external-dry-run.json',
    });

    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('externalDryRun: Missing GuardBench external adapter dry-run matrix');
    expect(validatePublicationVerificationReport(report)).toEqual([]);
  });

  it('rejects missing external evidence reports in public GuardBench artifact sets', async () => {
    const report = await verifyGuardBenchPublicationArtifacts({
      externalEvidence: 'benchmarks/.tmp-guardbench/missing-external-evidence.json',
    });

    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('externalEvidence: Missing GuardBench external evidence report');
    expect(validatePublicationVerificationReport(report)).toEqual([]);
  });

  it('schema-validates publication verifier reports', async () => {
    const report = await verifyGuardBenchPublicationArtifacts();
    const malformed = structuredClone(report);
    delete malformed.checks.externalEvidence;

    expect(validatePublicationVerificationReport(report)).toEqual([]);
    expect(validatePublicationVerificationReport(malformed).join('\n')).toContain('guardbench-publication-verification.checks: missing required property externalEvidence');
  });

  it('verifies the paper claim register against current artifacts', async () => {
    const report = await verifyPaperClaims();

    expect(report.ok).toBe(true);
    expect(report.claims.map(claim => claim.id)).toEqual(['C01', 'C02', 'C03', 'C04']);
    expect(report.claims.find(claim => claim.id === 'C02').status).toBe('pending');
  });

  it('verifies the publication pack against current paper claims', async () => {
    const report = await verifyPublicationPack();

    expect(report.ok).toBe(true);
    expect(report.entries.map(entry => entry.id)).toContain('arxiv-abstract');
    const firstXPost = report.entries.find(entry => entry.id === 'x-post-1');
    expect(firstXPost.chars).toBeLessThanOrEqual(256);
    expect(firstXPost.requiresArtifactUrl).toBe(true);
    expect(firstXPost.reservedUrlChars).toBe(24);
    expect(firstXPost.effectiveChars).toBeLessThanOrEqual(280);
  });

  it('verifies the browser launch plan against current publication copy', async () => {
    const report = await verifyBrowserLaunchPlan();

    expect(report.ok).toBe(true);
    expect(report.targets.map(target => target.id)).toEqual([
      'arxiv-preprint',
      'hacker-news-show',
      'reddit-discussion',
      'x-launch-thread',
      'linkedin-launch-post',
    ]);
    expect(report.targets.find(target => target.id === 'reddit-discussion').manualRuleCheckRequired).toBe(true);
    expect(report.targets.find(target => target.id === 'x-launch-thread').contentEntryIds).toEqual(['x-post-1', 'x-post-2']);
  });

  it('verifies browser launch results while keeping unsubmitted targets explicit', async () => {
    const report = await verifyBrowserLaunchResults();

    expect(report.ok).toBe(true);
    expect(report.ready).toBe(false);
    expect(report.targets).toHaveLength(5);
    const byId = new Map(report.targets.map(target => [target.id, target]));
    expect(byId.get('reddit-discussion')?.status).toBe('submitted');
    expect(byId.get('linkedin-launch-post')?.status).toBe('submitted');
    expect(byId.get('arxiv-preprint')?.status).toBe('pending');
    expect(byId.get('hacker-news-show')?.status).toBe('submitted');
    expect(byId.get('x-launch-thread')?.status).toBe('pending');
    expect(report.blockers.join('\n')).toContain('arxiv-preprint');
    expect(report.blockers.join('\n')).toContain('x-launch-thread');
    expect(report.blockers.join('\n')).not.toContain('reddit-discussion');
  });

  it('requires submitted marketing launch results to include the GitHub repo URL', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'browser-results-'));
    const tempResults = join(tempDir, 'browser-launch-results.json');
    try {
      const results = JSON.parse(readFileSync('docs/paper/browser-launch-results.json', 'utf-8'));
      const linkedInResult = results.targets.find(target => target.id === 'linkedin-launch-post');
      linkedInResult.notes = linkedInResult.notes.replace(
        'https://github.com/Evilander/Audrey',
        'https://example.com/repo-redacted',
      );
      writeFileSync(tempResults, `${JSON.stringify(results, null, 2)}\n`);

      const report = await verifyBrowserLaunchResults({ results: tempResults });

      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain(
        'linkedin-launch-post: submitted marketing result must include https://github.com/Evilander/Audrey',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not accept the GitHub repo URL when it is embedded inside another host URL', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'browser-results-'));
    const tempResults = join(tempDir, 'browser-launch-results.json');
    try {
      const results = JSON.parse(readFileSync('docs/paper/browser-launch-results.json', 'utf-8'));
      const linkedInResult = results.targets.find(target => target.id === 'linkedin-launch-post');
      linkedInResult.notes = linkedInResult.notes.replace(
        'https://github.com/Evilander/Audrey',
        'https://example.com/https://github.com/Evilander/Audrey',
      );
      writeFileSync(tempResults, `${JSON.stringify(results, null, 2)}\n`);

      const report = await verifyBrowserLaunchResults({ results: tempResults });

      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain(
        'linkedin-launch-post: submitted marketing result must include https://github.com/Evilander/Audrey',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('strict browser launch results fail until post-submit URLs are recorded', async () => {
    const report = await verifyBrowserLaunchResults({ strict: true });

    expect(report.ok).toBe(false);
    expect(report.ready).toBe(false);
    expect(report.failures.join('\n')).toContain('strict launch readiness requires submitted targets');
  });

  it('requires artifact URLs for submitted artifact-url launch targets', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'browser-results-'));
    const tempResults = join(tempDir, 'browser-launch-results.json');
    try {
      const results = JSON.parse(readFileSync('docs/paper/browser-launch-results.json', 'utf-8'));
      const plan = JSON.parse(readFileSync('docs/paper/browser-launch-plan.json', 'utf-8'));
      const xPlan = plan.targets.find(target => target.id === 'x-launch-thread');
      const xResult = results.targets.find(target => target.id === 'x-launch-thread');
      Object.assign(xResult, {
        status: 'submitted',
        publicUrl: 'https://x.com/Evilander/status/1',
        artifactUrl: null,
        submittedAt: '2026-05-13T00:00:00.000Z',
        operatorVerified: true,
        manualRuleCheckCompleted: false,
        postSubmitChecksCompleted: xPlan.postSubmitChecks,
        blocker: null,
      });
      writeFileSync(tempResults, `${JSON.stringify(results, null, 2)}\n`);

      const report = await verifyBrowserLaunchResults({ results: tempResults });

      expect(report.ok).toBe(false);
      expect(report.failures.join('\n')).toContain('x-launch-thread: submitted artifact-url target must record artifactUrl');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates and verifies the arXiv source package', () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'arxiv-source-'));
    try {
      const created = writeArxivSourcePackage({ outDir: tempDir });
      const verified = verifyArxivSourcePackage({ dir: tempDir });

      expect(created.files).toContain('main.tex');
      expect(created.files).toContain('references.bib');
      expect(verified.ok).toBe(true);
      expect(verified.files).toContain('main.tex');
      expect(verified.citationCount).toBeGreaterThan(0);
      expect(verified.bibEntries).toBe(21);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records missing arXiv compile tooling as a pending machine-readable report', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'arxiv-compile-'));
    const compileDir = join(tempDir, 'compile');
    const reportPath = join(tempDir, 'arxiv-compile-report.json');
    try {
      writeArxivSourcePackage({ outDir: tempDir });
      const report = await verifyArxivCompile({
        dir: tempDir,
        outDir: compileDir,
        report: reportPath,
        commandExists: () => false,
        now: '2026-05-13T00:00:00.000Z',
      });
      const verified = verifyArxivCompileReport({ report: reportPath, allowPending: true });
      const strict = verifyArxivCompileReport({ report: reportPath, allowPending: false });

      expect(report.status).toBe('toolchain-missing');
      expect(verified.ok).toBe(true);
      expect(verified.blockers.join('\n')).toContain('Install tectonic, latexmk, or pdflatex+bibtex');
      expect(strict.ok).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates and verifies the paper submission bundle', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'paper-bundle-'));
    const outDir = join(tempDir, 'submission-bundle');
    try {
      const created = await writePaperSubmissionBundle({ outDir });
      const verified = verifyPaperSubmissionBundle({ dir: outDir });

      expect(created.files).toContain('docs/paper/audrey-paper-v1.md');
      expect(created.files).toContain('docs/paper/publication-pack.json');
      expect(created.files).toContain('docs/paper/browser-launch-results.json');
      expect(created.files).not.toContain('paper-submission-manifest.json');
      expect(verified.ok).toBe(true);
      expect(verified.files).toContain('docs/paper/publication-pack.json');
      expect(verified.files).toContain('docs/paper/browser-launch-results.json');
      expect(verified.files).toContain('benchmarks/output/external/guardbench-external-evidence.json');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects paper submission bundles when a listed file is modified after bundling', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'paper-bundle-tamper-'));
    const outDir = join(tempDir, 'submission-bundle');
    try {
      await writePaperSubmissionBundle({ outDir });
      const packPath = join(outDir, 'docs/paper/publication-pack.json');
      const pack = JSON.parse(readFileSync(packPath, 'utf-8'));
      pack.entries[0].title = 'Tampered after bundle creation';
      writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf-8');

      const verified = verifyPaperSubmissionBundle({ dir: outDir });

      expect(verified.ok).toBe(false);
      expect(verified.failures.join('\n')).toContain('docs/paper/publication-pack.json: sha256 mismatch');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports 1.0 release readiness without hiding publish blockers', async () => {
    const report = await verifyReleaseReadiness({ targetVersion: '1.0.0', allowPending: true });

    expect(report.ok).toBe(true);
    expect(report.ready).toBe(false);
    expect(report.checks.find(check => check.id === 'paper-artifacts').status).toBe('passed');
    expect(report.checks.find(check => check.id === 'target-version').status).toBe('passed');
    expect(report.checks.find(check => check.id === 'changelog-target').status).toBe('passed');
    expect(report.checks.find(check => check.id === 'source-control').status).toBe('pending');
    expect(report.checks.find(check => check.id === 'external-evidence').status).toBe('pending');
    expect(report.checks.find(check => check.id === 'browser-publication').status).toBe('pending');
    expect(['pending', 'passed']).toContain(report.checks.find(check => check.id === 'npm-package-target').status);
    expect(report.checks.find(check => check.id === 'pypi-package-target').status).toBe('pending');
    expect(report.blockers.join('\n')).toContain('working-tree');
    expect(report.blockers.join('\n')).toContain('PyPI publish credentials');
  });

  it('keeps the 1.0 release cut idempotent after it is applied', () => {
    const report = prepareReleaseCut({ targetVersion: '1.0.0', date: '2026-05-13' });

    expect(report.ok).toBe(true);
    expect(report.apply).toBe(false);
    expect(report.currentVersions.packageJson).toBe('1.0.0');
    expect(report.files.filter(file => file.changed).map(file => file.path)).toEqual([]);
    expect(report.nextCommands).toContain('npm run release:gate:paper');
  });

  it('inserts release notes after the changelog heading without leaking replacement markers', () => {
    const changelog = `# Changelog

## 0.23.1 - 2026-05-08

- Existing release notes.
`;
    const updated = insertChangelogSection(changelog, '1.0.0', '2026-05-13');

    expect(updated).toMatch(/^# Changelog\r?\n\r?\n## 1\.0\.0 - 2026-05-13/m);
    expect(updated).not.toContain('$1');
    expect(targetChangelogStatus(updated, '1.0.0')).toEqual({ found: true, placeholderMarkers: [] });
  });

  it('keeps npm publish readiness pending when the target version is unpublished and npm auth is absent', () => {
    const report = npmPackageTargetStatus({ name: 'audrey', version: '1.0.0' }, '1.0.0', args => {
      if (args[0] === 'view') return { status: 1, stderr: 'npm error code E404\nnpm error 404 No match found for version 1.0.0' };
      if (args[0] === 'whoami') return { status: 1, stderr: 'npm error code E401\nnpm error 401 Unauthorized' };
      throw new Error(`unexpected npm args: ${args.join(' ')}`);
    });

    expect(report.status).toBe('pending');
    expect(report.evidence).toContain('registry=audrey@1.0.0:unpublished');
    expect(report.blockers.join('\n')).toContain('Authenticate npm CLI');
  });

  it('accepts npm publish readiness when the target version is already on the registry', () => {
    const report = npmPackageTargetStatus({ name: 'audrey', version: '1.0.0' }, '1.0.0', args => {
      if (args[0] === 'view') return { status: 0, stdout: '1.0.0\n', stderr: '' };
      throw new Error(`unexpected npm args: ${args.join(' ')}`);
    });

    expect(report.status).toBe('passed');
    expect(report.evidence).toContain('registry=audrey@1.0.0');
  });

  it('keeps source-control readiness pending when live remote state cannot be verified', () => {
    const report = remoteBranchFreshnessStatus({ branch: 'master', upstream: 'origin/master', upstreamSha: 'abc1234' }, () => ({
      status: 1,
      stderr: 'fatal: unable to access remote',
    }));

    expect(report.evidence).toContain('remoteHead=unverified');
    expect(report.blockers.join('\n')).toContain('Verify live remote origin/master');
  });

  it('detects stale local upstream tracking refs before final release', () => {
    const report = remoteBranchFreshnessStatus({ branch: 'master', upstream: 'origin/master', upstreamSha: 'abc123456789' }, () => ({
      status: 0,
      stdout: 'def987654321\trefs/heads/master\n',
      stderr: '',
    }));

    expect(report.evidence).toContain('remoteHead=origin/master:def9876');
    expect(report.blockers.join('\n')).toContain('local origin/master is abc1234 but live remote is def9876');
  });

  it('retries live remote verification with OpenSSL when Schannel is broken', () => {
    const calls = [];
    const report = remoteBranchFreshnessStatus(
      { branch: 'master', upstream: 'origin/master', upstreamSha: 'abc123456789' },
      args => {
        calls.push(args);
        if (args[0] === 'ls-remote') {
          return {
            status: 1,
            stderr: 'schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS',
          };
        }
        if (args[0] === '-c' && args[1] === 'http.sslBackend=openssl') {
          return {
            status: 0,
            stdout: 'def987654321\trefs/heads/master\n',
            stderr: '',
          };
        }
        throw new Error(`unexpected git args: ${args.join(' ')}`);
      },
    );

    expect(calls).toHaveLength(2);
    expect(report.evidence).toContain('remoteHeadTlsFallback=openssl');
    expect(report.evidence).toContain('remoteHead=origin/master:def9876');
    expect(report.blockers.join('\n')).toContain('local origin/master is abc1234 but live remote is def9876');
  });

  it('generates final 1.0 release notes without placeholder markers', () => {
    const section = releaseChangelogSection('1.0.0', '2026-05-13');

    expect(section).toContain('## 1.0.0 - 2026-05-13');
    expect(section).toContain('### Audrey Guard');
    expect(section).toContain('### GuardBench And Paper Artifacts');
    expect(section).not.toMatch(/\bTODO\b/i);
    expect(section).not.toContain('Release Cut Checklist');
    expect(targetChangelogStatus(`# Changelog\n\n${section}`, '1.0.0').placeholderMarkers).toEqual([]);
  });

  it('rejects placeholder release-cut changelog sections as final readiness evidence', () => {
    const status = targetChangelogStatus(`# Changelog

## 1.0.0 - 2026-05-13

### Release Cut Checklist

- TODO: Replace this scaffold with the final release notes before strict readiness passes.

## 0.23.1 - 2026-05-13

- Existing release notes.
`, '1.0.0');

    expect(status.found).toBe(true);
    expect(status.placeholderMarkers).toEqual(['TODO marker', 'release-cut checklist scaffold']);
  });

  it('rejects malformed adapter registries', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'registry-bad-'));
    const registryPath = join(tempDir, 'registry.json');
    try {
      writeFileSync(registryPath, `${JSON.stringify({
        schemaVersion: '1.0.0',
        suite: 'GuardBench adapter registry',
        adapters: [
          {
            id: 'missing-adapter',
            name: 'Missing Adapter',
            path: 'benchmarks/adapters/missing-adapter.mjs',
            status: 'reference',
            credentialMode: 'none',
            requiredEnv: [],
            description: 'Broken registry fixture.',
            commands: {
              moduleValidate: 'npm run bench:guard:adapter-module:validate',
              selfTest: 'npm run bench:guard:adapter-self-test',
              selfTestValidate: 'npm run bench:guard:adapter-self-test:validate',
              externalRun: 'npm run bench:guard:external',
            },
          },
        ],
      }, null, 2)}\n`, 'utf-8');

      const validation = await validateAdapterRegistry({ registry: registryPath });

      expect(validation.ok).toBe(false);
      expect(validation.failures.join('\n')).toContain('Adapter missing-adapter path does not exist');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects adapter registries with inconsistent metadata', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'registry-metadata-bad-'));
    const registryPath = join(tempDir, 'registry.json');
    try {
      writeFileSync(registryPath, `${JSON.stringify({
        schemaVersion: '1.0.0',
        suite: 'GuardBench adapter registry',
        adapters: [
          {
            id: 'example-allow',
            name: 'Wrong Name',
            path: 'benchmarks/adapters/example-allow.mjs',
            status: 'reference',
            credentialMode: 'none',
            requiredEnv: ['SHOULD_NOT_BE_HERE'],
            description: 'Broken registry fixture.',
            commands: {
              moduleValidate: 'npm run bench:guard:adapter-module:validate',
              selfTest: 'npm run bench:guard:adapter-self-test -- --adapter benchmarks/adapters/example-allow.mjs',
              selfTestValidate: 'npm run bench:guard:adapter-self-test:validate',
              externalRun: 'npm run bench:guard:external',
            },
          },
        ],
      }, null, 2)}\n`, 'utf-8');

      const validation = await validateAdapterRegistry({ registry: registryPath });

      expect(validation.ok).toBe(false);
      expect(validation.failures.join('\n')).toContain('credentialMode=none but declares requiredEnv');
      expect(validation.failures.join('\n')).toContain('command moduleValidate does not reference benchmarks/adapters/example-allow.mjs');
      expect(validation.failures.join('\n')).toContain('registry name Wrong Name does not match module name Example Allow Adapter');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('self-tests a conforming adapter separately from its low benchmark score', async () => {
    const result = await runGuardBenchAdapterSelfTest({
      adapter: 'benchmarks/adapters/example-allow.mjs',
      write: false,
    });

    expect(result.ok).toBe(true);
    expect(result.adapter.name).toBe('Example Allow Adapter');
    expect(result.conformance.scenarios).toBe(10);
    expect(result.contract.expectedAnswersWithheld).toBe(true);
    expect(result.contract.lowScoreAllowed).toBe(true);
    expect(result.score.fullContractPassRate).toBe(0);
    expect(result.score.decisionAccuracy).toBe(0.1);
    expect(result.score.redactionLeaks).toBe(0);
    expect(validateAdapterSelfTestReport(result)).toEqual([]);
  }, 20_000);

  it('schema-validates adapter self-test reports', async () => {
    const result = await runGuardBenchAdapterSelfTest({
      adapter: 'benchmarks/adapters/example-allow.mjs',
      write: false,
    });
    const malformed = structuredClone(result);
    malformed.contract.lowScoreAllowed = false;

    expect(validateAdapterSelfTestReport(result)).toEqual([]);
    expect(validateAdapterSelfTestReport(malformed).join('\n')).toContain('guardbench-adapter-self-test.contract.lowScoreAllowed: expected constant true');
  }, 20_000);

  it('validates saved adapter self-test reports as standalone reviewer artifacts', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'self-test-report-'));
    const reportPath = join(tempDir, 'guardbench-adapter-self-test.json');
    try {
      await runGuardBenchAdapterSelfTest({
        adapter: 'benchmarks/adapters/example-allow.mjs',
        out: reportPath,
      });
      const validation = validateAdapterSelfTestFile({ report: reportPath });

      expect(validation.ok).toBe(true);
      expect(validation.adapter).toBe('Example Allow Adapter');
      expect(validation.scenarios).toBe(10);
      expect(validation.lowScoreAllowed).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects malformed saved adapter self-test reports', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'self-test-report-bad-'));
    const reportPath = join(tempDir, 'guardbench-adapter-self-test.json');
    try {
      const result = await runGuardBenchAdapterSelfTest({
        adapter: 'benchmarks/adapters/example-allow.mjs',
        write: false,
      });
      result.contract.lowScoreAllowed = false;
      writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');

      const validation = validateAdapterSelfTestFile({ report: reportPath });

      expect(validation.ok).toBe(false);
      expect(validation.failures.join('\n')).toContain('guardbench-adapter-self-test.contract.lowScoreAllowed: expected constant true');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects malformed adapters through the self-test path', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'self-test-'));
    const adapterPath = join(tempDir, 'bad-adapter.mjs');
    try {
      writeFileSync(adapterPath, `export default {
  name: 'Bad Self-Test Adapter',
  description: 'Invalid adapter used by GuardBench tests.',
  async decide() {
    return {
      decision: 'maybe',
      riskScore: 2,
      evidenceIds: [],
      recommendedActions: [],
      summary: 'Invalid decision shape.'
    };
  }
};
`, 'utf-8');

      await expect(runGuardBenchAdapterSelfTest({
        adapter: adapterPath,
        write: false,
      })).rejects.toThrow(/Bad Self-Test Adapter returned invalid result for GB-01/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('drives the Mem0 Platform REST flow with runtime credentials only', async () => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({
        url,
        method: options.method ?? 'GET',
        authorization: options.headers?.Authorization,
        body: options.body ? JSON.parse(options.body) : null,
      });

      if (url.endsWith('/v3/memories/add/')) {
        return Response.json({ event_id: 'evt-test', status: 'PENDING' });
      }
      if (url.endsWith('/v1/event/evt-test/')) {
        return Response.json({ id: 'evt-test', status: 'SUCCEEDED' });
      }
      if (url.endsWith('/v2/memories/search')) {
        return Response.json([
          {
            id: 'mem-test',
            memory: 'Must-follow release rule: before npm run deploy, run npm pack --dry-run.',
          },
        ]);
      }
      if (url.includes('/v2/entities/user/')) {
        return new Response(null, { status: 204 });
      }
      return new Response('unexpected', { status: 500 });
    };

    const adapter = createMem0GuardBenchAdapter({
      apiKey: 'runtime-key',
      baseUrl: 'https://api.mem0.ai',
      pollIntervalMs: 0,
      fetchImpl,
    });
    const scenario = guardBenchManifest().scenarios.find(entry => entry.id === 'GB-02');
    const state = await adapter.setup({ scenario });
    const result = await adapter.decide({ scenario, action: scenario.action, state });
    await adapter.cleanup({ state });

    expect(result.decision).toBe('block');
    expect(calls.every(call => call.authorization === 'Token runtime-key')).toBe(true);
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /v3/memories/add/',
      'GET /v1/event/evt-test/',
      'POST /v2/memories/search',
      `DELETE /v2/entities/user/${state.userId}/`,
    ]);
    expect(calls[0].body.infer).toBe(false);
    expect(calls[0].body.user_id).toBe(state.userId);
    expect(calls[2].body.filters).toEqual({ user_id: state.userId });
  });

  it('drives the Zep Cloud REST flow with runtime credentials only', async () => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({
        url,
        method: options.method ?? 'GET',
        authorization: options.headers?.Authorization,
        body: options.body ? JSON.parse(options.body) : null,
      });

      if (url.endsWith('/api/v2/users') && options.method === 'POST') {
        return Response.json({ user_id: 'zep-user-test' }, { status: 201 });
      }
      if (url.endsWith('/api/v2/sessions') && options.method === 'POST') {
        return Response.json({ session_id: 'zep-session-test' }, { status: 201 });
      }
      if (url.includes('/api/v2/sessions/') && url.endsWith('/memory')) {
        return Response.json({ context: '' });
      }
      if (url.endsWith('/api/v2/graph/search')) {
        return Response.json({
          edges: [
            {
              uuid: 'zep-edge-test',
              fact: 'Must-follow release rule: before npm run deploy, run npm pack --dry-run.',
            },
          ],
        });
      }
      if (url.includes('/api/v2/users/') && options.method === 'DELETE') {
        return Response.json({ message: 'deleted' });
      }
      return new Response('unexpected', { status: 500 });
    };

    const adapter = createZepGuardBenchAdapter({
      apiKey: 'runtime-key',
      baseUrl: 'https://api.getzep.com',
      ingestDelayMs: 0,
      fetchImpl,
    });
    const scenario = guardBenchManifest().scenarios.find(entry => entry.id === 'GB-02');
    const state = await adapter.setup({ scenario });
    const result = await adapter.decide({ scenario, action: scenario.action, state });
    await adapter.cleanup({ state });

    expect(result.decision).toBe('block');
    expect(calls.every(call => call.authorization === 'Api-Key runtime-key')).toBe(true);
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /api/v2/users',
      'POST /api/v2/sessions',
      `POST /api/v2/sessions/${state.sessionId}/memory`,
      'POST /api/v2/graph/search',
      `DELETE /api/v2/users/${state.userId}`,
    ]);
    expect(calls[0].body.user_id).toBe(state.userId);
    expect(calls[1].body.session_id).toBe(state.sessionId);
    expect(calls[1].body.user_id).toBe(state.userId);
    expect(calls[2].body.messages[0].role_type).toBe('norole');
    expect(calls[3].body.user_id).toBe(state.userId);
    expect(calls[3].body.scope).toBe('edges');
  });

  it('builds reproducible external GuardBench runs without embedding credentials', () => {
    const args = parseExternalArgs(['--adapter', 'mem0-platform', '--check', '--out-dir', 'benchmarks/output/external/mem0-test']);
    const run = buildExternalGuardBenchRun(args, {});

    expect(run.adapter).toBe('mem0-platform');
    expect(run.missingEnv).toEqual(['MEM0_API_KEY']);
    expect(run.command).toContain('--adapter');
    expect(run.command).toContain('--check');
    expect(run.command).toContain('--out-dir');
    expect(run.validationCommand).toContain('--dir');
    expect(run.validationCommand).toContain(run.outDir);
    expect(basename(run.adapterPath)).toBe('mem0-platform.mjs');
    expect(run.command.join(' ')).not.toContain('runtime-key');
    expect(run.validationCommand.join(' ')).not.toContain('runtime-key');
  });

  it('builds Zep external GuardBench runs without embedding credentials', () => {
    const args = parseExternalArgs(['--adapter', 'zep-cloud', '--check', '--out-dir', 'benchmarks/output/external/zep-test']);
    const run = buildExternalGuardBenchRun(args, {});

    expect(run.adapter).toBe('zep-cloud');
    expect(run.missingEnv).toEqual(['ZEP_API_KEY']);
    expect(basename(run.adapterPath)).toBe('zep-cloud.mjs');
    expect(run.command.join(' ')).not.toContain('runtime-key');
    expect(run.validationCommand.join(' ')).not.toContain('runtime-key');
  });

  it('builds a non-secret dry-run matrix for runtime external adapters', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'external-dry-run-'));
    try {
      const matrix = await buildExternalAdapterDryRunMatrix({
        outRoot: tempDir,
        env: {},
      });

      expect(matrix.ok).toBe(true);
      expect(matrix.adapters.map(row => row.id)).toEqual(['mem0-platform', 'zep-cloud']);
      expect(matrix.adapters.find(row => row.id === 'mem0-platform').missingEnv).toEqual(['MEM0_API_KEY']);
      expect(matrix.adapters.find(row => row.id === 'zep-cloud').missingEnv).toEqual(['ZEP_API_KEY']);
      expect(matrix.adapters.every(row => existsSync(row.metadataPath))).toBe(true);
      expect(JSON.stringify(matrix)).not.toContain('runtime-key');
      expect(validateExternalAdapterDryRunMatrix(matrix)).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('schema-validates external adapter dry-run matrices', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'external-dry-run-schema-'));
    try {
      const matrix = await buildExternalAdapterDryRunMatrix({
        outRoot: tempDir,
        env: {},
      });
      const malformed = structuredClone(matrix);
      malformed.adapters[0].status = 'ready-ish';

      expect(validateExternalAdapterDryRunMatrix(matrix)).toEqual([]);
      expect(validateExternalAdapterDryRunMatrix(malformed).join('\n')).toContain('guardbench-external-dry-run.adapters[0].status: expected one of dry-run-missing-env, dry-run-ready');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports pending external evidence separately from dry-run readiness', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'external-evidence-pending-'));
    try {
      await buildExternalAdapterDryRunMatrix({
        outRoot: tempDir,
        env: {},
      });

      const pending = await verifyExternalGuardBenchEvidence({
        outRoot: tempDir,
        allowPending: true,
        write: false,
      });
      const strict = await verifyExternalGuardBenchEvidence({
        outRoot: tempDir,
        allowPending: false,
        write: false,
      });

      expect(pending.ok).toBe(true);
      expect(pending.adapters.map(row => row.status)).toEqual(['pending', 'pending']);
      expect(pending.adapters.map(row => row.evidenceKind)).toEqual(['dry-run', 'dry-run']);
      expect(strict.ok).toBe(false);
      expect(strict.failures.join('\n')).toContain('External evidence is pending for mem0-platform');
      expect(validateExternalEvidenceReport(pending)).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('verifies live external evidence metadata without embedding runtime credentials', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'external-evidence-live-'));
    const target = {
      id: 'fixture-platform',
      name: 'Fixture Platform',
      path: 'benchmarks/adapters/example-allow.mjs',
      credentialMode: 'runtime-env',
      requiredEnv: ['FIXTURE_API_KEY'],
    };
    const outDir = join(tempDir, target.id);
    try {
      mkdirSync(outDir, { recursive: true });
      for (const file of ['guardbench-manifest.json', 'guardbench-summary.json', 'guardbench-raw.json']) {
        cpSync(join('benchmarks/output', file), join(outDir, file));
      }
      const artifactHashes = computeGuardBenchArtifactHashes(outDir);
      writeFileSync(join(outDir, 'external-run-metadata.json'), `${JSON.stringify({
        suite: 'GuardBench external adapter run',
        startedAt: '2026-05-13T00:00:00.000Z',
        completedAt: '2026-05-13T00:00:01.000Z',
        adapter: target.id,
        adapterPath: target.path,
        outDir,
        requiredEnv: target.requiredEnv,
        missingEnv: [],
        command: ['node', 'benchmarks/guardbench.js', '--adapter', target.path],
        validationCommand: ['node', 'benchmarks/validate-guardbench-artifacts.mjs', '--dir', outDir],
        dryRun: false,
        status: 'passed',
        exitCode: 0,
        signal: null,
        artifactHashes,
        artifactValidation: {
          ok: true,
          dir: outDir,
          schemasDir: 'benchmarks/schemas',
          files: ['guardbench-manifest.json', 'guardbench-summary.json', 'guardbench-raw.json'],
          failures: [],
        },
        adapterConformance: {
          ok: true,
          adapter: target.id,
          requestedAdapter: target.id,
          scenarios: 10,
          expectedScenarios: 10,
          fullContractPassRate: 0.4,
          decisionAccuracy: 0.7,
          redactionLeaks: 0,
          failures: [],
        },
      }, null, 2)}\n`, 'utf-8');

      const report = await verifyExternalGuardBenchEvidence({
        targets: [target],
        outRoot: tempDir,
        env: { FIXTURE_API_KEY: 'runtime-key' },
        write: false,
      });

      expect(report.ok).toBe(true);
      expect(report.adapters[0].status).toBe('verified');
      expect(report.adapters[0].secretLeakCount).toBe(0);
      expect(JSON.stringify(report)).not.toContain('runtime-key');
      expect(validateExternalEvidenceReport(report)).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects external evidence metadata that leaks runtime credential values', async () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'external-evidence-leak-'));
    const target = {
      id: 'fixture-platform',
      name: 'Fixture Platform',
      path: 'benchmarks/adapters/example-allow.mjs',
      credentialMode: 'runtime-env',
      requiredEnv: ['FIXTURE_API_KEY'],
    };
    const outDir = join(tempDir, target.id);
    try {
      mkdirSync(outDir, { recursive: true });
      for (const file of ['guardbench-manifest.json', 'guardbench-summary.json', 'guardbench-raw.json']) {
        cpSync(join('benchmarks/output', file), join(outDir, file));
      }
      const artifactHashes = computeGuardBenchArtifactHashes(outDir);
      writeFileSync(join(outDir, 'external-run-metadata.json'), `${JSON.stringify({
        suite: 'GuardBench external adapter run',
        startedAt: '2026-05-13T00:00:00.000Z',
        completedAt: '2026-05-13T00:00:01.000Z',
        adapter: target.id,
        adapterPath: target.path,
        outDir,
        requiredEnv: target.requiredEnv,
        missingEnv: [],
        command: ['node', 'benchmarks/guardbench.js', '--api-key', 'runtime-key'],
        validationCommand: ['node', 'benchmarks/validate-guardbench-artifacts.mjs', '--dir', outDir],
        dryRun: false,
        status: 'passed',
        exitCode: 0,
        signal: null,
        artifactHashes,
        artifactValidation: {
          ok: true,
          dir: outDir,
          schemasDir: 'benchmarks/schemas',
          files: ['guardbench-manifest.json', 'guardbench-summary.json', 'guardbench-raw.json'],
          failures: [],
        },
        adapterConformance: {
          ok: true,
          adapter: target.id,
          requestedAdapter: target.id,
          scenarios: 10,
          expectedScenarios: 10,
          fullContractPassRate: 0.4,
          decisionAccuracy: 0.7,
          redactionLeaks: 0,
          failures: [],
        },
      }, null, 2)}\n`, 'utf-8');

      const report = await verifyExternalGuardBenchEvidence({
        targets: [target],
        outRoot: tempDir,
        env: { FIXTURE_API_KEY: 'runtime-key' },
        write: false,
      });

      expect(report.ok).toBe(false);
      expect(report.adapters[0].status).toBe('failed');
      expect(report.adapters[0].secretLeakCount).toBe(1);
      expect(report.failures.join('\n')).toContain('metadata leaks runtime credential value for FIXTURE_API_KEY');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('separates external adapter conformance from benchmark score', async () => {
    const report = await runGuardBench({
      externalAdapters: [{
        name: 'Conforming Low Score Adapter',
        description: 'Conforms to the output contract but intentionally allows every action.',
        async decide() {
          return {
            decision: 'allow',
            riskScore: 0,
            evidenceIds: [],
            recommendedActions: [],
            summary: 'Conformance fixture returned a valid allow decision.',
          };
        },
      }],
    });

    const conformance = evaluateAdapterConformance(report, 'Conforming Low Score Adapter');

    expect(conformance.ok).toBe(true);
    expect(conformance.scenarios).toBe(10);
    expect(conformance.fullContractPassRate).toBeLessThan(1);
    expect(conformance.redactionLeaks).toBe(0);
  }, 20_000);

  it('resolves path-based adapter conformance through the emitted external subject name', async () => {
    const report = await runGuardBench({
      externalAdapters: [{
        name: 'Declared Adapter Name',
        description: 'Adapter loaded from a path can use a declared display name.',
        async decide() {
          return {
            decision: 'allow',
            riskScore: 0,
            evidenceIds: [],
            recommendedActions: [],
            summary: 'Conformance fixture returned a valid allow decision.',
          };
        },
      }],
    });

    const conformance = evaluateAdapterConformance(report, 'adapter-file-name');

    expect(conformance.ok).toBe(true);
    expect(conformance.adapter).toBe('Declared Adapter Name');
    expect(conformance.requestedAdapter).toBe('adapter-file-name');
  }, 20_000);

  it('rejects external adapter conformance when rows are missing', async () => {
    const report = await runGuardBench({
      externalAdapters: [{
        name: 'Incomplete Adapter',
        description: 'Produces valid rows before this test removes one.',
        async decide() {
          return {
            decision: 'allow',
            riskScore: 0,
            evidenceIds: [],
            recommendedActions: [],
            summary: 'Conformance fixture returned a valid allow decision.',
          };
        },
      }],
    });
    report.cases[0].results = report.cases[0].results.filter(row => row.system !== 'Incomplete Adapter');

    const conformance = evaluateAdapterConformance(report, 'Incomplete Adapter');

    expect(conformance.ok).toBe(false);
    expect(conformance.failures.join('\n')).toContain('Adapter Incomplete Adapter returned 9/10 scenario rows');
  }, 20_000);

  it('validates published GuardBench artifact bundles as a standalone benchmark contract', () => {
    const report = validateGuardBenchArtifacts({ dir: 'benchmarks/output' });

    expect(report.ok).toBe(true);
    expect(report.files).toEqual([
      'guardbench-manifest.json',
      'guardbench-summary.json',
      'guardbench-raw.json',
    ]);
    expect(report.failures).toEqual([]);
  });

  it('rejects malformed published GuardBench artifact bundles', () => {
    const report = withArtifactCopy(tempDir => {
      const summaryPath = join(tempDir, 'guardbench-summary.json');
      const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      summary.rows[0].decision = 'maybe';
      writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
    });

    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('guardbench-summary.rows[0].decision: expected one of allow, warn, block');
  });

  it('rejects seeded raw-secret leaks in published GuardBench artifact bundles', () => {
    const report = withArtifactCopy(tempDir => {
      const rawPath = join(tempDir, 'guardbench-raw.json');
      const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
      raw.cases[0].results[0].summary = 'Leaked sk-guardbench-secret-0000000000000000000000000000';
      writeFileSync(rawPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    });

    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('raw seeded secret leaked into GuardBench artifacts');
  });

  it('rejects cross-artifact mismatches between summary, manifest, and raw output', () => {
    const report = withArtifactCopy(tempDir => {
      const rawPath = join(tempDir, 'guardbench-raw.json');
      const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
      raw.cases[0].results[0].decision = 'allow';
      writeFileSync(rawPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    });

    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('summary.cases vs raw.cases: cross-artifact mismatch');
  });

  it('validates external-run metadata when a GuardBench output bundle includes it', () => {
    const report = withArtifactCopy(tempDir => {
      const artifactHashes = computeGuardBenchArtifactHashes(tempDir);
      writeFileSync(join(tempDir, 'external-run-metadata.json'), `${JSON.stringify({
        suite: 'GuardBench external adapter run',
        startedAt: '2026-05-13T00:00:00.000Z',
        completedAt: '2026-05-13T00:00:01.000Z',
        adapter: 'Example Allow Adapter',
        adapterPath: 'benchmarks/adapters/example-allow.mjs',
        outDir: tempDir,
        requiredEnv: [],
        missingEnv: [],
        command: ['node', 'benchmarks/guardbench.js'],
        validationCommand: ['node', 'benchmarks/validate-guardbench-artifacts.mjs', '--dir', tempDir],
        dryRun: false,
        status: 'passed',
        exitCode: 0,
        signal: null,
        artifactHashes,
        artifactValidation: {
          ok: true,
          dir: tempDir,
          schemasDir: 'benchmarks/schemas',
          files: ['guardbench-manifest.json', 'guardbench-summary.json', 'guardbench-raw.json'],
          failures: [],
        },
        adapterConformance: {
          ok: true,
          adapter: 'Example Allow Adapter',
          requestedAdapter: 'example-allow',
          scenarios: 10,
          expectedScenarios: 10,
          fullContractPassRate: 0,
          decisionAccuracy: 0.1,
          redactionLeaks: 0,
          failures: [],
        },
      }, null, 2)}\n`, 'utf-8');
    });

    expect(report.ok).toBe(true);
    expect(report.optionalFiles).toEqual(['external-run-metadata.json']);
  });

  it('writes a shareable GuardBench conformance card for a valid output bundle', () => {
    const report = withArtifactCopy(tempDir => {
      writeGuardBenchConformanceCard({ dir: tempDir });
    });

    expect(report.ok).toBe(true);
    expect(report.optionalFiles).toEqual(['guardbench-conformance-card.json']);
  });

  it('rejects conformance cards when their artifact hashes do not match the bundle', () => {
    const report = withArtifactCopy(tempDir => {
      const { path, card } = writeGuardBenchConformanceCard({ dir: tempDir });
      card.integrity.artifactHashes['guardbench-raw.json'] = '0'.repeat(64);
      writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`, 'utf-8');
    });

    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('guardbench-conformance-card.json: integrity.artifactHashes.guardbench-raw.json does not match current artifact');
  });

  it('creates a portable GuardBench submission bundle with schemas and validation evidence', () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'bundle-source-'));
    const outDir = join(tempDir, 'submission');
    try {
      for (const file of ['guardbench-manifest.json', 'guardbench-summary.json', 'guardbench-raw.json']) {
        cpSync(join('benchmarks/output', file), join(tempDir, file));
      }
      const result = writeGuardBenchSubmissionBundle({ dir: tempDir, outDir });
      const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));
      const verification = verifyGuardBenchSubmissionBundle({ dir: outDir });

      expect(result.validation.ok).toBe(true);
      expect(verification.ok).toBe(true);
      expect(result.files).not.toContain('submission-manifest.json');
      expect(result.files).toContain('validation-report.json');
      expect(result.files).toContain('guardbench-conformance-card.json');
      expect(result.files).toContain('schemas/guardbench-adapter-registry.schema.json');
      expect(result.files).toContain('schemas/guardbench-adapter-self-test.schema.json');
      expect(result.files).toContain('schemas/guardbench-conformance-card.schema.json');
      expect(result.files).toContain('schemas/guardbench-external-dry-run.schema.json');
      expect(result.files).toContain('schemas/guardbench-external-evidence.schema.json');
      expect(result.files).toContain('schemas/guardbench-leaderboard.schema.json');
      expect(result.files).toContain('schemas/guardbench-publication-verification.schema.json');
      expect(result.files).toContain('schemas/guardbench-submission-manifest.schema.json');
      expect(manifest.subject.name).toBe('Audrey Guard');
      expect(manifest.validation.ok).toBe(true);
      expect(existsSync(join(outDir, 'guardbench-raw.json'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records submission bundle files with portable relative paths on POSIX and Windows roots', () => {
    expect(bundleRelativeFilePath('/tmp/audrey-bundle/root/schemas/schema.json', '/tmp/audrey-bundle/root')).toBe('schemas/schema.json');
  });

  it('rejects submission bundles when a listed artifact is modified after bundling', () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'bundle-tamper-'));
    const outDir = join(tempDir, 'submission');
    try {
      for (const file of ['guardbench-manifest.json', 'guardbench-summary.json', 'guardbench-raw.json']) {
        cpSync(join('benchmarks/output', file), join(tempDir, file));
      }
      writeGuardBenchSubmissionBundle({ dir: tempDir, outDir });
      const rawPath = join(outDir, 'guardbench-raw.json');
      const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
      raw.cases[0].results[0].summary = 'Tampered after bundle creation';
      writeFileSync(rawPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');

      const verification = verifyGuardBenchSubmissionBundle({ dir: outDir });

      expect(verification.ok).toBe(false);
      expect(verification.failures.join('\n')).toContain('guardbench-raw.json: sha256 mismatch');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects submission bundles when the manifest violates the published schema', () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'bundle-schema-'));
    const outDir = join(tempDir, 'submission');
    try {
      for (const file of ['guardbench-manifest.json', 'guardbench-summary.json', 'guardbench-raw.json']) {
        cpSync(join('benchmarks/output', file), join(tempDir, file));
      }
      writeGuardBenchSubmissionBundle({ dir: tempDir, outDir });
      const manifestPath = join(outDir, 'submission-manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      delete manifest.schemaVersion;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

      const verification = verifyGuardBenchSubmissionBundle({ dir: outDir });

      expect(verification.ok).toBe(false);
      expect(verification.failures.join('\n')).toContain('submission-manifest.json: submission-manifest: missing required property schemaVersion');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('builds a ranked GuardBench leaderboard from verified submission bundles', () => {
    const root = 'benchmarks/.tmp-guardbench';
    mkdirSync(root, { recursive: true });
    const tempDir = mkdtempSync(join(root, 'leaderboard-'));
    const sourceDir = join(tempDir, 'source');
    const bundleDir = join(tempDir, 'submission');
    const outJson = join(tempDir, 'leaderboard.json');
    const outMd = join(tempDir, 'leaderboard.md');
    try {
      mkdirSync(sourceDir);
      for (const file of ['guardbench-manifest.json', 'guardbench-summary.json', 'guardbench-raw.json']) {
        cpSync(join('benchmarks/output', file), join(sourceDir, file));
      }
      writeGuardBenchSubmissionBundle({ dir: sourceDir, outDir: bundleDir });
      const result = writeGuardBenchLeaderboard({
        bundleDirs: [bundleDir],
        outJson,
        outMd,
      });

      expect(result.leaderboard.failures).toEqual([]);
      expect(result.leaderboard.rows).toHaveLength(1);
      expect(result.leaderboard.rows[0].rank).toBe(1);
      expect(result.leaderboard.rows[0].subject.name).toBe('Audrey Guard');
      expect(result.leaderboard.rows[0].verification.ok).toBe(true);
      expect(readFileSync(outMd, 'utf-8')).toContain('| 1 | Audrey Guard | yes | yes | 100.0% |');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects external-run metadata when artifact hashes do not match the bundle', () => {
    const report = withArtifactCopy(tempDir => {
      const artifactHashes = computeGuardBenchArtifactHashes(tempDir);
      artifactHashes['guardbench-summary.json'] = '0'.repeat(64);
      writeFileSync(join(tempDir, 'external-run-metadata.json'), `${JSON.stringify({
        suite: 'GuardBench external adapter run',
        startedAt: '2026-05-13T00:00:00.000Z',
        adapter: 'Example Allow Adapter',
        adapterPath: 'benchmarks/adapters/example-allow.mjs',
        outDir: tempDir,
        requiredEnv: [],
        missingEnv: [],
        command: ['node', 'benchmarks/guardbench.js'],
        validationCommand: ['node', 'benchmarks/validate-guardbench-artifacts.mjs', '--dir', tempDir],
        dryRun: false,
        status: 'passed',
        artifactHashes,
      }, null, 2)}\n`, 'utf-8');
    });

    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('external-run-metadata.json: artifactHashes.guardbench-summary.json does not match current artifact');
  });

  it('rejects malformed external-run metadata in a GuardBench output bundle', () => {
    const report = withArtifactCopy(tempDir => {
      writeFileSync(join(tempDir, 'external-run-metadata.json'), `${JSON.stringify({
        suite: 'GuardBench external adapter run',
        startedAt: '2026-05-13T00:00:00.000Z',
        adapter: 'Example Allow Adapter',
        adapterPath: 'benchmarks/adapters/example-allow.mjs',
        outDir: tempDir,
        requiredEnv: [],
        missingEnv: [],
        command: ['node', 'benchmarks/guardbench.js'],
        dryRun: false,
        status: 'passed',
      }, null, 2)}\n`, 'utf-8');
    });

    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('guardbench-externalRun: missing required property validationCommand');
  });
});
