import { describe, expect, it } from 'vitest';
import { pypiPackageTargetStatus } from '../scripts/verify-release-readiness.mjs';

describe('PyPI release readiness', () => {
  it('keeps publish readiness pending when registry checks are disabled and credentials are absent', async () => {
    const report = await pypiPackageTargetStatus(
      { packageName: 'audrey-memory', version: '1.0.0' },
      '1.0.0',
      { env: {} },
    );

    expect(report.status).toBe('pending');
    expect(report.blockers.join('\n')).toContain('Provide runtime PyPI publish credentials');
  });

  it('keeps publish readiness pending when the target version is unpublished and credentials are absent', async () => {
    const report = await pypiPackageTargetStatus(
      { packageName: 'audrey-memory', version: '1.0.0' },
      '1.0.0',
      { checkRegistry: true, env: {}, fetchImpl: async () => ({ ok: false, status: 404 }) },
    );

    expect(report.status).toBe('pending');
    expect(report.evidence).toContain('registry=audrey-memory==1.0.0:unpublished');
    expect(report.blockers.join('\n')).toContain('Provide runtime PyPI publish credentials');
  });

  it('passes publish readiness when the target version is already on PyPI', async () => {
    const report = await pypiPackageTargetStatus(
      { packageName: 'audrey-memory', version: '1.0.0' },
      '1.0.0',
      { checkRegistry: true, env: {}, fetchImpl: async () => ({ ok: true, status: 200 }) },
    );

    expect(report.status).toBe('passed');
    expect(report.evidence).toContain('registry=audrey-memory==1.0.0');
  });
});
