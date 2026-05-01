import { performance } from 'node:perf_hooks';

export interface ProfileSpan {
  name: string;
  start_ms: number;
  duration_ms: number;
}

export interface ProfileDiagnostics {
  enabled: true;
  operation: string;
  total_ms: number;
  spans: ProfileSpan[];
}

export class ProfileRecorder {
  readonly operation: string;
  readonly startedAt: number;
  readonly spans: ProfileSpan[] = [];

  constructor(operation: string) {
    this.operation = operation;
    this.startedAt = performance.now();
  }

  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await fn();
    } finally {
      this.record(name, startedAt);
    }
  }

  measureSync<T>(name: string, fn: () => T): T {
    const startedAt = performance.now();
    try {
      return fn();
    } finally {
      this.record(name, startedAt);
    }
  }

  record(name: string, startedAt: number, endedAt = performance.now()): void {
    this.spans.push({
      name,
      start_ms: roundMs(startedAt - this.startedAt),
      duration_ms: roundMs(endedAt - startedAt),
    });
  }

  finish(): ProfileDiagnostics {
    return {
      enabled: true,
      operation: this.operation,
      total_ms: roundMs(performance.now() - this.startedAt),
      spans: [...this.spans],
    };
  }
}

export function isAudreyProfileEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env['AUDREY_PROFILE'];
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}
