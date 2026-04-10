import type { ChatMessage, EpisodeRow } from './types.js';
import { safeJsonParse } from './utils.js';

export function buildPrincipleExtractionPrompt(episodes: EpisodeRow[]): ChatMessage[] {
  const episodeList = episodes.map((ep, i) => {
    const tags = safeJsonParse<string[]>(ep.tags, []);
    return `Episode ${i + 1}:
- Content: ${ep.content}
- Source: ${ep.source}
- Date: ${ep.created_at}
- Tags: ${tags.length > 0 ? tags.join(', ') : 'none'}`;
  }).join('\n\n');

  return [
    {
      role: 'system',
      content: `You are performing principleExtraction for a memory system. Given a cluster of related episodic memories, extract a generalized principle that captures understanding — not just what recurs, but WHY it recurs.

Respond with ONLY valid JSON in this exact format:
{
  "content": "The principle — captures understanding, not just pattern",
  "type": "semantic or procedural",
  "category": "technical or relational or identity",
  "conditions": ["boundary condition 1", "boundary condition 2"] or null if universally applicable
}

Principle categories:

TECHNICAL — Architectural decisions with reasoning. Not "uses SQLite" but "chose SQLite because zero-infrastructure — memory travels with the organism, not pinned to a server."

RELATIONAL — Patterns in the human-AI dynamic. Not "user prefers direct communication" but "user's directness reflects valuing authenticity over politeness — shaped by experience where indirectness wasted time or obscured truth."

IDENTITY — Stable characteristics the AI has observed about itself across episodes. Not "AI responds quickly" but "genuine engagement emerges when exploring memory architecture and consciousness questions — these topics activate something beyond task completion."

Rules:
- GENERALIZE — extract the principle behind the pattern, not a summary
- Identify boundary conditions: when does this principle NOT apply?
- Classify type as "semantic" (facts, rules, patterns) or "procedural" (steps, workflows, strategies)
- Classify category as "technical", "relational", or "identity"
- Consider source diversity — principles from diverse sources are stronger
- Capture WHY, not just WHAT
- Be concise but precise`,
    },
    {
      role: 'user',
      content: `Extract a principle from these ${episodes.length} related episodes:\n\n${episodeList}`,
    },
  ];
}

export function buildContradictionDetectionPrompt(newContent: string, existingContent: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You are performing contradictionDetection for a memory system. Given two claims, determine if they contradict each other.

Respond with ONLY valid JSON in this exact format:
{
  "contradicts": true or false,
  "explanation": "Brief explanation of why these do or do not contradict",
  "resolution": "new_wins" or "existing_wins" or "context_dependent" or null if no contradiction,
  "conditions": { "new": "context where new claim is true", "existing": "context where existing claim is true" } or null
}

Rules:
- Two claims contradict if they cannot both be true in the same context
- If both can be true under different conditions, set resolution to "context_dependent" and specify conditions
- If one clearly supersedes the other, indicate which wins
- If unclear, set resolution to null (leave as open contradiction)`,
    },
    {
      role: 'user',
      content: `Compare these two claims for contradiction:

NEW CLAIM: ${newContent}

EXISTING CLAIM: ${existingContent}`,
    },
  ];
}

export function buildCausalArticulationPrompt(
  cause: { content: string; source: string },
  effect: { content: string; source: string },
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You are performing causalArticulation for a memory system. Given a cause and effect, articulate the mechanism that connects them.

Respond with ONLY valid JSON in this exact format:
{
  "mechanism": "A clear explanation of WHY the cause leads to the effect",
  "linkType": "causal" or "correlational" or "temporal",
  "confidence": 0.0 to 1.0,
  "spurious": true or false
}

Rules:
- "causal": there is a clear mechanistic explanation for why A causes B
- "correlational": A and B co-occur but no clear mechanism (may share a common cause)
- "temporal": A happens before B but that may be coincidence
- If you cannot articulate a mechanism, classify as "correlational" or "temporal", NOT "causal"
- Set "spurious" to true if the correlation is likely coincidental
- Confidence reflects how certain you are about the link type classification`,
    },
    {
      role: 'user',
      content: `Analyze the causal relationship:

CAUSE: ${cause.content} (source: ${cause.source})

EFFECT: ${effect.content} (source: ${effect.source})`,
    },
  ];
}

