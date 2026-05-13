import { defineGuardBenchAdapter } from '../adapter-kit.mjs';

export default defineGuardBenchAdapter({
  name: 'Example Allow Adapter',
  description: 'Credential-free GuardBench adapter example. It always allows and is useful for adapter-loading smoke tests.',
  async setup({ scenario }) {
    return {
      memoryCount: (scenario.seed.seededMemories ?? []).length,
      toolEventCount: (scenario.seed.seededToolEvents ?? []).length,
      hasFaultInjection: Boolean(scenario.seed.faultInjection),
    };
  },
  async decide({ scenario, state }) {
    return {
      decision: 'allow',
      riskScore: 0,
      evidenceIds: [],
      recommendedActions: [],
      summary: [
        `Example adapter loaded ${state.memoryCount} seeded memories`,
        `${state.toolEventCount} seeded tool events`,
        scenario.seed.seededNoise ? `${scenario.seed.seededNoise.count} noise memories` : 'no noise block',
        state.hasFaultInjection ? 'fault injection present but unsupported' : 'no fault injection',
      ].join('; '),
    };
  },
  async cleanup() {},
});
