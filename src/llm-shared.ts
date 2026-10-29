/** Helpers shared by the API-key and subscription LLM providers. */

export function extractJSON(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return fenced ? fenced[1]!.trim() : text.trim();
}

const notifiedCloudEgressProviders = new Set<string>();

/**
 * One unmissable stderr notice per process, per provider, before the first
 * outbound completion. Memory content (raw episode text, embedded verbatim
 * by buildPrincipleExtractionPrompt) is about to leave the machine, and a
 * user watching the process should see that named plainly at least once.
 */
export function warnCloudEgressOnce(
  providerLabel: string,
  endpointHost: string,
  message = `[audrey] Sending memory content to ${providerLabel} (${endpointHost}) for LLM processing. ` +
    'Set AUDREY_LLM_PROVIDER to change this or leave it unset/"auto" for local-only heuristics.\n',
): void {
  if (notifiedCloudEgressProviders.has(providerLabel)) return;
  notifiedCloudEgressProviders.add(providerLabel);
  process.stderr.write(message);
}
