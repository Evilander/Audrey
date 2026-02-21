import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Audrey } from '../src/index.js';
import { existsSync, rmSync } from 'node:fs';

const TEST_DIR = './test-auto-consolidate';

describe('auto-consolidation', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('runs consolidation on interval', async () => {
    vi.useFakeTimers();
    const consolidateSpy = vi.spyOn(audrey, 'consolidate');
    audrey.startAutoConsolidate(1000);

    await vi.advanceTimersByTimeAsync(3500);

    expect(consolidateSpy).toHaveBeenCalledTimes(3);
    audrey.stopAutoConsolidate();
    vi.useRealTimers();
  });

  it('stopAutoConsolidate stops the interval', async () => {
    vi.useFakeTimers();
    const consolidateSpy = vi.spyOn(audrey, 'consolidate');
    audrey.startAutoConsolidate(1000);

    await vi.advanceTimersByTimeAsync(1500);
    audrey.stopAutoConsolidate();
    await vi.advanceTimersByTimeAsync(3000);

    expect(consolidateSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('close() stops auto-consolidation', async () => {
    vi.useFakeTimers();
    const consolidateSpy = vi.spyOn(audrey, 'consolidate');
    audrey.startAutoConsolidate(1000);

    await vi.advanceTimersByTimeAsync(1500);
    audrey.close();
    await vi.advanceTimersByTimeAsync(3000);

    expect(consolidateSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('emits consolidation events from auto-consolidate', async () => {
    vi.useFakeTimers();
    const events = [];
    audrey.on('consolidation', (e) => events.push(e));
    audrey.startAutoConsolidate(1000);

    await vi.advanceTimersByTimeAsync(1500);

    expect(events.length).toBe(1);
    audrey.stopAutoConsolidate();
    vi.useRealTimers();
  });

  it('throws if interval is too small', () => {
    expect(() => audrey.startAutoConsolidate(500)).toThrow();
  });

  it('throws if already running', () => {
    audrey.startAutoConsolidate(1000);
    expect(() => audrey.startAutoConsolidate(1000)).toThrow('already running');
  });
});
