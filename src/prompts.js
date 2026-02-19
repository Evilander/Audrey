import { safeJsonParse } from './utils.js';

export function buildPrincipleExtractionPrompt(episodes) {
  const episodeList = episodes.map((ep, i) => {
    const tags = safeJsonParse(ep.tags, []);
    return `Episode ${i + 1}:
- Content: ${ep.content}
- Source: ${ep.source}
- Date: ${ep.created_at}
- Tags: ${tags.length > 0 ? tags.join(', ') : 'none'}`;
  }).join('\n\n');

  return [
    {
      role: 'system',
      content: `You are performing principleExtraction for a memory system. Given a cluster of related episodic memories, extract a generalized principle or procedure.

Respond with ONLY valid JSON in this exact format:
{
  "content": "The generalized principle expressed as a clear, actionable statement",
  "type": "semantic or procedural — semantic for factual principles, procedural for how-to/workflow knowledge",
  "conditions": ["boundary condition 1", "boundary condition 2"] or null if universally applicable
}

Rules:
- GENERALIZE, do not merely summarize or concatenate the episodes
- Identify boundary conditions: when does this principle NOT apply?
- Classify as "semantic" (facts, rules, patterns) or "procedural" (steps, workflows, strategies)
- Consider source diversity — principles from diverse sources are stronger
- Be concise but precise`,
    },
    {
      role: 'user',
      content: `Extract a principle from these ${episodes.length} related episodes:\n\n${episodeList}`,
    },
  ];
}

export function buildContradictionDetectionPrompt(newContent, existingContent) {
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

export function buildCausalArticulationPrompt(cause, effect) {
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

export function buildContextResolutionPrompt(claimA, claimB, context) {
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
