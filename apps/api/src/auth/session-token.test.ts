import jwt from 'jsonwebtoken';

import { signSessionToken, type TokenSettings, verifySessionToken } from './session-token';

const settings: TokenSettings = {
  secret: 'unit-test-secret-0123456789abcdef',
  issuer: 'payment-platform',
  audience: 'payment-platform-api',
};
const claims = {
  merchantId: '0192f0b1-0000-7000-8000-000000000001',
  sessionId: '0192f0b1-0000-7000-8000-0000000000aa',
};
const inOneHour = () => new Date(Date.now() + 3_600_000);

describe('session tokens', () => {
  it('round-trips the merchant and session IDs', () => {
    const token = signSessionToken(settings, claims, inOneHour());

    expect(verifySessionToken(settings, token)).toEqual({ claims });
  });

  it('sets exp from the session expiry, with HS256, issuer and audience', () => {
    const expiresAt = inOneHour();
    const decoded = jwt.decode(signSessionToken(settings, claims, expiresAt), { complete: true });

    expect(decoded?.header.alg).toBe('HS256');
    expect(decoded?.payload).toMatchObject({
      sub: claims.merchantId,
      sid: claims.sessionId,
      iss: 'payment-platform',
      aud: 'payment-platform-api',
      exp: Math.floor(expiresAt.getTime() / 1000),
    });
  });

  it('rejects an expired token as expired', () => {
    const token = signSessionToken(settings, claims, new Date(Date.now() - 1_000));

    expect(verifySessionToken(settings, token)).toEqual({ rejected: 'expired' });
  });

  const cases: [string, () => string][] = [
    [
      'an unsigned token (alg none)',
      () =>
        jwt.sign(
          {
            sid: claims.sessionId,
            sub: claims.merchantId,
            iss: settings.issuer,
            aud: settings.audience,
            exp: Math.floor(Date.now() / 1000) + 600,
          },
          '',
          { algorithm: 'none' },
        ),
    ],
    [
      'a different HMAC algorithm',
      () =>
        jwt.sign({ sid: claims.sessionId }, settings.secret, {
          algorithm: 'HS512',
          subject: claims.merchantId,
          issuer: settings.issuer,
          audience: settings.audience,
          expiresIn: 600,
        }),
    ],
    [
      'the wrong secret',
      () =>
        signSessionToken(
          { ...settings, secret: 'another-secret-0123456789abcdefgh' },
          claims,
          inOneHour(),
        ),
    ],
    [
      'the wrong issuer',
      () => signSessionToken({ ...settings, issuer: 'someone-else' }, claims, inOneHour()),
    ],
    [
      'the wrong audience',
      () => signSessionToken({ ...settings, audience: 'other-api' }, claims, inOneHour()),
    ],
    ['a tampered payload', () => tamper(signSessionToken(settings, claims, inOneHour()))],
    [
      'a session ID that is not a UUID',
      () => signSessionToken(settings, { ...claims, sessionId: "1' OR '1'='1" }, inOneHour()),
    ],
    [
      'a missing session ID',
      () =>
        jwt.sign({}, settings.secret, {
          algorithm: 'HS256',
          subject: claims.merchantId,
          issuer: settings.issuer,
          audience: settings.audience,
          expiresIn: 600,
        }),
    ],
    [
      'a token without exp',
      () =>
        jwt.sign({ sid: claims.sessionId }, settings.secret, {
          algorithm: 'HS256',
          subject: claims.merchantId,
          issuer: settings.issuer,
          audience: settings.audience,
        }),
    ],
    ['garbage', () => 'not.a.token'],
  ];

  it.each(cases)('rejects %s as invalid', (_label, makeToken) => {
    expect(verifySessionToken(settings, makeToken())).toEqual({ rejected: 'invalid' });
  });
});

/** Swaps in a payload for a different merchant while keeping the original signature. */
function tamper(token: string): string {
  const [header, , signature] = token.split('.');
  const forged = Buffer.from(
    JSON.stringify({
      sid: claims.sessionId,
      sub: '0192f0b1-0000-7000-8000-000000000002',
      iss: settings.issuer,
      aud: settings.audience,
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ).toString('base64url');
  return `${String(header)}.${forged}.${String(signature)}`;
}
