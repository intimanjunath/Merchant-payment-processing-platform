import { describe, expect, it } from 'vitest';

import { returnPath, returnToFor } from './return-to';

const page = { pathname: '/', search: '?q=ACME-100&status=failed' };

describe('returnToFor', () => {
  it('keeps nothing after an explicit sign-out', () => {
    expect(
      returnToFor({ status: 'signed_out', reason: 'signed_out', previousMerchantId: 'acme' }, page),
    ).toBeNull();
  });

  it('keeps the page and its owner after an expired session', () => {
    expect(
      returnToFor({ status: 'signed_out', reason: 'expired', previousMerchantId: 'acme' }, page),
    ).toEqual({ from: '/?q=ACME-100&status=failed', merchantId: 'acme' });
  });

  it('keeps the page with no owner on a first visit', () => {
    expect(
      returnToFor({ status: 'signed_out', reason: 'none', previousMerchantId: null }, page),
    ).toEqual({ from: '/?q=ACME-100&status=failed', merchantId: null });
  });
});

describe('returnPath', () => {
  it('goes back to the same merchant’s page', () => {
    expect(returnPath({ from: '/?q=x', merchantId: 'acme' }, 'acme')).toBe('/?q=x');
  });

  it('starts another merchant at the list', () => {
    expect(returnPath({ from: '/?q=x', merchantId: 'acme' }, 'bicycle')).toBe('/');
  });

  it('goes back to a page no one was signed in on', () => {
    expect(returnPath({ from: '/payments/abc', merchantId: null }, 'bicycle')).toBe(
      '/payments/abc',
    );
  });

  it('ignores missing or foreign destinations', () => {
    expect(returnPath(null, 'acme')).toBe('/');
    expect(returnPath({ merchantId: 'acme' }, 'acme')).toBe('/');
    expect(returnPath({ from: 'https://example.com/', merchantId: null }, 'acme')).toBe('/');
    expect(returnPath({ from: '//example.com/', merchantId: null }, 'acme')).toBe('/');
  });
});
