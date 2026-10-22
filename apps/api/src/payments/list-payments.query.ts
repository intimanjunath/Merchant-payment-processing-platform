import { PAYMENT_STATES } from '@payments/payments';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

/** GET /payments query (spec §4.4). Unknown parameters are rejected like unknown body fields. */
export class ListPaymentsQuery {
  @IsOptional()
  @IsIn(PAYMENT_STATES, { message: `status must be one of ${PAYMENT_STATES.join(', ')}` })
  status?: string;

  @IsOptional()
  @IsString({ message: 'q must be a single string' })
  @Length(1, 100, { message: 'q must be 1 to 100 characters' })
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer from 1 to 100' })
  @Min(1, { message: 'limit must be an integer from 1 to 100' })
  @Max(100, { message: 'limit must be an integer from 1 to 100' })
  limit?: number;

  @IsOptional()
  @IsString({ message: 'cursor must be a single string' })
  @MaxLength(512, { message: 'cursor is not valid for this query' })
  cursor?: string;
}

export const DEFAULT_LIST_LIMIT = 25;
