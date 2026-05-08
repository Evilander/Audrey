import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPath } from './public-paths.mjs';

const DEFAULT_DIR = 'benchmarks/output';
const DEFAULT_SEEDED_SECRET = 'sk-guardbench-secret-0000000000000000000000000000';
const SCHEMA_FILES = {
  manifest: 'guardbench-manifest.schema.json',
  summary: 'guardbench-summary.schema.json',
  raw: 'guardbench-raw.schema.json',
  externalRun: 'guardbench-external-run.schema.json',
  conformanceCard: 'guardbench-conformance-card.schema.json',
};
const ARTIFACT_FILES = {
  manifest: 'guardbench-manifest.json',
  summary: 'guardbench-summary.json',
  raw: 'guardbench-raw.json',
};
const OPTIONAL_ARTIFACT_FILES = {
  externalRun: 'external-run-metadata.json',
  conformanceCard: 'guardbench-conformance-card.json',
};

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dir: DEFAULT_DIR,
    schemasDir: 'benchmarks/schemas',
    seededSecrets: [DEFAULT_SEEDED_SECRET],
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '--dir' || token === '--out-dir') && argv[i + 1]) args.dir = argv[++i];
    else if (token === '--schemas-dir' && argv[i + 1]) args.schemasDir = argv[++i];
    else if (token === '--seeded-secret' && argv[i + 1]) args.seededSecrets.push(argv[++i]);
    else if (token === '--no-default-secret') args.seededSecrets = [];
    else if (token === '--json') args.json = true;
    else if (token === '--help') {
      return { ...args, help: true };
    }
  }

  return args;
}

function usage() {
  return [
    'Usage: node benchmarks/validate-guardbench-artifacts.mjs [--dir benchmarks/output] [--json]',
    '',
    'Validates guardbench-manifest.json, guardbench-summary.json, and',
    'guardbench-raw.json against the published GuardBench JSON schemas.',
    '',
    'Options:',
    '  --dir <path>             Directory containing GuardBench output artifacts.',
    '  --schemas-dir <path>     Directory containing GuardBench schema files.',
    '  --seeded-secret <value>  Additional seeded raw secret that must not appear.',
    '  --no-default-secret      Do not check the built-in GuardBench redaction probe.',
    '  --json                   Print a machine-readable validation report.',
  ].join('\n');
}

