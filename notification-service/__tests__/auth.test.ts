/**
 * Tests for notification-service RBAC (auth.ts) — Issue #368
 *
 * Run with: npx jest auth.test.ts   (or: npx ts-node node_modules/.bin/jest)
 * These tests use only Node.js built-ins and the auth module; no HTTP server
 * is required.
 */

// We import the functions directly so no HTTP framework is needed.
import { resolveRole, hasRole, requireRole } from '../src/auth';
import { createHmac } from 'crypto';
import { signWebhookPayload, verifyWebhookSignature } from '../src/webhook-signing';

// ---------------------------------------------------------------------------
// resolveRole
// ---------------------------------------------------------------------------

describe('resolveRole', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, ADMIN_API_KEY: 'secret-admin', VIEWER_API_KEY: 'secret-viewer' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns "none" when header is missing', () => {
    const { resolveRole: r } = require('../src/auth');
    expect(r(undefined)).toBe('none');
  });

  it('returns "admin" for correct admin key', () => {
    const { resolveRole: r } = require('../src/auth');
    expect(r('Bearer secret-admin')).toBe('admin');
  });

  it('returns "viewer" for correct viewer key', () => {
    const { resolveRole: r } = require('../src/auth');
    expect(r('Bearer secret-viewer')).toBe('viewer');
  });

  it('returns "none" for unknown key', () => {
    const { resolveRole: r } = require('../src/auth');
    expect(r('Bearer wrong-key')).toBe('none');
  });

  it('accepts token without Bearer prefix', () => {
    const { resolveRole: r } = require('../src/auth');
    expect(r('secret-admin')).toBe('admin');
  });
});

// ---------------------------------------------------------------------------
// hasRole
// ---------------------------------------------------------------------------

describe('hasRole', () => {
  it('admin satisfies admin requirement', () => {
    expect(hasRole('admin', 'admin')).toBe(true);
  });

  it('admin satisfies viewer requirement', () => {
    expect(hasRole('admin', 'viewer')).toBe(true);
  });

  it('viewer does NOT satisfy admin requirement', () => {
    expect(hasRole('viewer', 'admin')).toBe(false);
  });

  it('viewer satisfies viewer requirement', () => {
    expect(hasRole('viewer', 'viewer')).toBe(true);
  });

  it('none does NOT satisfy viewer requirement', () => {
    expect(hasRole('none', 'viewer')).toBe(false);
  });

  it('none does NOT satisfy admin requirement', () => {
    expect(hasRole('none', 'admin')).toBe(false);
  });

  it('anything satisfies "none" requirement', () => {
    expect(hasRole('none',   'none')).toBe(true);
    expect(hasRole('viewer', 'none')).toBe(true);
    expect(hasRole('admin',  'none')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------

describe('requireRole', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, ADMIN_API_KEY: 'admin-key', VIEWER_API_KEY: 'viewer-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('does not throw when role is satisfied', () => {
    const { requireRole: rr } = require('../src/auth');
    expect(() => rr('Bearer admin-key', 'admin')).not.toThrow();
  });

  it('throws Unauthorized when no token provided', () => {
    const { requireRole: rr } = require('../src/auth');
    expect(() => rr(undefined, 'admin')).toThrow('Unauthorized');
  });

  it('throws Forbidden when viewer tries admin endpoint', () => {
    const { requireRole: rr } = require('../src/auth');
    expect(() => rr('Bearer viewer-key', 'admin')).toThrow('Forbidden');
  });

  it('throws Unauthorized for unknown token', () => {
    const { requireRole: rr } = require('../src/auth');
    expect(() => rr('Bearer garbage', 'viewer')).toThrow('Unauthorized');
  });
});

// ---------------------------------------------------------------------------
// webhook signing (Issue #124)
// ---------------------------------------------------------------------------

describe('signWebhookPayload', () => {
  const secret = 'test-webhook-secret';
  const body = JSON.stringify({ event: 'vote.created', id: 'abc123' });

  it('produces an HMAC-SHA256 signature matching an independent computation', () => {
    const { signature } = signWebhookPayload(body, secret);
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    expect(signature).toBe(expected);
  });

  it('includes a timestamp header value that is recent', () => {
    const before = Math.floor(Date.now() / 1000);
    const { timestamp } = signWebhookPayload(body, secret);
    const after = Math.floor(Date.now() / 1000);
    expect(typeof timestamp).toBe('number');
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('produces different signatures for different payloads', () => {
    const a = signWebhookPayload(body, secret).signature;
    const b = signWebhookPayload(body + 'x', secret).signature;
    expect(a).not.toBe(b);
  });

  it('produces different signatures for different secrets', () => {
    const a = signWebhookPayload(body, secret).signature;
    const b = signWebhookPayload(body, 'other-secret').signature;
    expect(a).not.toBe(b);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'test-webhook-secret';
  const body = JSON.stringify({ event: 'vote.created', id: 'abc123' });

  it('accepts a valid signature with a fresh timestamp', () => {
    const { signature, timestamp } = signWebhookPayload(body, secret);
    expect(verifyWebhookSignature(body, signature, timestamp, secret)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const { signature, timestamp } = signWebhookPayload(body, secret);
    expect(verifyWebhookSignature(body + 'tampered', signature, timestamp, secret)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const { signature, timestamp } = signWebhookPayload(body, 'wrong-secret');
    expect(verifyWebhookSignature(body, signature, timestamp, secret)).toBe(false);
  });

  it('rejects a stale timestamp (replay protection)', () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes old
    const signature = createHmac('sha256', secret)
      .update(`${staleTimestamp}.${body}`)
      .digest('hex');
    expect(verifyWebhookSignature(body, signature, staleTimestamp, secret)).toBe(false);
  });

  it('rejects a missing signature', () => {
    const { timestamp } = signWebhookPayload(body, secret);
    expect(verifyWebhookSignature(body, undefined as any, timestamp, secret)).toBe(false);
  });
});
