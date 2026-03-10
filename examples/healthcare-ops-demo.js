import { Audrey } from '../src/index.js';

async function demo() {
  console.log('=== Audrey Demo: Healthcare Operations ===\n');

  const brain = new Audrey({
    dataDir: './healthcare-demo-data',
    agent: 'care-ops-agent',
    embedding: { provider: 'mock', dimensions: 64 },
  });

  console.log('--- Encoding care-coordination observations ---');
  await brain.encode({
    content: 'Referral queue delays drop when missing imaging notes are requested before prior-authorization submission.',
    source: 'direct-observation',
    salience: 0.9,
    tags: ['healthcare-ops', 'prior-auth', 'referrals'],
    context: { domain: 'healthcare', workflow: 'prior-auth' },
  });

  await brain.encode({
    content: 'Scheduling team reports the highest callback completion rate between 4pm and 6pm for discharge follow-up.',
    source: 'tool-result',
    salience: 0.8,
    tags: ['healthcare-ops', 'follow-up', 'scheduling'],
    context: { domain: 'healthcare', workflow: 'discharge-followup' },
  });

  await brain.encode({
    content: 'Care coordinators want interpreter requirements captured in every handoff note before outreach starts.',
    source: 'told-by-user',
    salience: 0.7,
    tags: ['healthcare-ops', 'handoff', 'interpreter'],
    context: { domain: 'healthcare', workflow: 'care-coordination' },
  });

  console.log('\n--- Consolidating into a reusable workflow ---');
  await brain.consolidate({
    minClusterSize: 3,
    similarityThreshold: -0.3,
    extractPrinciple: () => ({
      content: 'For care-coordination workflows, collect missing documentation and communication preferences before outreach or prior-auth submission.',
      type: 'procedural',
      conditions: ['prior-auth missing documentation', 'handoff note lacks outreach constraints'],
    }),
  });

  console.log('\n--- Recalling during a care-coordination handoff ---');
  const recalled = await brain.recall('care coordination handoff missing documentation', {
    limit: 5,
    context: { domain: 'healthcare', workflow: 'care-coordination' },
  });

  for (const memory of recalled) {
    console.log(`[${memory.type}] ${memory.content}`);
  }

  brain.close();

  const { rmSync } = await import('node:fs');
  rmSync('./healthcare-demo-data', { recursive: true, force: true });
}

demo().catch(err => {
  console.error(err);
  process.exit(1);
});
