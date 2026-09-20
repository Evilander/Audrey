import Database from './sqlite.js';
import type { EmbeddingProvider, ReembedCounts } from './types.js';
import { dropVec0Tables, createVec0Tables, refreshVectorRow } from './db.js';

interface EpisodeMigrateRow {
  id: string;
  agent: string;
  content: string;
  source: string;
  consolidated: number | null;
  superseded_by: string | null;
}

const REEMBED_BATCH_SIZE = 256;

async function embedInChunks(
  embeddingProvider: EmbeddingProvider,
  contents: string[],
  label: string,
): Promise<number[][]> {
  if (contents.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < contents.length; i += REEMBED_BATCH_SIZE) {
    const slice = contents.slice(i, i + REEMBED_BATCH_SIZE);
    try {
      const vectors = await embeddingProvider.embedBatch(slice);
      out.push(...vectors);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `reembedAll: embedBatch failed for ${label} (rows ${i}-${i + slice.length - 1}): ${cause}`,
        { cause: err },
      );
    }
  }
  return out;
}

interface SemanticMigrateRow {
  id: string;
  agent: string;
  content: string;
  state: string;
}

interface ProcedureMigrateRow {
  id: string;
  agent: string;
  content: string;
  state: string;
}

export async function reembedAll(
  db: Database,
  embeddingProvider: EmbeddingProvider,
  { dropAndRecreate = false }: { dropAndRecreate?: boolean } = {},
): Promise<ReembedCounts> {
  const episodes = db
    .prepare('SELECT id, agent, content, source, consolidated, superseded_by FROM episodes')
    .all() as EpisodeMigrateRow[];
  const semantics = db
    .prepare('SELECT id, agent, content, state FROM semantics')
    .all() as SemanticMigrateRow[];
  const procedures = db
    .prepare('SELECT id, agent, content, state FROM procedures')
    .all() as ProcedureMigrateRow[];

  const episodeVectors = await embedInChunks(
    embeddingProvider,
    episodes.map(ep => ep.content),
    'episodes',
  );
  const semanticVectors = await embedInChunks(
    embeddingProvider,
    semantics.map(s => s.content),
    'semantics',
  );
  const procedureVectors = await embedInChunks(
    embeddingProvider,
    procedures.map(p => p.content),
    'procedures',
  );

  // Embedding can be slow. Recheck row existence and content under the writer
  // lock before committing, then derive index metadata from the current row.
  const writeTx = db.transaction(() => {
    const stored = db.prepare("SELECT value FROM audrey_config WHERE key = 'dimensions'").get() as
      { value: string } | undefined;
    if (!dropAndRecreate && stored && Number(stored.value) !== embeddingProvider.dimensions) {
      throw new Error(
        'Embedding dimensions changed during re-embedding; retry with the current provider',
      );
    }
    const batches = [
      { table: 'episodes' as const, rows: episodes, vectors: episodeVectors },
      { table: 'semantics' as const, rows: semantics, vectors: semanticVectors },
      { table: 'procedures' as const, rows: procedures, vectors: procedureVectors },
    ];
    if (dropAndRecreate) {
      // Refuse to drop an index when a concurrent writer added or edited rows
      // that this embedding batch did not cover.
      for (const { table, rows } of batches) {
        const snapshot = new Map(rows.map(row => [row.id, row.content]));
        const current = db.prepare(`SELECT id, content FROM ${table}`).all() as Array<{
          id: string;
          content: string;
        }>;
        if (current.some(row => snapshot.get(row.id) !== row.content)) {
          throw new Error('Memories changed during re-embedding; retry before replacing the index');
        }
      }
      dropVec0Tables(db);
      createVec0Tables(db, embeddingProvider.dimensions);
      db.prepare("UPDATE audrey_config SET value = ? WHERE key = 'dimensions'").run(
        String(embeddingProvider.dimensions),
      );
    }
    for (const { table, rows, vectors } of batches) {
      const update = db.prepare(
        `UPDATE ${table} SET embedding = ?, embedding_model = COALESCE(?, embedding_model), embedding_version = COALESCE(?, embedding_version) WHERE id = ? AND content = ?`,
      );
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const buffer = embeddingProvider.vectorToBuffer(vectors[i]!);
        const changed = update.run(
          buffer,
          embeddingProvider.modelName ?? null,
          embeddingProvider.modelVersion ?? null,
          row.id,
          row.content,
        ).changes;
        if (changed) refreshVectorRow(db, table, row.id);
      }
    }
  });
  writeTx.immediate();

  return { episodes: episodes.length, semantics: semantics.length, procedures: procedures.length };
}
