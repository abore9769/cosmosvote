import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { promises as dnsPromises } from 'dns';

// Mock dns.promises.lookup so tests do not hit the network.
jest.mock('dns', () => {
  const actual = jest.requireActual('dns') as typeof import('dns');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lookup: jest.fn(),
    },
  };
});

import {
  validateWebhookUrl,
  isBlockedIp,
  assertSafeWebhookUrl,
} from '../src/urlGuard';

const mockedLookup = dnsPromises.lookup as unknown as jest.Mock;

function mockLookupTo(address: string, family: 4 | 6 = 4): void {
  mockedLookup.mockResolvedValue([{ address, family }]);
}

describe('urlGuard - SSRF prevention', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('isBlockedIp', () => {
    it('blocks IPv4 loopback (127.x)', () => {
      expect(isBlockedIp('127.0.0.1')).toBe(true);
      expect(isBlockedIp('127.255.255.254')).toBe(true);
    });

    it('blocks IPv4 link-local (169.254.x)', () => {
      expect(isBlockedIp('169.254.169.254')).toBe(true);
      expect(isBlockedIp('169.254.0.1')).toBe(true);
    });

    it('blocks IPv4 private ranges (10.x, 172.16-31.x, 192.168.x)', () => {
      expect(isBlockedIp('10.0.0.1')).toBe(true);
      expect(isBlockedIp('10.255.255.255')).toBe(true);
      expect(isBlockedIp('172.16.0.1')).toBe(true);
      expect(isBlockedIp('172.31.255.255')).toBe(true);
      expect(isBlockedIp('192.168.1.1')).toBe(true);
      expect(isBlockedIp('192.168.0.0')).toBe(true);
    });

    it('blocks IPv6 loopback (::1)', () => {
      expect(isBlockedIp('::1')).toBe(true);
    });

    it('blocks IPv6 unique local addresses (fc00::/7)', () => {
      expect(isBlockedIp('fc00::1')).toBe(true);
      expect(isBlockedIp('fd00::1')).toBe(true);
    });

    it('blocks IPv6 link-local (fe80::/10)', () => {
      expect(isBlockedIp('fe80::1')).toBe(true);
    });

    it('allows public IPv4 addresses', () => {
      expect(isBlockedIp('8.8.8.8')).toBe(false);
      expect(isBlockedIp('1.1.1.1')).toBe(false);
    });

    it('allows public IPv6 addresses', () => {
      expect(isBlockedIp('2001:4860:4860::8888')).toBe(false);
    });
  });

  describe('validateWebhookUrl - blocked hosts', () => {
    it('blocks http://localhost', async () => {
      mockLookupTo('127.0.0.1');
      const result = await validateWebhookUrl('http://localhost/hook');
      expect(result.ok).toBe(false);
    });

    it('blocks http://127.0.0.1', async () => {
      mockLookupTo('127.0.0.1');
      const result = await validateWebhookUrl('http://127.0.0.1/hook');
      expect(result.ok).toBe(false);
    });

    it('blocks http://169.254.169.254/ (cloud metadata)', async () => {
      mockLookupTo('169.254.169.254');
      const result = await validateWebhookUrl('http://169.254.169.254/');
      expect(result.ok).toBe(false);
    });

    it('blocks http://10.0.0.1', async () => {
      mockLookupTo('10.0.0.1');
      const result = await validateWebhookUrl('http://10.0.0.1/hook');
      expect(result.ok).toBe(false);
    });

    it('blocks http://192.168.1.1', async () => {
      mockLookupTo('192.168.1.1');
      const result = await validateWebhookUrl('http://192.168.1.1/hook');
      expect(result.ok).toBe(false);
    });

    it('blocks http://172.16.0.1', async () => {
      mockLookupTo('172.16.0.1');
      const result = await validateWebhookUrl('http://172.16.0.1/hook');
      expect(result.ok).toBe(false);
    });

    it('blocks http://[::1]/', async () => {
      mockLookupTo('::1', 6);
      const result = await validateWebhookUrl('http://[::1]/hook');
      expect(result.ok).toBe(false);
    });

    it('blocks http://[fc00::1]/', async () => {
      mockLookupTo('fc00::1', 6);
      const result = await validateWebhookUrl('http://[fc00::1]/hook');
      expect(result.ok).toBe(false);
    });

    it('blocks hostnames that resolve to private IPs', async () => {
      mockLookupTo('10.1.2.3');
      const result = await validateWebhookUrl('https://internal.example.com/hook');
      expect(result.ok).toBe(false);
    });
  });

  describe('validateWebhookUrl - protocol enforcement', () => {
    it('rejects non-HTTPS URLs (http)', async () => {
      mockLookupTo('8.8.8.8');
      const result = await validateWebhookUrl('http://example.com/hook');
      expect(result.ok).toBe(false);
    });

    it('rejects ftp protocol', async () => {
      mockLookupTo('8.8.8.8');
      const result = await validateWebhookUrl('ftp://example.com/hook');
      expect(result.ok).toBe(false);
    });

    it('rejects file protocol', async () => {
      const result = await validateWebhookUrl('file:///etc/passwd');
      expect(result.ok).toBe(false);
    });
  });

  describe('validateWebhookUrl - allowed URLs', () => {
    it('allows a normal public HTTPS URL', async () => {
      mockLookupTo('93.184.216.34');
      const result = await validateWebhookUrl('https://example.com/webhook');
      expect(result.ok).toBe(true);
    });

    it('allows a public HTTPS URL with a port', async () => {
      mockLookupTo('8.8.8.8');
      const result = await validateWebhookUrl('https://api.example.com:8443/hook');
      expect(result.ok).toBe(true);
    });
  });

  describe('assertSafeWebhookUrl', () => {
    it('throws for blocked URLs', async () => {
      mockLookupTo('127.0.0.1');
      await expect(assertSafeWebhookUrl('https://localhost/hook')).rejects.toThrow();
    });

    it('resolves for safe URLs', async () => {
      mockLookupTo('93.184.216.34');
      await expect(assertSafeWebhookUrl('https://example.com/hook')).resolves.toBeUndefined();
    });
  });
});