import { Audrey } from '../src/index.js';

async function demo() {
  console.log('=== Audrey Demo: Financial Services Operations ===\n');

  const brain = new Audrey({
    dataDir: './fintech-demo-data',
    agent: 'payments-ops-agent',
    embedding: { provider: 'mock', dimensions: 64 },
  });

  console.log('--- Encoding payment-operations incidents ---');
  await brain.encode({
    content: 'Processor X returned HTTP 429 when payout retries exceeded 120 requests per minute for marketplace merchants.',
    source: 'direct-observation',
    salience: 0.9,
    tags: ['payments', 'payouts', 'rate-limit'],
    context: { domain: 'finserv', workflow: 'payout-incident' },
  });

  await brain.encode({
    content: 'On-call notes show payout incident volume drops after retry batches are capped at 50 merchants per worker.',
    source: 'tool-result',
    salience: 0.8,
    tags: ['payments', 'payouts', 'ops'],
    context: { domain: 'finserv', workflow: 'payout-incident' },
  });

  await brain.encode({
    content: 'Risk operations requested automatic escalation when payout failures affect more than three merchants in the same hour.',
    source: 'told-by-user',
    salience: 0.7,
    tags: ['payments', 'escalation', 'risk'],
    context: { domain: 'finserv', workflow: 'payout-incident' },
  });

  console.log('\n--- Consolidating incidents into an ops principle ---');
  await brain.consolidate({
    minClusterSize: 3,
    similarityThreshold: -0.3,
    extractPrinciple: () => ({
      content: 'When payout retries spike, cap retry batches and escalate once multiple merchants are affected in the same hour.',
      type: 'procedural',
      conditions: ['payout failures > 3 merchants per hour', 'processor returns 429 or throttling errors'],
    }),
  });

  console.log('\n--- Recalling during a live payout incident ---');
  const recalled = await brain.recall('payout retries throttled by processor', {
    limit: 5,
    context: { domain: 'finserv', workflow: 'payout-incident' },
  });

  for (const memory of recalled) {
    console.log(`[${memory.type}] ${memory.content}`);
  }

  brain.close();

  const { rmSync } = await import('node:fs');
  rmSync('./fintech-demo-data', { recursive: true, force: true });
}

demo().catch(err => {
  console.error(err);
  process.exit(1);
});
