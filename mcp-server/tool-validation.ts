/**
 * Shared validation primitives and admin/embedding guards for the MCP tool and
 * CLI surfaces. Kept separate from tool-schemas.ts and index.ts so both can
 * import them without a circular dependency.
 */
import type { EmbeddingProvider } from '../src/types.js';

export const VALID_SOURCES = [
  'direct-observation',
  'told-by-user',
  'tool-result',
  'inference',
  'model-generated',
] as const;

export const VALID_TYPES = ['episodic', 'semantic', 'procedural'] as const;

export const MAX_MEMORY_CONTENT_LENGTH = 50_000;
export const ADMIN_TOOLS_ENV = 'AUDREY_ENABLE_ADMIN_TOOLS';

export function isNonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateMemoryContent(content: string): void {
  if (!isNonEmptyText(content)) {
    throw new Error('content must be a non-empty string');
  }
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    throw new Error(`content exceeds maximum length of ${MAX_MEMORY_CONTENT_LENGTH} characters`);
  }
}

export function validateForgetSelection(id?: string, query?: string): void {
  if ((id && query) || (!id && !query)) {
    throw new Error('Provide exactly one of id or query');
  }
}

export function isAdminToolsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[ADMIN_TOOLS_ENV]?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function requireAdminTools(env: Record<string, string | undefined> = process.env): void {
  if (!isAdminToolsEnabled(env)) {
    throw new Error(
      `Admin memory tools are disabled. Set ${ADMIN_TOOLS_ENV}=1 to enable export, import, and forget operations.`,
    );
  }
}

export async function initializeEmbeddingProvider(provider: EmbeddingProvider): Promise<void> {
  if (provider && typeof provider.ready === 'function') {
    await provider.ready();
  }
}
