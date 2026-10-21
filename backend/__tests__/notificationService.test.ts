/**
 * Tests for NotificationService — event polling, webhook delivery, and error handling.
 * Mocks axios to simulate Horizon/Soroban RPC responses without network calls.
 */

import axios from 'axios';
import { NotificationService, WebhookPayload } from '../src/notificationService';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Silence console output during tests
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const BASE_CONFIG = {
  rpcUrl: 'http://localhost:8000',
  contractId: 'CONTRACT_ABC',
  webhookUrl: 'https://example.com/hook',
};

const makeEvent = (event = 'vote_cast'): WebhookPayload => ({
  contractId: 'CONTRACT_ABC',
  event,
  ledger: 100,
  data: { voter: 'GADDR' },
});

// ---------------------------------------------------------------------------
// Event polling
// ---------------------------------------------------------------------------

describe('pollEvents', () => {
  it('returns events from RPC response', async () => {
    const events = [makeEvent('vote_cast'), makeEvent('proposal_created')];
    mockedAxios.post.mockResolvedValueOnce({ data: { events } });

    const svc = new NotificationService(BASE_CONFIG);
    const result = await svc.pollEvents();

    expect(result).toHaveLength(2);
    expect(result[0].event).toBe('vote_cast');
  });

  it('returns empty array when RPC returns no events', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { events: [] } });

    const svc = new NotificationService(BASE_CONFIG);
    const result = await svc.pollEvents();

    expect(result).toEqual([]);
  });

  it('returns empty array and increments failure count on RPC error', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('connection refused'));

    const svc = new NotificationService(BASE_CONFIG);
    const result = await svc.pollEvents();

    expect(result).toEqual([]);
  });

  it('handles missing events field gracefully', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    const svc = new NotificationService(BASE_CONFIG);
    const result = await svc.pollEvents();

    expect(result).toEqual([]);
  });
});

