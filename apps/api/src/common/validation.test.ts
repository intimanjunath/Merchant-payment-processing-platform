import type { ValidationError } from 'class-validator';

import { fieldIssues } from './validation';

const error = (
  property: string,
  constraints?: Record<string, string>,
  children: ValidationError[] = [],
) => ({ property, constraints, children }) as ValidationError;

describe('fieldIssues', () => {
  it('lists every broken rule per field', () => {
    expect(
      fieldIssues([
        error('amount', { isInt: 'amount must be an integer number of cents' }),
        error('reference', {
          isString: 'reference must be a string',
          isLength: 'reference must be 1 to 100 characters',
        }),
      ]),
    ).toEqual([
      { field: 'amount', issue: 'amount must be an integer number of cents' },
      { field: 'reference', issue: 'reference must be a string' },
      { field: 'reference', issue: 'reference must be 1 to 100 characters' },
    ]);
  });

  it('reports an unknown field without its value', () => {
    expect(
      fieldIssues([
        error('cardNumber', { whitelistValidation: 'property cardNumber should not exist' }),
      ]),
    ).toEqual([{ field: 'cardNumber', issue: 'is not an accepted field' }]);
  });

  it('names nested fields by path', () => {
    expect(
      fieldIssues([error('payment', undefined, [error('amount', { min: 'too small' })])]),
    ).toEqual([{ field: 'payment.amount', issue: 'too small' }]);
  });
});
