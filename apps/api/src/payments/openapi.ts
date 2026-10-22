// The API's OpenAPI 3.1 description, served at GET /openapi.json. It is
// written by hand and kept honest by tests: every registered route must be
// documented (and every documented route must exist), and the payment API
// tests validate real responses against these schemas.

const uuid = { type: 'string', format: 'uuid' } as const;
const timestamp = { type: 'string', format: 'date-time' } as const;
const nullable = <T extends object>(schema: T) => ({ oneOf: [schema, { type: 'null' }] });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const PAYMENT_STATES = ['pending', 'authorized', 'captured', 'settled', 'failed', 'refunded'];
const OPERATION_STATUSES = [
  'reserved',
  'awaiting_confirmation',
  'needs_review',
  'succeeded',
  'rejected',
];
const ERROR_CODES = [
  'VALIDATION_ERROR',
  'INVALID_CREDENTIALS',
  'UNAUTHENTICATED',
  'CSRF_REJECTED',
  'NOT_FOUND',
  'INVALID_STATE_TRANSITION',
  'OPERATION_IN_PROGRESS',
  'IDEMPOTENCY_CONFLICT',
  'PROVIDER_REJECTED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
];

const schemas = {
  Payment: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'state',
      'amount',
      'currency',
      'reference',
      'paymentMethod',
      'failureReason',
      'settlementReview',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: uuid,
      state: { type: 'string', enum: PAYMENT_STATES },
      amount: { type: 'integer', minimum: 1, maximum: 100_000_000, description: 'Integer cents' },
      currency: { type: 'string', enum: ['USD'] },
      reference: { type: 'string', minLength: 1, maxLength: 100 },
      paymentMethod: {
        type: 'object',
        additionalProperties: false,
        required: ['brand', 'last4'],
        properties: { brand: { type: 'string' }, last4: { type: 'string', pattern: '^[0-9]{4}$' } },
      },
      failureReason: nullable({ type: 'string', description: 'Set only when state is failed' }),
      settlementReview: { type: 'boolean' },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  },
  Operation: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'action', 'status', 'reason', 'createdAt', 'completedAt'],
    properties: {
      id: uuid,
      action: { type: 'string', enum: ['authorize', 'capture', 'refund'] },
      status: { type: 'string', enum: OPERATION_STATUSES },
      reason: nullable({ type: 'string' }),
      createdAt: timestamp,
      completedAt: nullable(timestamp),
    },
  },
  Transition: {
    type: 'object',
    additionalProperties: false,
    required: ['fromState', 'toState', 'actor', 'source', 'reason', 'requestId', 'occurredAt'],
    properties: {
      fromState: nullable({ type: 'string', enum: PAYMENT_STATES }),
      toState: { type: 'string', enum: PAYMENT_STATES },
      actor: { type: 'string', description: "'merchant:<id>' or 'system:settlement'" },
      source: { type: 'string', enum: ['api', 'worker'] },
      reason: { type: 'string' },
      requestId: { type: 'string' },
      occurredAt: timestamp,
    },
  },
  MutationResult: {
    type: 'object',
    additionalProperties: false,
    required: ['payment', 'operation'],
    properties: { payment: ref('Payment'), operation: ref('Operation') },
  },
  PaymentDetails: {
    type: 'object',
    additionalProperties: false,
    required: ['payment', 'pendingOperation', 'operations', 'transitions'],
    properties: {
      payment: ref('Payment'),
      pendingOperation: nullable(ref('Operation')),
      operations: { type: 'array', items: ref('Operation'), description: 'Oldest first' },
      transitions: { type: 'array', items: ref('Transition'), description: 'Oldest first' },
    },
  },
  PaymentList: {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'nextCursor'],
    properties: {
      items: { type: 'array', items: ref('Payment'), description: 'Newest first' },
      nextCursor: nullable({ type: 'string', description: 'null on the last page' }),
    },
  },
  CreatePaymentRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['amount', 'reference', 'paymentMethod'],
    properties: {
      amount: { type: 'integer', minimum: 1, maximum: 100_000_000 },
      reference: { type: 'string', minLength: 1, maxLength: 100, description: 'Trimmed' },
      paymentMethod: {
        type: 'string',
        description: 'A provider test token, never card data',
        enum: ['pm_card_visa', 'pm_card_declined', 'pm_timeout', 'pm_lost_response'],
      },
    },
  },
  Error: {
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message', 'requestId'],
        properties: {
          code: { type: 'string', enum: ERROR_CODES },
          message: { type: 'string' },
          requestId: { type: 'string' },
          details: {
            type: 'object',
            description:
              '`fields: [{ field, issue }]` for 400; `{ paymentId, operationId, code }` for 422',
          },
        },
      },
    },
  },
  Merchant: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'email', 'name'],
    properties: { id: uuid, email: { type: 'string' }, name: { type: 'string' } },
  },
  Credentials: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'password'],
    properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } },
  },
  BrowserSession: {
    type: 'object',
    additionalProperties: false,
    required: ['merchant', 'expiresAt', 'csrfToken'],
    properties: {
      merchant: ref('Merchant'),
      expiresAt: timestamp,
      csrfToken: nullable({ type: 'string', description: 'null for Bearer sessions' }),
    },
  },
  AccessToken: {
    type: 'object',
    additionalProperties: false,
    required: ['accessToken', 'tokenType', 'expiresAt'],
    properties: {
      accessToken: { type: 'string' },
      tokenType: { type: 'string', enum: ['Bearer'] },
      expiresAt: timestamp,
    },
  },
  Health: {
    type: 'object',
    additionalProperties: false,
    required: ['status'],
    properties: { status: { type: 'string', enum: ['ok'] } },
  },
  Readiness: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'checks'],
    properties: {
      status: { type: 'string', enum: ['ready', 'not_ready'] },
      checks: {
        type: 'object',
        additionalProperties: false,
        required: ['database', 'migrations'],
        properties: {
          database: { type: 'string', enum: ['ok', 'unavailable'] },
          migrations: { type: 'string', enum: ['ok', 'pending', 'unknown'] },
        },
      },
    },
  },
};

