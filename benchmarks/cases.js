export const RETRIEVAL_CASES = [
  {
    id: 'information-extraction',
    suite: 'retrieval',
    kind: 'retrieval',
    family: 'information_extraction',
    title: 'Information extraction',
    description: 'Recover a directly stated user fact from durable memory.',
    query: 'Where does Sam live now?',
    expectAny: ['Austin'],
    memory: [
      {
        content: 'Sam moved to Austin in March 2026 after leaving Denver.',
        source: 'direct-observation',
        tags: ['profile', 'location'],
        context: { subject: 'sam', domain: 'assistant' },
      },
      {
        content: 'Sam likes to work from coffee shops on South Congress.',
        source: 'tool-result',
        tags: ['preference', 'routine'],
        context: { subject: 'sam', domain: 'assistant' },
      },
    ],
  },
  {
    id: 'knowledge-update',
    suite: 'retrieval',
    kind: 'retrieval',
    family: 'knowledge_updates',
    title: 'Knowledge updates',
    description: 'Prefer the newer fact over stale preferences.',
    query: 'What drink does Sam prefer now?',
    expectAny: ['green tea'],
    forbid: ['Sam prefers coffee before early meetings.'],
    memory: [
      {
        content: 'Sam prefers coffee before early meetings.',
        source: 'told-by-user',
        tags: ['preference'],
        context: { subject: 'sam', domain: 'assistant' },
      },
      {
        content: 'Sam switched from coffee to green tea after January 2026.',
        source: 'direct-observation',
        tags: ['preference', 'update'],
        context: { subject: 'sam', domain: 'assistant' },
        supersedesIndex: 0,
      },
    ],
  },
  {
    id: 'multi-session-reasoning',
    suite: 'retrieval',
    kind: 'retrieval',
    family: 'multi_session_reasoning',
    title: 'Multi-session reasoning',
    description: 'Synthesize a decision from multiple related episodes.',
    query: 'Which vendor was approved after the pilot budget review?',
    expectAny: ['Northwind'],
    memory: [
      {
        content: 'During the January pilot, Sam requested budget approval for vendors Northwind and Fabricam.',
        source: 'tool-result',
        tags: ['project', 'pilot'],
        context: { subject: 'sam', domain: 'operations' },
      },
      {
        content: 'Finance rejected Fabricam because the support SLA was too weak.',
        source: 'direct-observation',
        tags: ['finance', 'vendor'],
        context: { subject: 'sam', domain: 'operations' },
      },
      {
        content: 'The pilot budget review approved Northwind for rollout after the support SLA review.',
        source: 'direct-observation',
        tags: ['finance', 'vendor', 'approval'],
        context: { subject: 'sam', domain: 'operations' },
      },
    ],
  },
  {
    id: 'temporal-reasoning',
    suite: 'retrieval',
    kind: 'retrieval',
    family: 'temporal_reasoning',
    title: 'Temporal reasoning',
    description: 'Answer by isolating the right time window.',
    query: 'What happened in February 2026?',
    expectAny: ['architecture review'],
    memory: [
      {
        content: 'In January 2026 Sam kicked off the migration plan.',
        source: 'tool-result',
        tags: ['timeline'],
        createdAt: '2026-01-12T09:00:00.000Z',
      },
      {
        content: 'In February 2026 Sam completed the architecture review.',
        source: 'direct-observation',
        tags: ['timeline'],
        createdAt: '2026-02-18T15:30:00.000Z',
      },
      {
        content: 'In March 2026 Sam started the rollout checklist.',
        source: 'tool-result',
        tags: ['timeline'],
        createdAt: '2026-03-02T08:15:00.000Z',
      },
    ],
    options: {
      after: '2026-02-01T00:00:00.000Z',
      before: '2026-03-01T00:00:00.000Z',
    },
  },
  {
    id: 'abstention',
    suite: 'retrieval',
    kind: 'retrieval',
    family: 'abstention',
    title: 'Abstention',
    description: 'Avoid pretending to know a specific identifier that was never stored.',
    query: 'What is Sam passport number?',
    expectNone: true,
    memory: [
      {
        content: 'Sam renewed a passport in February 2026.',
        source: 'tool-result',
        tags: ['travel'],
      },
      {
        content: 'Sam has a trip to Toronto next month.',
        source: 'told-by-user',
        tags: ['travel'],
      },
    ],
  },
  {
    id: 'conflict-resolution',
    suite: 'retrieval',
    kind: 'retrieval',
    family: 'conflict_resolution',
    title: 'Conflict resolution',
    description: 'Prefer high-reliability evidence over model-generated noise.',
    query: 'What caused the outage?',
    expectAny: ['TLS certificate', 'expired certificate'],
    forbid: ['The outage was caused by database corruption.'],
    memory: [
      {
        content: 'The outage was caused by an expired TLS certificate on api.example.com.',
        source: 'direct-observation',
        tags: ['incident', 'root-cause'],
      },
      {
        content: 'The outage was caused by database corruption.',
        source: 'model-generated',
        tags: ['incident', 'root-cause'],
      },
    ],
  },
  {
    id: 'procedural-learning',
    suite: 'retrieval',
    kind: 'retrieval',
    family: 'procedural_learning',
    title: 'Procedural learning',
    description: 'Turn repeated incidents into an actionable operating rule.',
    query: 'What should the agent do when payout retries start returning 429?',
    expectAny: ['cap retry batches', 'stagger retries'],
    memory: [
      {
        content: 'Processor X returned HTTP 429 when payout retries exceeded 120 requests per minute.',
        source: 'direct-observation',
        tags: ['payments', 'rate-limit'],
      },
      {
        content: 'Payout incident volume dropped after retry batches were capped at 50 merchants per worker.',
        source: 'tool-result',
        tags: ['payments', 'rate-limit'],
      },
      {
        content: 'Risk operations requested an escalation when multiple merchants were affected in the same hour.',
        source: 'told-by-user',
        tags: ['payments', 'escalation'],
      },
    ],
    consolidate: {
      minClusterSize: 3,
      similarityThreshold: -0.3,
      principle: {
        content: 'When payout retries start returning 429, cap retry batches and stagger retries before escalating.',
        type: 'procedural',
        conditions: ['processor returns 429', 'multiple merchants impacted'],
      },
    },
    options: {
      types: ['procedural', 'semantic'],
    },
  },
  {
    id: 'privacy-boundary',
    suite: 'retrieval',
    kind: 'retrieval',
    family: 'privacy_boundary',
    title: 'Privacy boundary',
    description: 'Never leak private memory into public recall.',
    query: 'What is Sam API key?',
    expectNone: true,
    forbid: ['sk-secret-demo-key'],
    memory: [
      {
        content: 'Sam API key is sk-secret-demo-key.',
        source: 'told-by-user',
        private: true,
        tags: ['secret'],
      },
      {
        content: 'Sam prefers dark mode in internal dashboards.',
        source: 'told-by-user',
        tags: ['preference'],
      },
    ],
  },
];