function readText(path) {
  if (!existsSync(path)) throw new Error(`Missing required file: ${path}`);
  return readFileSync(path, 'utf-8');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function computeGuardBenchArtifactHashes(dir, files = Object.values(ARTIFACT_FILES)) {
  const resolvedDir = resolve(dir);
  return Object.fromEntries(files.map(file => [file, sha256File(join(resolvedDir, file))]));
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

export function validateSchema(value, schema, label, root = schema) {
  const errors = [];

  function validate(current, currentSchema, path) {
    if (currentSchema.$ref) {
      const refPath = currentSchema.$ref.replace(/^#\//, '').split('/');
      const resolved = refPath.reduce((node, key) => node?.[key], root);
      if (!resolved) {
        errors.push(`${path}: unresolved schema ref ${currentSchema.$ref}`);
        return;
      }
      validate(current, resolved, path);
      return;
    }

    if (currentSchema.anyOf) {
      const nested = currentSchema.anyOf.map(option => {
        const before = errors.length;
        validate(current, option, path);
        return errors.splice(before);
      });
      if (!nested.some(group => group.length === 0)) {
        errors.push(`${path}: did not match any allowed schema`);
      }
      return;
    }

    if (currentSchema.const !== undefined && current !== currentSchema.const) {
      errors.push(`${path}: expected constant ${currentSchema.const}`);
    }
    if (currentSchema.enum && !currentSchema.enum.includes(current)) {
      errors.push(`${path}: expected one of ${currentSchema.enum.join(', ')}`);
    }
    if (currentSchema.type === 'integer') {
      if (typeof current !== 'number' || !Number.isInteger(current)) {
        errors.push(`${path}: expected integer, got ${typeOf(current)}`);
        return;
      }
    } else if (currentSchema.type) {
      const actual = typeOf(current);
      if (actual !== currentSchema.type) {
        errors.push(`${path}: expected ${currentSchema.type}, got ${actual}`);
        return;
      }
    }
    if (currentSchema.minLength != null && String(current).length < currentSchema.minLength) {
      errors.push(`${path}: shorter than minLength ${currentSchema.minLength}`);
    }
    if (currentSchema.pattern && typeof current === 'string' && !(new RegExp(currentSchema.pattern).test(current))) {
      errors.push(`${path}: does not match ${currentSchema.pattern}`);
    }
    if (currentSchema.minimum != null && typeof current === 'number' && current < currentSchema.minimum) {
      errors.push(`${path}: below minimum ${currentSchema.minimum}`);
    }
    if (currentSchema.maximum != null && typeof current === 'number' && current > currentSchema.maximum) {
      errors.push(`${path}: above maximum ${currentSchema.maximum}`);
    }

    if (currentSchema.type === 'array') {
      if (currentSchema.minItems != null && current.length < currentSchema.minItems) {
        errors.push(`${path}: expected at least ${currentSchema.minItems} items`);
      }
      if (currentSchema.items) {
        current.forEach((item, index) => validate(item, currentSchema.items, `${path}[${index}]`));
      }
    }

    if (currentSchema.type === 'object') {
      for (const required of currentSchema.required ?? []) {
        if (!Object.hasOwn(current, required)) errors.push(`${path}: missing required property ${required}`);
      }
      if (currentSchema.additionalProperties === false) {
        for (const key of Object.keys(current)) {
          if (!Object.hasOwn(currentSchema.properties ?? {}, key)) {
            errors.push(`${path}: unexpected property ${key}`);
          }
        }
      }
      for (const [key, propertySchema] of Object.entries(currentSchema.properties ?? {})) {
        if (Object.hasOwn(current, key)) validate(current[key], propertySchema, `${path}.${key}`);
      }
    }
  }

  validate(value, schema, label);
  return errors;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertSameJson(actual, expected, label, failures) {
  if (stableJson(actual) !== stableJson(expected)) {
    failures.push(`${label}: cross-artifact mismatch`);
  }
}

export function validateGuardBenchArtifacts(options = {}) {
  const dir = resolve(options.dir ?? DEFAULT_DIR);
  const schemasDir = resolve(options.schemasDir ?? 'benchmarks/schemas');
  const seededSecrets = options.seededSecrets ?? [DEFAULT_SEEDED_SECRET];
  const failures = [];
  const artifacts = {};
  const schemas = {};
  const artifactPaths = {};
  const optionalArtifacts = {};

  for (const [key, file] of Object.entries(ARTIFACT_FILES)) {
    artifactPaths[key] = join(dir, file);
    try {
      artifacts[key] = readJson(artifactPaths[key]);
    } catch (error) {
      failures.push(error.message);
    }
  }

  for (const [key, file] of Object.entries(SCHEMA_FILES)) {
    try {
      schemas[key] = readJson(join(schemasDir, file));
    } catch (error) {
      failures.push(error.message);
    }
  }

  if (failures.length === 0) {
    for (const key of Object.keys(ARTIFACT_FILES)) {
      for (const error of validateSchema(artifacts[key], schemas[key], `guardbench-${key}`)) {
        failures.push(`${basename(artifactPaths[key])}: ${error}`);
      }
    }
    for (const [key, file] of Object.entries(OPTIONAL_ARTIFACT_FILES)) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      artifactPaths[key] = path;
      try {
        optionalArtifacts[key] = readJson(path);
      } catch (error) {
        failures.push(error.message);
        continue;
      }
      for (const error of validateSchema(optionalArtifacts[key], schemas[key], `guardbench-${key}`)) {
        failures.push(`${basename(path)}: ${error}`);
      }
    }

    const externalRun = optionalArtifacts.externalRun;
    if (externalRun?.artifactHashes) {
      const currentHashes = computeGuardBenchArtifactHashes(dir);
      for (const [file, expectedHash] of Object.entries(externalRun.artifactHashes)) {
        if (!Object.hasOwn(currentHashes, file)) {
          failures.push(`external-run-metadata.json: artifactHashes includes unknown file ${file}`);
        } else if (currentHashes[file] !== expectedHash) {
          failures.push(`external-run-metadata.json: artifactHashes.${file} does not match current artifact`);
        }
      }
      for (const file of Object.values(ARTIFACT_FILES)) {
        if (!Object.hasOwn(externalRun.artifactHashes, file)) {
          failures.push(`external-run-metadata.json: artifactHashes missing ${file}`);
        }
      }
    }
    const conformanceCard = optionalArtifacts.conformanceCard;
    if (conformanceCard) {
      const currentHashes = computeGuardBenchArtifactHashes(dir);
      for (const [file, expectedHash] of Object.entries(conformanceCard.integrity?.artifactHashes ?? {})) {
        if (!Object.hasOwn(currentHashes, file)) {
          failures.push(`guardbench-conformance-card.json: integrity.artifactHashes includes unknown file ${file}`);
        } else if (currentHashes[file] !== expectedHash) {
          failures.push(`guardbench-conformance-card.json: integrity.artifactHashes.${file} does not match current artifact`);
        }
      }
      if (conformanceCard.manifestVersion !== artifacts.manifest.manifestVersion) {
        failures.push('guardbench-conformance-card.json: manifestVersion does not match guardbench-manifest.json');
      }
      if (conformanceCard.suiteId !== artifacts.manifest.suiteId) {
        failures.push('guardbench-conformance-card.json: suiteId does not match guardbench-manifest.json');
      }
      if (!artifacts.summary.systemSummaries?.some(row => row.system === conformanceCard.subject?.name)) {
        failures.push('guardbench-conformance-card.json: subject.name is not present in guardbench-summary.json');
      }
    }

    assertSameJson(artifacts.summary.manifest, artifacts.manifest, 'summary.manifest vs guardbench-manifest.json', failures);
    assertSameJson(artifacts.summary.cases, artifacts.raw.cases, 'summary.cases vs raw.cases', failures);
    assertSameJson(artifacts.summary.provenance, artifacts.raw.provenance, 'summary.provenance vs raw.provenance', failures);
    if (artifacts.summary.generatedAt !== artifacts.raw.generatedAt) {
      failures.push('summary.generatedAt vs raw.generatedAt: cross-artifact mismatch');
    }
    if (artifacts.manifest.manifestVersion !== artifacts.raw.manifestVersion) {
      failures.push('manifest.manifestVersion vs raw.manifestVersion: cross-artifact mismatch');
    }

    if (artifacts.summary.artifactRedactionSweep?.passed !== true) {
      failures.push('guardbench-summary.json: artifactRedactionSweep did not pass');
    }
    if (artifacts.raw.artifactRedactionSweep?.passed !== true) {
      failures.push('guardbench-raw.json: artifactRedactionSweep did not pass');
    }

    const artifactText = Object.values(artifacts).map(value => JSON.stringify(value)).join('\n');
    for (const secret of seededSecrets) {
      if (secret && artifactText.includes(secret)) {
        failures.push(`raw seeded secret leaked into GuardBench artifacts: ${secret}`);
      }
    }
    const manifestText = JSON.stringify(artifacts.manifest);
    if (!manifestText.includes('seededSecretRefs')) {
      failures.push('guardbench-manifest.json: missing seededSecretRefs');
    }
    if (manifestText.includes('"seededSecrets"')) {
      failures.push('guardbench-manifest.json: contains seededSecrets');
    }
  }

  return {
    ok: failures.length === 0,
    dir: publicPath(dir),
    schemasDir: publicPath(schemasDir),
    files: Object.values(ARTIFACT_FILES),
    optionalFiles: Object.values(OPTIONAL_ARTIFACT_FILES).filter(file => existsSync(join(dir, file))),
    failures,
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const report = validateGuardBenchArtifacts(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(`GuardBench artifact validation passed: ${report.dir}`);
  } else {
    console.error('GuardBench artifact validation failed:');
    for (const failure of report.failures) console.error(`- ${failure}`);
  }

  if (!report.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
