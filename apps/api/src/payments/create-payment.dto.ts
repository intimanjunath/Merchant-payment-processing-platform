import { Transform } from 'class-transformer';
import { IsInt, IsString, Length, Max, MaxLength, Min } from 'class-validator';

/**
 * POST /payments body. Only a provider test token is accepted as the payment
 * method; any other field, such as a card number, is rejected by the global
 * ValidationPipe (forbidNonWhitelisted).
 */
export class CreatePaymentDto {
  @IsInt({ message: 'amount must be an integer number of cents' })
  @Min(1, { message: 'amount must be an integer from 1 to 100000000' })
  @Max(100_000_000, { message: 'amount must be an integer from 1 to 100000000' })
  amount!: number;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'reference must be a string' })
  @Length(1, 100, { message: 'reference must be 1 to 100 characters' })
  reference!: string;

  @IsString({ message: 'paymentMethod must be a string' })
  @MaxLength(100, { message: 'paymentMethod is not a recognized payment method' })
  paymentMethod!: string;
}