describe('checkReadiness', () => {
  it('returns true when the RPC reports healthy', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { result: { status: 'healthy' } } });

    const svc = new NotificationService(BASE_CONFIG);

    await expect(svc.checkReadiness()).resolves.toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${BASE_CONFIG.rpcUrl}/`,
      { jsonrpc: '2.0', id: 1, method: 'getHealth' },
      { timeout: 5_000 }
    );
  });

  it('returns false when the RPC is unreachable or unhealthy', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ data: { result: { status: 'starting' } } })
      .mockRejectedValueOnce(new Error('connection refused'));

    const svc = new NotificationService(BASE_CONFIG);

    await expect(svc.checkReadiness()).resolves.toBe(false);
    await expect(svc.checkReadiness()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

describe('deliverWebhook', () => {
  it('posts event payload to webhook URL', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200 });

    const svc = new NotificationService(BASE_CONFIG);
    await svc.deliverWebhook(makeEvent());

    expect(mockedAxios.post).toHaveBeenCalledWith(
      BASE_CONFIG.webhookUrl,
      expect.objectContaining({ event: 'vote_cast' }),
      expect.objectContaining({ timeout: 5_000 })
    );
  });

  it('does not throw when webhook delivery fails', async () => {
    mockedAxios.post.mockRejectedValue({ response: { status: 503 }, message: 'webhook unavailable' });
    jest.useFakeTimers();

    const svc = new NotificationService(BASE_CONFIG);
    const delivery = svc.deliverWebhook(makeEvent());

    await jest.advanceTimersByTimeAsync(7_000);
    await expect(delivery).resolves.toBeUndefined();
    expect(mockedAxios.post).toHaveBeenCalledTimes(4);

    const failureLog = (console.error as jest.Mock).mock.calls
      .map(([message]) => message)
      .find((message) => typeof message === 'string' && message.includes('permanently failed'));
    expect(failureLog).toContain('HTTP 503');
    jest.useRealTimers();
  });

  it('retries with exponential backoff and stops after success', async () => {
    mockedAxios.post
      .mockRejectedValueOnce({ response: { status: 500 }, message: 'temporary failure' })
      .mockRejectedValueOnce({ response: { status: 500 }, message: 'temporary failure' })
      .mockRejectedValueOnce({ response: { status: 500 }, message: 'temporary failure' })
      .mockResolvedValueOnce({ status: 200 });
    jest.useFakeTimers();

    const svc = new NotificationService(BASE_CONFIG);
    const delivery = svc.deliverWebhook(makeEvent());

    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(3_999);
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);

    await expect(delivery).resolves.toBeUndefined();
    expect(mockedAxios.post).toHaveBeenCalledTimes(4);
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// SSRF prevention — blocked webhook URLs
// ---------------------------------------------------------------------------

describe('SSRF prevention', () => {
  const blockedUrls = [
    'https://localhost/hook',
    'https://127.0.0.1/hook',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.1/hook',
    'https://10.255.255.255/hook',
    'https://172.16.0.1/hook',
    'https://172.31.255.255/hook',
    'https://192.168.0.1/hook',
    'https://192.168.1.100/hook',
    'https://[::1]/hook',
    'https://[fc00::1]/hook',
    'https://[fe80::1]/hook',
  ];

  it.each(blockedUrls)('blocks delivery to private/loopback URL %s', async (webhookUrl) => {
    const svc = new NotificationService({ ...BASE_CONFIG, webhookUrl });

    await expect(svc.deliverWebhook(makeEvent())).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS webhook URLs', async () => {
    const svc = new NotificationService({ ...BASE_CONFIG, webhookUrl: 'http://example.com/hook' });

    await expect(svc.deliverWebhook(makeEvent())).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('still delivers to a public HTTPS URL', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200 });

    const svc = new NotificationService(BASE_CONFIG);
    await svc.deliverWebhook(makeEvent());

    expect(mockedAxios.post).toHaveBeenCalledWith(
      BASE_CONFIG.webhookUrl,
      expect.objectContaining({ event: 'vote_cast' }),
      expect.objectContaining({ timeout: 5_000 })
    );
  });

  it('does not deliver events to a blocked webhook URL during runOnce', async () => {
    const events = [makeEvent('vote_cast')];
    mockedAxios.post.mockResolvedValueOnce({ data: { events } });

    const svc = new NotificationService({ ...BASE_CONFIG, webhookUrl: 'https://169.254.169.254/' });
    await svc.runOnce();

    // Only the poll call should have happened; webhook delivery is blocked.
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runOnce — integration of poll + deliver
// ---------------------------------------------------------------------------

describe('runOnce', () => {
  it('polls events and delivers each to webhook', async () => {
    const events = [makeEvent('vote_cast'), makeEvent('proposal_finalized')];
    // First call = pollEvents, next two = deliverWebhook
    mockedAxios.post
      .mockResolvedValueOnce({ data: { events } })
      .mockResolvedValue({ status: 200 });

    const svc = new NotificationService(BASE_CONFIG);
    await svc.runOnce();

    // poll + 2 webhook deliveries
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
  });

  it('delivers nothing when poll returns no events', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { events: [] } });

    const svc = new NotificationService(BASE_CONFIG);
    await svc.runOnce();

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Error handling — consecutive poll failures
// ---------------------------------------------------------------------------

describe('consecutive poll failures', () => {
  it('logs alert after 3 consecutive failures', async () => {
    mockedAxios.post.mockRejectedValue(new Error('rpc down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const svc = new NotificationService(BASE_CONFIG);
    await svc.pollEvents();
    await svc.pollEvents();
    await svc.pollEvents(); // third — should trigger alert log

    const alertCall = errorSpy.mock.calls.find(([msg]) =>
      typeof msg === 'string' && msg.includes('consecutive poll failures')
    );
    expect(alertCall).toBeDefined();
  });

  it('resets failure count after successful poll', async () => {
    mockedAxios.post
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValueOnce({ data: { events: [] } });

    const svc = new NotificationService(BASE_CONFIG);
    await svc.pollEvents(); // fail
    const result = await svc.pollEvents(); // success — should reset

    expect(result).toEqual([]);
  });
});
