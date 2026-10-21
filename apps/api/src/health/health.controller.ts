import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Registry } from '@payments/observability';
import type { Response } from 'express';

import { METRICS } from '../tokens';
import { ReadinessService } from './readiness.service';

@Controller()
export class HealthController {
  constructor(
    private readonly readiness: ReadinessService,
    @Inject(METRICS) private readonly metrics: Registry,
  ) {}

  /** Liveness: the process is up and serving. Checks nothing else on purpose. */
  @Get('health')
  @Header('Cache-Control', 'no-store')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: safe to send traffic. 503 names the failing check. */
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) res: Response) {
    const result = await this.readiness.check();
    res.status(result.ready ? 200 : 503);
    return { status: result.ready ? 'ready' : 'not_ready', checks: result.checks };
  }

  @Get('metrics')
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.metrics());
  }
}
