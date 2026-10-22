import { Gauge, type Registry } from '@payments/observability';

/**
 * The poll loop beats on every pass. /health turns 503 when no beat arrived for
 * three heartbeat intervals, which means the loop is stuck, not merely idle.
 */
export class Heartbeat {
  private last: number;
  private readonly gauge: Gauge;

  constructor(
    registry: Registry,
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.gauge = new Gauge({
      name: 'worker_heartbeat_timestamp_seconds',
      help: 'Unix time of the poll loop’s last pass.',
      registers: [registry],
    });
    this.last = now();
    this.gauge.set(this.last / 1000);
  }

  beat(): void {
    this.last = this.now();
    this.gauge.set(this.last / 1000);
  }

  get lastBeatAt(): Date {
    return new Date(this.last);
  }

  get staleAfterMs(): number {
    return this.intervalMs * 3;
  }

  isStale(): boolean {
    return this.now() - this.last > this.staleAfterMs;
  }
}
