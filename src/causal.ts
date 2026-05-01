import Database from 'better-sqlite3';
import type { CausalLinkRow, LLMProvider } from './types.js';
import { generateId } from './ulid.js';
import { buildCausalArticulationPrompt } from './prompts.js';

export function addCausalLink(
  db: Database.Database,
  { causeId, effectId, linkType = 'causal', mechanism, confidence }: {
    causeId: string;
    effectId: string;
    linkType?: string;
    mechanism?: string;
    confidence?: number;
  },
): string {
  const id = generateId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO causal_links (id, cause_id, effect_id, link_type, mechanism, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, causeId, effectId, linkType, mechanism, confidence, now);

  return id;
}

export function getCausalChain(
  db: Database.Database,
  memoryId: string,
  options: { depth?: number } = {},
): CausalLinkRow[] {
  const { depth = 10 } = options;
  const results: CausalLinkRow[] = [];
  const visited = new Set<string>();
  const queue = [memoryId];
  let currentDepth = 0;

  while (queue.length > 0 && currentDepth < depth) {
    const nextQueue: string[] = [];
    for (const nodeId of queue) {
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const links = db.prepare(
        'SELECT * FROM causal_links WHERE cause_id = ?'
      ).all(nodeId) as CausalLinkRow[];

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

export async function articulateCausalLink(
  db: Database.Database,
  llmProvider: LLMProvider,
  cause: { id: string; content: string; source: string },
  effect: { id: string; content: string; source: string },
): Promise<{
  linkId: string | null;
  mechanism: string;
  linkType: string;
  confidence: number;
  spurious: boolean;
}> {
  const messages = buildCausalArticulationPrompt(cause, effect);
  const raw = await llmProvider.json(messages);
  if (!raw || typeof raw !== 'object') {
    throw new Error('Causal articulation LLM response must be a JSON object');
  }
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.spurious !== 'boolean' ||
    typeof candidate.mechanism !== 'string' ||
    typeof candidate.confidence !== 'number' ||
    !Number.isFinite(candidate.confidence)
  ) {
    throw new Error('Causal articulation LLM response is missing required fields');
  }
  const result = {
    spurious: candidate.spurious,
    mechanism: candidate.mechanism,
    linkType: typeof candidate.linkType === 'string' && candidate.linkType
      ? candidate.linkType
      : 'correlational',
    confidence: candidate.confidence,
  };

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
    linkType: result.linkType,
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