const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const error = (description: string) => ({ description, ...json(ref('Error')) });
const located = (description: string) => ({
  description,
  headers: { Location: { schema: { type: 'string' }, description: '/payments/{id}' } },
  ...json(ref('MutationResult')),
});

const authenticated = [{ bearer: [] }, { cookie: [] }];
const idempotencyKey = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', pattern: '^[\\x21-\\x7E]{1,128}$' },
};
const csrfToken = {
  name: 'X-CSRF-Token',
  in: 'header',
  required: false,
  description: 'Required on cookie-authenticated requests that change state',
  schema: { type: 'string' },
};
const paymentId = { name: 'id', in: 'path', required: true, schema: uuid };

const mutationErrors = {
  '400': error('Invalid body or Idempotency-Key'),
  '401': error('Not authenticated'),
  '403': error('Cookie request without a valid CSRF token or from a disallowed origin'),
  '409': error('INVALID_STATE_TRANSITION, OPERATION_IN_PROGRESS or IDEMPOTENCY_CONFLICT'),
  '503': error('The work could not be durably accepted'),
};

function action(name: 'capture' | 'refund') {
  return {
    post: {
      operationId: `${name}Payment`,
      summary: name === 'capture' ? 'Capture an authorized payment' : 'Refund a settled payment',
      security: authenticated,
      parameters: [paymentId, idempotencyKey, csrfToken],
      requestBody: {
        required: false,
        content: {
          'application/json': { schema: { type: 'object', additionalProperties: false } },
        },
      },
      responses: {
        '200': { description: 'Confirmed', ...json(ref('MutationResult')) },
        '202': located('Unresolved; poll the payment'),
        ...mutationErrors,
        '404': error('No such payment for this merchant'),
        '422': error('PROVIDER_REJECTED; the payment keeps its state'),
      },
    },
  };
}

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Merchant Payment Processing API',
    version: '0.1.0',
    description:
      'Create, capture and refund payments with idempotency keys. Amounts are integer cents in USD.',
  },
  components: {
    schemas,
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      cookie: { type: 'apiKey', in: 'cookie', name: 'pp_session' },
    },
  },
  paths: {
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness',
        responses: { '200': { description: 'Up', ...json(ref('Health')) } },
      },
    },
    '/ready': {
      get: {
        operationId: 'ready',
        summary: 'Readiness: database reachable and migrations applied',
        responses: {
          '200': { description: 'Ready', ...json(ref('Readiness')) },
          '503': { description: 'Not ready; names the failing check', ...json(ref('Readiness')) },
        },
      },
    },
    '/metrics': {
      get: {
        operationId: 'metrics',
        summary: 'Prometheus metrics',
        responses: {
          '200': { description: 'Text exposition format', content: { 'text/plain': {} } },
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'openapi',
        summary: 'This document',
        responses: { '200': { description: 'OpenAPI 3.1', content: { 'application/json': {} } } },
      },
    },
    '/auth/login': {
      post: {
        operationId: 'login',
        summary: 'Browser login; sets the pp_session cookie',
        requestBody: { required: true, ...json(ref('Credentials')) },
        responses: {
          '200': { description: 'Logged in', ...json(ref('BrowserSession')) },
          '400': error('Invalid body'),
          '401': error('INVALID_CREDENTIALS'),
          '403': error('Disallowed origin'),
          '429': error('Too many failed attempts; see Retry-After'),
        },
      },
    },
    '/auth/token': {
      post: {
        operationId: 'issueToken',
        summary: 'API-client login; returns a Bearer token and sets no cookie',
        requestBody: { required: true, ...json(ref('Credentials')) },
        responses: {
          '200': { description: 'Token issued', ...json(ref('AccessToken')) },
          '400': error('Invalid body'),
          '401': error('INVALID_CREDENTIALS'),
          '403': error('Disallowed origin'),
          '429': error('Too many failed attempts; see Retry-After'),
        },
      },
    },
    '/auth/session': {
      get: {
        operationId: 'session',
        summary: 'The current session, with a CSRF token for browser sessions',
        security: authenticated,
        responses: {
          '200': { description: 'Active session', ...json(ref('BrowserSession')) },
          '401': error('Not authenticated'),
        },
      },
    },
    '/auth/logout': {
      post: {
        operationId: 'logout',
        summary: 'Revoke the session and clear the cookie',
        security: authenticated,
        parameters: [csrfToken],
        responses: {
          '204': { description: 'Logged out' },
          '401': error('Not authenticated'),
          '403': error('Cookie request without a valid CSRF token'),
        },
      },
    },
    '/payments': {
      get: {
        operationId: 'listPayments',
        summary: "The merchant's payments, newest first",
        security: authenticated,
        parameters: [
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: PAYMENT_STATES },
          },
          {
            name: 'q',
            in: 'query',
            required: false,
            description: 'Case-insensitive substring of the reference; % and _ match themselves',
            schema: { type: 'string', minLength: 1, maxLength: 100 },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
          {
            name: 'cursor',
            in: 'query',
            required: false,
            description: 'nextCursor from the previous page, with the same status and q',
            schema: { type: 'string', maxLength: 512 },
          },
        ],
        responses: {
          '200': { description: 'One page', ...json(ref('PaymentList')) },
          '400': error('Invalid parameter, or a cursor that is tampered or for other filters'),
          '401': error('Not authenticated'),
        },
      },
      post: {
        operationId: 'createPayment',
        summary: 'Create and authorize a payment',
        security: authenticated,
        parameters: [idempotencyKey, csrfToken],
        requestBody: { required: true, ...json(ref('CreatePaymentRequest')) },
        responses: {
          '201': located('The provider answered: authorized, or failed with the decline reason'),
          '202': located('Unresolved; poll the payment'),
          ...mutationErrors,
        },
      },
    },
    '/payments/{id}': {
      get: {
        operationId: 'getPayment',
        summary: 'A payment with its operations and transitions',
        security: authenticated,
        parameters: [paymentId],
        responses: {
          '200': { description: 'The payment', ...json(ref('PaymentDetails')) },
          '401': error('Not authenticated'),
          '404': error('No such payment for this merchant'),
        },
      },
    },
    '/payments/{id}/capture': action('capture'),
    '/payments/{id}/refund': action('refund'),
  },
};
