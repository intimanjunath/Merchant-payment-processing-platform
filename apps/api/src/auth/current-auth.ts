import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthContext, AuthenticatedRequest } from './auth-context';

/** The merchant and session the AuthGuard verified for this request. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);
