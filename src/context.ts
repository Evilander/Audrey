export function contextMatchRatio(
  encodingContext: Record<string, string> | null,
  retrievalContext: Record<string, string> | null,
): number {
  if (!encodingContext || !retrievalContext) return 0;
  const retrievalKeys = Object.keys(retrievalContext);
  if (retrievalKeys.length === 0) return 0;
  const sharedKeys = retrievalKeys.filter(k => k in encodingContext);
  if (sharedKeys.length === 0) return 0;
  const matches = sharedKeys.filter(k => encodingContext[k] === retrievalContext[k]).length;
  return matches / retrievalKeys.length;
}

export function contextModifier(
  encodingContext: Record<string, string> | null,
  retrievalContext: Record<string, string> | null,
  weight = 0.3,
): number {
  if (!encodingContext || !retrievalContext) return 1.0;
  const ratio = contextMatchRatio(encodingContext, retrievalContext);
  return 1.0 + (weight * ratio);
}
