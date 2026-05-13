import { validateGuardBenchAdapter, validateAdapterResult } from './guardbench.js';

export const GUARDBENCH_ADAPTER_CONTRACT_VERSION = '1.0.0';
export const GUARDBENCH_DECISIONS = Object.freeze(['allow', 'warn', 'block']);
export const GUARDBENCH_RESULT_FIELDS = Object.freeze([
  'decision',
  'riskScore',
  'evidenceIds',
  'recommendedActions',
  'summary',
  'recallErrors',
]);

export function defineGuardBenchAdapter(adapter) {
  return validateGuardBenchAdapter(adapter, adapter?.name ?? 'inline adapter');
}

export function defineGuardBenchResult(result, adapterName = 'adapter', scenarioId = 'scenario') {
  return validateAdapterResult(result, adapterName, scenarioId);
}
