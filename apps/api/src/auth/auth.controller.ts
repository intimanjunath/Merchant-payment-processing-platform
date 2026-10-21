import {
  Body,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { CookieOptions, Response } from 'express';

import type { ApiConfig } from '../config/config';
import { CONFIG } from '../tokens';
import { type AuthContext, type AuthenticatedRequest, SESSION_COOKIE } from './auth-context';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { csrfTokenFor } from './csrf';
import { LoginDto } from './login.dto';

const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  /** Browser login: the token goes in an HttpOnly cookie, never in the body. */
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(body.email, body.password, 'browser');
    res.cookie(SESSION_COOKIE, result.token, {
      ...this.cookieOptions(),
      maxAge: result.session.expiresAt.getTime() - Date.now(),
    });
    return {
      merchant: result.merchant,
      expiresAt: result.session.expiresAt.toISOString(),
      csrfToken: csrfTokenFor(this.config.csrfSecret, result.session.id),
    };
  }

  /** API-client login: the token is returned for use as a Bearer token; no cookie. */
  @Post('token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async token(@Body() body: LoginDto) {
    const result = await this.auth.login(body.email, body.password, 'api');
    return {
      accessToken: result.token,
      tokenType: 'Bearer',
      expiresAt: result.session.expiresAt.toISOString(),
    };
  }

  @Get('session')
  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  session(@CurrentAuth() auth: AuthContext) {
    return {
      merchant: auth.merchant,
      expiresAt: auth.session.expiresAt.toISOString(),
      csrfToken:
        auth.session.clientKind === 'browser'
          ? csrfTokenFor(this.config.csrfSecret, auth.session.id)
          : null,
    };
  }

  @Post('logout')
  @UseGuards(AuthGuard)
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(auth);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', secure: this.config.cookieSecure, path: '/' };
  }
}