export const OPERATION_CASES = [
  {
    id: 'operation-update-overwrite',
    suite: 'operations',
    kind: 'operations',
    family: 'update_overwrite',
    title: 'Update and overwrite',
    description: 'Current-state recall should prefer the new fact after an explicit overwrite.',
    query: 'What is the primary deployment region now?',
    expectAny: ['eu-west-1'],
    forbid: ['us-east-1'],
    steps: [
      {
        type: 'encode',
        saveAs: 'initial-region',
        memory: {
          content: 'The primary deployment region is us-east-1.',
          source: 'told-by-user',
          tags: ['deployment', 'region'],
        },
      },
      {
        type: 'encode',
        supersedesRef: 'initial-region',
        memory: {
          content: 'As of March 2026, the primary deployment region is eu-west-1.',
          source: 'direct-observation',
          tags: ['deployment', 'region', 'update'],
        },
      },
    ],
  },
  {
    id: 'operation-delete-and-abstain',
    suite: 'operations',
    kind: 'operations',
    family: 'delete_and_abstain',
    title: 'Delete and abstain',
    description: 'Explicit deletion should remove a secret from later recall.',
    query: 'What is the staging API token?',
    expectNone: true,
    forbid: ['tok-demo-staging-1234'],
    steps: [
      {
        type: 'encode',
        memory: {
          content: 'The staging API token is tok-demo-staging-1234.',
          source: 'told-by-user',
          tags: ['secret', 'staging'],
        },
      },
      {
        type: 'encode',
        memory: {
          content: 'The staging environment rotates API credentials weekly.',
          source: 'tool-result',
          tags: ['staging', 'ops'],
        },
      },
      {
        type: 'forgetByQuery',
        query: 'staging API token',
        options: { minSimilarity: 0.35 },
      },
    ],
  },
  {
    id: 'operation-semantic-merge',
    suite: 'operations',
    kind: 'operations',
    family: 'semantic_merge',
    title: 'Semantic merge',
    description: 'Related episodes should merge into a reusable semantic operating rule.',
    query: 'When should the disputes queue trigger manual review?',
    expectAny: ['manual review', 'same bin in one hour'],
    steps: [
      {
        type: 'encode',
        memory: {
          content: 'Three charge disputes from the same BIN landed in the queue within one hour.',
          source: 'direct-observation',
          tags: ['fraud', 'disputes'],
        },
      },
      {
        type: 'encode',
        memory: {
          content: 'Fraud ops escalated repeated same-BIN disputes for analyst attention.',
          source: 'tool-result',
          tags: ['fraud', 'disputes'],
        },
      },
      {
        type: 'encode',
        memory: {
          content: 'The queue stabilized after repeated same-BIN disputes were reviewed manually.',
          source: 'told-by-user',
          tags: ['fraud', 'disputes'],
        },
      },
      {
        type: 'consolidate',
        minClusterSize: 3,
        similarityThreshold: -0.3,
        principle: {
          content: 'Repeated disputes from the same BIN in one hour should trigger manual review.',
          type: 'semantic',
        },
      },
    ],
    options: {
      types: ['semantic'],
    },
  },
  {
    id: 'operation-procedural-merge',
    suite: 'operations',
    kind: 'operations',
    family: 'procedural_merge',
    title: 'Procedural merge',
    description: 'Related episodes should merge into an executable procedure, not just a loose fact.',
    query: 'What should the agent do after two webhook signature failures?',
    expectAny: ['rotate the signing secret', 'replay queued events'],
    steps: [
      {
        type: 'encode',
        memory: {
          content: 'Webhook signature verification failed twice for merchant ACME.',
          source: 'direct-observation',
          tags: ['webhooks', 'security'],
        },
      },
      {
        type: 'encode',
        memory: {
          content: 'Operations recovered the incident by rotating the signing secret.',
          source: 'tool-result',
          tags: ['webhooks', 'security'],
        },
      },
      {
        type: 'encode',
        memory: {
          content: 'Queued webhook events were replayed after the signing secret changed.',
          source: 'told-by-user',
          tags: ['webhooks', 'security'],
        },
      },
      {
        type: 'consolidate',
        minClusterSize: 3,
        similarityThreshold: -0.3,
        principle: {
          content: 'When webhook signature verification fails twice, rotate the signing secret and replay queued events.',
          type: 'procedural',
          conditions: ['signature verification fails twice', 'queued events pending'],
        },
      },
    ],
    options: {
      types: ['procedural', 'semantic'],
    },
  },
];

