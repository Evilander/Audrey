import { generateId } from './ulid.js';
import { buildCausalArticulationPrompt } from './prompts.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ causeId: string, effectId: string, linkType?: string, mechanism?: string, confidence?: number }} params
 * @returns {string}
 */
export function addCausalLink(db, { causeId, effectId, linkType = 'causal', mechanism, confidence }) {
  const id = generateId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO causal_links (id, cause_id, effect_id, link_type, mechanism, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, causeId, effectId, linkType, mechanism, confidence, now);

  return id;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} memoryId
 * @param {{ depth?: number }} [options]
 * @returns {Object[]}
 */
export function getCausalChain(db, memoryId, options = {}) {
  const { depth = 10 } = options;
  const results = [];
  const visited = new Set();
  const queue = [memoryId];
  let currentDepth = 0;

  while (queue.length > 0 && currentDepth < depth) {
    const nextQueue = [];
    for (const nodeId of queue) {
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const links = db.prepare(
        'SELECT * FROM causal_links WHERE cause_id = ?'
      ).all(nodeId);

      for (const link of links) {
        if (!visited.has(link.effect_id)) {
          results.push(link);
          nextQueue.push(link.effect_id);
        }
      }
    }
    queue.length = 0;
    queue.push(...nextQueue);
    currentDepth++;
  }

  return results;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('./llm.js').LLMProvider} llmProvider
 * @param {{ id: string, content: string, source: string }} cause
 * @param {{ id: string, content: string, source: string }} effect
 * @returns {Promise<{ linkId: string|null, mechanism: string, linkType: string, confidence: number, spurious: boolean }>}
 */
export async function articulateCausalLink(db, llmProvider, cause, effect) {
  const messages = buildCausalArticulationPrompt(cause, effect);
  const result = await llmProvider.json(messages);

  if (result.spurious) {
    return {
      linkId: null,
      mechanism: result.mechanism,
      linkType: result.linkType,
      confidence: result.confidence,
      spurious: true,
    };
  }

  const linkId = addCausalLink(db, {
    causeId: cause.id,
    effectId: effect.id,
    linkType: result.linkType || 'correlational',
    mechanism: result.mechanism,
    confidence: result.confidence,
  });

  return {
    linkId,
    mechanism: result.mechanism,
    linkType: result.linkType,
    confidence: result.confidence,
    spurious: false,
  };
}
