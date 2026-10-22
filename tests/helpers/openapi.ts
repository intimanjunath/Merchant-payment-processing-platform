import type { NestExpressApplication } from '@nestjs/platform-express';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020';

import { OPENAPI_DOCUMENT } from '../../apps/api/src/payments/openapi';

type Method = 'get' | 'post';
interface DocumentedResponse {
  content?: Record<string, { schema?: object }>;
}
interface DocumentedOperation {
  responses: Record<string, DocumentedResponse>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Strict mode: an unknown keyword or format in the document fails here.
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addFormat('uuid', UUID);
ajv.addFormat('date-time', ISO_TIMESTAMP);
ajv.addFormat('email', /^[^\s@]+@[^\s@]+$/);

/** OpenAPI refs point at #/components/schemas; as JSON Schema they live under $defs. */
function toJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toJsonSchema);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      key === '$ref' && typeof inner === 'string'
        ? inner.replace('#/components/schemas/', '#/$defs/')
        : toJsonSchema(inner),
    ]),
  );
}

const $defs = toJsonSchema(OPENAPI_DOCUMENT.components.schemas) as Record<string, object>;
const validators = new Map<string, ValidateFunction>();

function operationOf(method: Method, path: string): DocumentedOperation {
  const paths = OPENAPI_DOCUMENT.paths as Record<
    string,
    Partial<Record<Method, DocumentedOperation>>
  >;
  const operation = paths[path]?.[method];
  if (!operation) throw new Error(`${method.toUpperCase()} ${path} is not in the OpenAPI document`);
  return operation;
}

/**
 * Asserts the response's status is documented for this route and that its
 * JSON body matches the documented schema. Returns the response for chaining.
 */
export function conforms<T extends { status: number; body: unknown }>(
  response: T,
  method: Method,
  path: string,
): T {
  const documented = operationOf(method, path).responses[String(response.status)];
  if (!documented) {
    throw new Error(
      `${String(response.status)} is not documented for ${method.toUpperCase()} ${path}`,
    );
  }
  const schema = documented.content?.['application/json']?.schema;
  if (!schema) return response;

  const key = `${method} ${path} ${String(response.status)}`;
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile({ $defs, ...(toJsonSchema(schema) as object) });
    validators.set(key, validate);
  }
  if (!validate(response.body)) {
    throw new Error(
      `${key} does not match the OpenAPI schema: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(response.body)}`,
    );
  }
  return response;
}

/** Every schema in the document compiles under strict JSON Schema 2020-12. */
export function compileAllSchemas(): string[] {
  return Object.keys($defs).map((name) => {
    ajv.compile({ $defs, $ref: `#/$defs/${name}` });
    return name;
  });
}

/** "METHOD /path/{param}" for each route Express has, and for each route the document lists. */
export function routeLists(app: NestExpressApplication): {
  registered: string[];
  documented: string[];
} {
  interface Layer {
    route?: { path: string; methods: Record<string, boolean> };
  }
  const express = app.getHttpAdapter().getInstance() as { router: { stack: Layer[] } };
  const registered = express.router.stack.flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods).map(
          (method) =>
            `${method.toUpperCase()} ${layer.route?.path.replace(/:(\w+)/g, '{$1}') ?? ''}`,
        )
      : [],
  );
  const documented = Object.entries(OPENAPI_DOCUMENT.paths).flatMap(([path, operations]) =>
    Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
  );
  return { registered: [...new Set(registered)].sort(), documented: documented.sort() };
}
