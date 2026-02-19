// examples/stripe-demo.js
// Proof-of-concept demo showing the full Audrey pipeline:
//   encode episodic memories → consolidate into principles → recall proactively
//
// Run: node examples/stripe-demo.js
// No external dependencies required (uses mock embeddings).

import { Audrey } from '../src/index.js';

async function demo() {
  console.log('=== Audrey Demo: Stripe Rate Limit Learning ===\n');

  const brain = new Audrey({
    dataDir: './demo-data',
    agent: 'stripe-agent',
    embedding: { provider: 'mock', dimensions: 64 },
  });

  brain.on('encode', ({ id, content }) => {
    console.log(`  [ENCODE] ${id.slice(0, 8)}... "${content.slice(0, 60)}"`);
  });

  brain.on('consolidation', ({ principlesExtracted, clustersFound }) => {
    console.log(`  [CONSOLIDATE] Found ${clustersFound} clusters, extracted ${principlesExtracted} principles`);
  });

  brain.on('reinforcement', ({ episodeId, similarity }) => {
    console.log(`  [REINFORCE] Episode ${episodeId.slice(0, 8)}... reinforced existing knowledge (sim: ${similarity?.toFixed(2) || 'N/A'})`);
  });

  // --- Scenario: Agent encounters Stripe rate limits ---

  console.log('--- Episode 1: First rate limit hit ---');
  await brain.encode({
    content: 'Stripe API returned HTTP 429 when batch-processing 150 payments per second',
    source: 'direct-observation',
    salience: 0.9,
    causal: { trigger: 'batch-payment-job', consequence: 'payment-queue-stalled' },
    tags: ['stripe', 'rate-limit', 'production'],
  });

  console.log('\n--- Episode 2: Second hit from different code path ---');
  await brain.encode({
    content: 'Stripe webhook verification endpoint returned 429 Too Many Requests during high traffic',
    source: 'tool-result',
    salience: 0.7,
    causal: { trigger: 'webhook-flood', consequence: 'missed-webhook-events' },
    tags: ['stripe', 'rate-limit', 'webhooks'],
  });

  console.log('\n--- Episode 3: Third observation from monitoring ---');
  await brain.encode({
    content: 'Stripe API rate limit triggered at approximately 100 requests per second threshold',
    source: 'direct-observation',
    salience: 0.8,
    tags: ['stripe', 'rate-limit', 'monitoring'],
  });

  // --- Consolidation ---
  console.log('\n--- Running consolidation ("sleep" cycle) ---');
  await brain.consolidate({
    minClusterSize: 3,
    // Mock embeddings are hash-based (not semantic), so cosine similarity
    // between related texts is near-random. In production with real embeddings
    // (e.g. OpenAI text-embedding-3-small), a threshold of 0.80+ works well.
    // We drop it here so the demo pipeline runs end-to-end.
    similarityThreshold: -0.3,
    extractPrinciple: (episodes) => ({
      content: `Stripe enforces ~100 req/s rate limit across all endpoints. Exceeding this causes 429 errors that can stall payment queues and cause missed webhooks. Implement request throttling.`,
      type: 'semantic',
    }),
  });

  // --- Proactive recall ---
  console.log('\n--- Agent encounters Stripe again, recalls proactively ---');
  const memories = await brain.recall('stripe api request rate', {
    minConfidence: 0.3,
    limit: 5,
  });

  console.log(`\nRecalled ${memories.length} memories:`);
  for (const mem of memories) {
    console.log(`  [${mem.type.toUpperCase()}] (conf: ${mem.confidence.toFixed(2)}, score: ${mem.score.toFixed(3)}) ${mem.content.slice(0, 80)}${mem.content.length > 80 ? '...' : ''}`);
  }

  // --- Introspection ---
  console.log('\n--- Brain stats ---');
  const stats = brain.introspect();
  console.log(`  Episodic memories:     ${stats.episodic}`);
  console.log(`  Semantic principles:   ${stats.semantic}`);
  console.log(`  Procedural workflows:  ${stats.procedural}`);
  console.log(`  Causal links:          ${stats.causalLinks}`);
  console.log(`  Consolidation runs:    ${stats.totalConsolidationRuns}`);
  console.log(`  Dormant memories:      ${stats.dormant}`);

  brain.close();

  // Cleanup demo data
  const { rmSync } = await import('node:fs');
  rmSync('./demo-data', { recursive: true, force: true });

  console.log('\n=== Demo complete ===');
}

demo().catch(console.error);
