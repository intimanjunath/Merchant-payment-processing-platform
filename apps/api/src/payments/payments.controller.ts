import { Body, Controller, Get, Header, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import {
  capturePayment,
  createPayment,
  getPaymentDetails,
  type MutationContext,
  type MutationResponse,
  type PaymentDeps,
  refundPayment,
} from '@payments/payments';
import type { Response } from 'express';

import type { AuthContext } from '../auth/auth-context';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAuth } from '../auth/current-auth';
import { ApiError } from '../common/api-error';
import { requestIdOf, traceparentOf } from '../common/request-tracking';
import { PAYMENT_DEPS } from '../tokens';
import { CreatePaymentDto } from './create-payment.dto';
import { assertEmptyBody } from './empty-body';
import { IdempotencyKey } from './idempotency-key';
import { toApiError } from './payment-errors';

interface RejectedBody {
  error: { code: 'PROVIDER_REJECTED'; message: string; details: Record<string, unknown> };
}

/**
 * HTTP translation only: every lifecycle decision is made in packages/payments.
 * The merchant always comes from the verified session, never from the request.
 */
@Controller('payments')
@UseGuards(AuthGuard)
export class PaymentsController {
  constructor(@Inject(PAYMENT_DEPS) private readonly deps: PaymentDeps) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentAuth() auth: AuthContext,
    @IdempotencyKey() key: string,
    @Body() body: CreatePaymentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const response = await this.run(() =>
      createPayment(this.deps, this.context(auth, key, res), {
        amount: body.amount,
        reference: body.reference,
        paymentMethod: body.paymentMethod,
      }),
    );
    return this.send(res, response);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async details(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<unknown> {
    const details = await getPaymentDetails(this.deps.pool, auth.merchant.id, id);
    if (!details) throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
    return details;
  }

  @Post(':id/capture')
  @Header('Cache-Control', 'no-store')
  async capture(
    @CurrentAuth() auth: AuthContext,
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    assertEmptyBody(body);
    const response = await this.run(() =>
      capturePayment(this.deps, this.context(auth, key, res), { paymentId: id }),
    );
    return this.send(res, response);
  }

  @Post(':id/refund')
  @Header('Cache-Control', 'no-store')
  async refund(
    @CurrentAuth() auth: AuthContext,
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    assertEmptyBody(body);
    const response = await this.run(() =>
      refundPayment(this.deps, this.context(auth, key, res), { paymentId: id }),
    );
    return this.send(res, response);
  }

  private context(auth: AuthContext, key: string, res: Response): MutationContext {
    return {
      merchantId: auth.merchant.id,
      idempotencyKey: key,
      requestId: requestIdOf(res),
      traceparent: traceparentOf(res),
    };
  }

  private async run(work: () => Promise<MutationResponse>): Promise<MutationResponse> {
    try {
      return await work();
    } catch (error) {
      throw toApiError(error);
    }
  }

  /**
   * Writes a mutation's status and body. A saved 422 goes out through the
   * error envelope, so it carries this request's ID, also on replay.
   */
  private send(res: Response, response: MutationResponse): unknown {
    if (response.status === 422) {
      const { error } = response.body as RejectedBody;
      throw new ApiError(422, 'PROVIDER_REJECTED', error.message, { details: error.details });
    }
    res.status(response.status);
    if (response.status === 201 || response.status === 202) {
      const { payment } = response.body as { payment: { id: string } };
      res.setHeader('Location', `/payments/${payment.id}`);
    }
    return response.body;
  }
}
