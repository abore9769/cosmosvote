import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WalletProvider, useWallet } from '../WalletContext';
import * as freighter from '@stellar/freighter-api';
import * as api from '../api';
import { sanitizeWalletMessage } from '../walletMessage';

// --------------------------------------------------------------------------
// Test consumer component
// --------------------------------------------------------------------------
function TestConsumer() {
  const { walletAddress, tokenBalance, connect, disconnect } = useWallet();
  return (
    <div>
      <div data-testid="addr">{walletAddress ?? 'null'}</div>
      <div data-testid="bal">{tokenBalance !== null ? String(tokenBalance) : 'null'}</div>
      <button onClick={() => connect('Freighter')}>connect</button>
      <button onClick={disconnect}>disconnect</button>
    </div>
  );
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
const MOCK_ADDRESS = 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012345678';
const MOCK_BALANCE = 5000n;

describe('WalletContext / useWallet', () => {
  beforeEach(() => {
    // Reset sessionStorage between tests
    sessionStorage.clear();
    // Reset Zustand store state by re-rendering a fresh tree
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('connects via Freighter and fetches token balance', async () => {
    // Mock the Freighter API calls
    vi.spyOn(freighter, 'isConnected').mockResolvedValue(true);
    vi.spyOn(freighter, 'requestAccess').mockResolvedValue({ error: undefined } as never);
    vi.spyOn(freighter, 'getAddress').mockResolvedValue({ address: MOCK_ADDRESS, error: undefined } as never);

    // Mock balance fetch
    vi.spyOn(api, 'fetchTokenBalance').mockResolvedValue(MOCK_BALANCE);

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>
    );

    // Initially disconnected
    expect(screen.getByTestId('addr').textContent).toBe('null');

    // Click connect
    await act(async () => {
      screen.getByText('connect').click();
    });

    expect(screen.getByTestId('addr').textContent).toBe(MOCK_ADDRESS);

    // Balance is fetched asynchronously after connecting
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('bal').textContent).toBe(String(MOCK_BALANCE));
  });

  it('shows error when Freighter is not installed', async () => {
    vi.spyOn(freighter, 'isConnected').mockResolvedValue(false);

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>
    );

    let connectError: Error | null = null;
    await act(async () => {
      try {
        await screen.getByText('connect').click();
      } catch (e) {
        connectError = e as Error;
      }
    });

    // Address should remain null — connection failed
    expect(screen.getByTestId('addr').textContent).toBe('null');
  });

  it('disconnects and clears state', async () => {
    // Pre-populate sessionStorage to simulate an already-connected state
    sessionStorage.setItem('cosmosvote-wallet-address', MOCK_ADDRESS);
    sessionStorage.setItem('cosmosvote-wallet-name', 'Freighter');

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>
    );

    // The store should pick up the address from sessionStorage
    expect(screen.getByTestId('addr').textContent).toBe(MOCK_ADDRESS);

    await act(async () => {
      screen.getByText('disconnect').click();
    });

    expect(screen.getByTestId('addr').textContent).toBe('null');
    expect(sessionStorage.getItem('cosmosvote-wallet-address')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Wallet-facing message sanitization (integration-style)
// --------------------------------------------------------------------------
describe('wallet message sanitization', () => {
  it('sanitizes a malicious proposal title before wallet display', () => {
    const maliciousTitle =
      'Transfer\u0000 all funds\u0007 to attacker \u202Eevil\u202C \uD83D\uDE00 100%';

    const raw = `Vote on proposal: ${maliciousTitle}`;
    const sanitized = sanitizeWalletMessage(raw);

    // No control characters survive
    expect(sanitized).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    // No non-ASCII characters survive
    expect(sanitized).not.toMatch(/[^\x20-\x7E]/);
    // No bidi override characters
    expect(sanitized).not.toContain('\u202E');
    expect(sanitized).not.toContain('\u202C');
    // No emoji
    expect(sanitized).not.toContain('\uD83D\uDE00');
    // Readable ASCII content is preserved
    expect(sanitized).toContain('Vote on proposal:');
    expect(sanitized).toContain('all funds');
    expect(sanitized).toContain('to attacker');
  });

  it('produces ASCII-only output for arbitrary Unicode input', () => {
    const inputs = [
      'café ☕ résumé',
      'emoji 😀🎉🚀 everywhere',
      'zero\u0000byte',
      'bell\u0007tab\u0009newline\u000A',
      'right-to-left \u202Eoverride',
    ];

    for (const input of inputs) {
      const out = sanitizeWalletMessage(input);
      expect(out).toMatch(/^[\x20-\x7E]*$/);
    }
  });

  it('sanitizes wallet message fields built from frontend state', () => {
    const proposalTitle = 'Fund \u0000the\u0007 treasury \uD83D\uDCB0';
    const memo = sanitizeWalletMessage(`Proposal: ${proposalTitle}`);

    expect(memo).toMatch(/^[\x20-\x7E]*$/);
    expect(memo).not.toContain('\u0000');
    expect(memo).not.toContain('\u0007');
    expect(memo).not.toContain('\uD83D\uDCB0');
  });
});