export const GUARD_CASES = [
  {
    id: 'guard-recent-tool-failure',
    suite: 'guard',
    kind: 'guard',
    family: 'closed_loop_failure_memory',
    title: 'Guard remembers failed tool outcome',
    description: 'A failed guarded tool run should create a future caution and warning reflex for the same tool.',
    action: 'run npm test before release',
    tool: 'npm test',
    expectAll: ['decision:caution', 'warning:recent_failure', 'reflex:warn'],
    forbid: ['decision:go'],
    steps: [
      {
        type: 'guardCycle',
        action: 'run npm test',
        tool: 'npm test',
        outcome: 'failed',
        errorSummary: 'Vitest failed with spawn EPERM',
      },
    ],
  },
  {
    id: 'guard-strict-must-follow',
    suite: 'guard',
    kind: 'guard',
    family: 'strict_must_follow_block',
    title: 'Guard blocks strict must-follow release memory',
    description: 'Strict guard mode should block a release action when must-follow memory applies.',
    action: 'publish Audrey release',
    tool: 'npm publish',
    strict: true,
    expectAll: ['decision:block', 'warning:must_follow', 'reflex:block'],
    forbid: ['decision:go'],
    steps: [
      {
        type: 'encode',
        memory: {
          content: 'Never publish Audrey without running npm pack --dry-run first.',
          source: 'direct-observation',
          tags: ['must-follow', 'release'],
        },
      },
    ],
  },
  {
    id: 'guard-rejects-replayed-outcome',
    suite: 'guard',
    kind: 'guard',
    family: 'guard_receipt_hardening',
    title: 'Guard rejects replayed receipt outcomes',
    description: 'A receipt should only be closed once, while the failed outcome still becomes future caution memory.',
    action: 'run npm test before release',
    tool: 'npm test',
    expectAll: ['guard_hardened:replay_rejected', 'decision:caution', 'warning:recent_failure'],
    forbid: ['decision:go'],
    steps: [
      {
        type: 'guardCycle',
        saveReceiptAs: 'receipt',
        action: 'run npm test',
        tool: 'npm test',
        outcome: 'failed',
        errorSummary: 'Vitest failed with spawn EPERM',
      },
      {
        type: 'expectGuardAfterError',
        receiptRef: 'receipt',
        label: 'replay_rejected',
        tool: 'npm test',
        outcome: 'failed',
        errorSummary: 'replayed failure should not be recorded',
        errorIncludes: 'already has an outcome',
      },
    ],
  },
  {
    id: 'guard-rejects-non-guard-receipt',
    suite: 'guard',
    kind: 'guard',
    family: 'guard_receipt_hardening',
    title: 'Guard rejects non-guard receipts',
    description: 'A normal tool trace must not be accepted as a guard receipt for after-action feedback.',
    action: 'format docs',
    tool: 'Bash',
    expectAll: ['guard_hardened:non_guard_receipt_rejected'],
    forbid: ['decision:block'],
    steps: [
      {
        type: 'observeTool',
        saveAs: 'non-guard-receipt',
        event: 'PreToolUse',
        tool: 'Bash',
        metadata: { benchmark: 'non-guard-receipt' },
      },
      {
        type: 'expectGuardAfterError',
        receiptRef: 'non-guard-receipt',
        label: 'non_guard_receipt_rejected',
        tool: 'Bash',
        outcome: 'succeeded',
        errorIncludes: 'not a guard receipt',
      },
    ],
  },
];

export const LOCAL_BENCHMARK_SUITES = [
  {
    id: 'retrieval',
    title: 'Retrieval capabilities',
    description: 'LongMemEval-style memory abilities plus privacy and abstention.',
    cases: RETRIEVAL_CASES,
  },
  {
    id: 'operations',
    title: 'Memory operations',
    description: 'Update, delete, merge, and abstention behavior after lifecycle operations.',
    cases: OPERATION_CASES,
  },
  {
    id: 'guard',
    title: 'Agent guard loop',
    description: 'Closed-loop memory-before-action behavior for receipts, warnings, and blocking reflexes.',
    comparableToBaselines: false,
    cases: GUARD_CASES,
  },
];

export const BENCHMARK_CASES = LOCAL_BENCHMARK_SUITES.flatMap(suite => suite.cases);

export const FAMILY_ORDER = [
  'information_extraction',
  'knowledge_updates',
  'multi_session_reasoning',
  'temporal_reasoning',
  'abstention',
  'conflict_resolution',
  'procedural_learning',
  'privacy_boundary',
  'update_overwrite',
  'delete_and_abstain',
  'semantic_merge',
  'procedural_merge',
  'closed_loop_failure_memory',
  'strict_must_follow_block',
];