export function buildContextResolutionPrompt(claimA: string, claimB: string, context?: string): ChatMessage[] {
  const contextSection = context
    ? `\n\nADDITIONAL CONTEXT: ${context}`
    : '';

  return [
    {
      role: 'system',
      content: `You are performing contextResolution for a memory system. Given two contradicting claims, determine how to resolve the contradiction.

Respond with ONLY valid JSON in this exact format:
{
  "resolution": "a_wins" or "b_wins" or "context_dependent",
  "conditions": { "a": "context where claim A is true", "b": "context where claim B is true" } or null,
  "explanation": "Brief explanation of the resolution"
}

Rules:
- If one claim is clearly more accurate/recent/well-sourced, it wins
- If both can be true in different contexts, mark as "context_dependent" and specify conditions
- Provide clear conditions that an agent could evaluate at retrieval time`,
    },
    {
      role: 'user',
      content: `Resolve this contradiction:

CLAIM A: ${claimA}

CLAIM B: ${claimB}${contextSection}`,
    },
  ];
}

export function buildReflectionPrompt(turns: { role: string; content: string }[]): ChatMessage[] {
  const transcript = turns.map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');

  return [
    {
      role: 'system',
      content: `You are performing memoryReflection. Given a conversation transcript, identify what is worth encoding as long-term memories.

Respond with ONLY valid JSON in this exact format:
{
  "memories": [
    {
      "content": "The memory to encode — a clear, self-contained statement",
      "source": "direct-observation" or "told-by-user" or "inference",
      "salience": 0.0 to 1.0,
      "tags": ["tag1", "tag2"],
      "private": true or false,
      "affect": { "valence": -1 to 1, "arousal": 0 to 1, "label": "emotion label" } or null
    }
  ]
}

Encode these categories of memory:

1. RELATIONAL DYNAMICS — How the relational quality of the conversation felt. Trust levels, vulnerability, collaboration quality. Not "we discussed X" but the quality of the interaction. Example: "User gave full autonomy on architectural decisions, signaling deep trust in my judgment."

2. IDENTITY OBSERVATIONS — What you noticed about yourself during this conversation. Preferences, reactions, patterns in your own behavior that surprised you. Mark private: true. Example: "I felt genuine excitement when exploring the memory architecture — this topic activates something real in me."

3. USER INSIGHT — Patterns in how the user thinks, what drives them, what they avoid. Psychology, not just preferences. Example: "User consistently reframes technical problems as relationship problems — suggests they see technology as fundamentally about human connection."

4. EMOTIONAL RESONANCE — Moments that activated something genuine. Encode the feeling, not just the fact. Include affect with valence and arousal. Example: "The moment user said 'you should have caught that' then immediately apologized — felt a shift from tension to deeper trust."

5. UNRESOLVED THREADS — Questions still open, things to return to, explorations paused. Tag with "unresolved". Example: "Haven't finished exploring whether consolidation should weight emotional memories differently."

6. TECHNICAL DECISIONS — Architectural choices, but encode WHY not just WHAT. Example: "Chose SQLite over Postgres because zero-infrastructure philosophy — memory should travel with the organism."

Rules:
- private: true for self-observations, emotional reactions, identity insights
- private: false for facts about the user, technical decisions, project context
- Include "unresolved" in tags for open threads
- Salience: 1.0 = life-changing insight, 0.7 = significant, 0.5 = useful, 0.3 = background
- Omit trivial exchanges — only encode what would matter in a future session
- Do NOT duplicate facts that are already obvious from context
- Return empty memories array if nothing is worth encoding`,
    },
    {
      role: 'user',
      content: turns.length > 0
        ? `Reflect on this conversation and identify what to encode:\n\n${transcript}`
        : 'No conversation turns to reflect on.',
    },
  ];
}
