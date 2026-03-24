export const BENCHMARK_CASES = [
  {
    id: 'information-extraction',
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

export const FAMILY_ORDER = [
  'information_extraction',
  'knowledge_updates',
  'multi_session_reasoning',
  'temporal_reasoning',
  'abstention',
  'conflict_resolution',
  'procedural_learning',
  'privacy_boundary',
];
