import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @stellar/stellar-sdk so we can control SorobanRpc.Server behaviour.
// ---------------------------------------------------------------------------

const simulateTransaction = vi.fn();
const getAccount = vi.fn();

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>(
    '@stellar/stellar-sdk'
  );

  class MockServer {
    simulateTransaction = simulateTransaction;
    getAccount = getAccount;
  }

  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: MockServer,
      assembleTransaction: vi.fn(() => ({ build: () => ({ toXDR: () => 'assembled-xdr' }) })),
      Api: {
        ...actual.SorobanRpc.Api,
        isSimulationError: (r: { error?: string }) => Boolean(r && r.error),
      },
    },
  };
});

vi.mock('../config', () => ({
  config: {
    rpcUrl: 'https://rpc.example.com',
    networkPassphrase: 'Test SDF Network ; September 2015',
    governanceContractId: 'C_GOV',
    tokenContractId: 'C_TOKEN',
  },
}));

import { xdr, nativeToScVal } from '@stellar/stellar-sdk';
import {
  checkRpcReachability,
  fetchProposalCount,
  fetchProposal,
  fetchAllProposals,
  fetchHasVoted,
  fetchVoteRecord,
  fetchTokenBalance,
  fetchTokenDecimals,
  fetchDelegation,
  fetchDelegatedWeight,
  castVote,
  SimulationError,
} from '../api';

const ADDRESS = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

function success(retval: xdr.ScVal) {
  return { result: { retval } };
}

beforeEach(() => {
  simulateTransaction.mockReset();
  getAccount.mockReset();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// checkRpcReachability
// ---------------------------------------------------------------------------

describe('checkRpcReachability', () => {
  it('resolves when RPC responds ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: 'healthy' }) })
    );
    await expect(checkRpcReachability()).resolves.toBeUndefined();
  });

  it('throws on non-ok HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    );
    await expect(checkRpcReachability()).rejects.toThrow(/HTTP 500/);
  });

  it('throws when body contains an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ error: { code: 1 } }) })
    );
    await expect(checkRpcReachability()).rejects.toThrow(/RPC error/);
  });
});

// ---------------------------------------------------------------------------
// fetchProposalCount
// ---------------------------------------------------------------------------

describe('fetchProposalCount', () => {
  it('returns the numeric count', async () => {
    simulateTransaction.mockResolvedValue(success(nativeToScVal(7, { type: 'u32' })));
    await expect(fetchProposalCount()).resolves.toBe(7);
  });

  it('throws when simulation has no result', async () => {
    simulateTransaction.mockResolvedValue({});
    await expect(fetchProposalCount()).rejects.toThrow(/Simulation failed/);
  });
});

// ---------------------------------------------------------------------------
// fetchProposal
// ---------------------------------------------------------------------------

describe('fetchProposal', () => {
  it('returns the proposal object', async () => {
    const proposal = { id: 1, title: 'Test' };
    simulateTransaction.mockResolvedValue(
      success(nativeToScVal(proposal, { type: 'map' }))
    );
    await expect(fetchProposal(1)).resolves.toEqual(proposal);
  });

  it('throws when simulation fails', async () => {
    simulateTransaction.mockResolvedValue({});
    await expect(fetchProposal(1)).rejects.toThrow(/Simulation failed/);
  });
});

// ---------------------------------------------------------------------------
// fetchAllProposals
// ---------------------------------------------------------------------------

describe('fetchAllProposals', () => {
  it('returns all proposals', async () => {
    simulateTransaction
      .mockResolvedValueOnce(success(nativeToScVal(2, { type: 'u32' })))
      .mockResolvedValueOnce(success(nativeToScVal({ id: 0 }, { type: 'map' })))
      .mockResolvedValueOnce(success(nativeToScVal({ id: 1 }, { type: 'map' })));
    const result = await fetchAllProposals();
    expect(result).toHaveLength(2);
  });

  it('skips proposals that fail to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    simulateTransaction
      .mockResolvedValueOnce(success(nativeToScVal(2, { type: 'u32' })))
      .mockResolvedValueOnce(success(nativeToScVal({ id: 0 }, { type: 'map' })))
      .mockResolvedValueOnce({});
    const result = await fetchAllProposals();
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// fetchHasVoted
// ---------------------------------------------------------------------------

describe('fetchHasVoted', () => {
  it('returns true when voter has voted', async () => {
    simulateTransaction.mockResolvedValue(success(nativeToScVal(true, { type: 'bool' })));
    await expect(fetchHasVoted(1, ADDRESS)).resolves.toBe(true);
  });

  it('throws when simulation fails', async () => {
    simulateTransaction.mockResolvedValue({});
    await expect(fetchHasVoted(1, ADDRESS)).rejects.toThrow(/Simulation failed/);
  });
});

// ---------------------------------------------------------------------------
// fetchVoteRecord
// ---------------------------------------------------------------------------

describe('fetchVoteRecord', () => {
  it('returns the vote record', async () => {
    const record = { vote: 'Yes' };
    simulateTransaction.mockResolvedValue(
      success(nativeToScVal(record, { type: 'map' }))
    );
    await expect(fetchVoteRecord(1, ADDRESS)).resolves.toEqual(record);
  });

  it('returns null on failure', async () => {
    simulateTransaction.mockResolvedValue({});
    await expect(fetchVoteRecord(1, ADDRESS)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchTokenBalance
// ---------------------------------------------------------------------------

describe('fetchTokenBalance', () => {
  it('returns the balance as bigint', async () => {
    simulateTransaction.mockResolvedValue(success(nativeToScVal(1000, { type: 'i128' })));
    await expect(fetchTokenBalance(ADDRESS)).resolves.toBe(1000n);
  });

  it('throws when simulation fails', async () => {
    simulateTransaction.mockResolvedValue({});
    await expect(fetchTokenBalance(ADDRESS)).rejects.toThrow(/Simulation failed/);
  });
});

// ---------------------------------------------------------------------------
// fetchTokenDecimals
// ---------------------------------------------------------------------------

describe('fetchTokenDecimals', () => {
  it('returns the decimals', async () => {
    simulateTransaction.mockResolvedValue(success(nativeToScVal(7, { type: 'u32' })));
    await expect(fetchTokenDecimals()).resolves.toBe(7);
  });

  it('throws when simulation fails', async () => {
    simulateTransaction.mockResolvedValue({});
    await expect(fetchTokenDecimals()).rejects.toThrow(/Simulation failed/);
  });
});

// ---------------------------------------------------------------------------
// fetchDelegation
// ---------------------------------------------------------------------------

describe('fetchDelegation', () => {
  it('returns the delegate address', async () => {
    simulateTransaction.mockResolvedValue(
      success(nativeToScVal(ADDRESS, { type: 'address' }))
    );
    await expect(fetchDelegation(ADDRESS)).resolves.toBe(ADDRESS);
  });

  it('returns null on failure', async () => {
    simulateTransaction.mockResolvedValue({});
    await expect(fetchDelegation(ADDRESS)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchDelegatedWeight
// ---------------------------------------------------------------------------

describe('fetchDelegatedWeight', () => {
  it('returns the delegated weight as bigint', async () => {
    simulateTransaction.mockResolvedValue(success(nativeToScVal(500, { type: 'i128' })));
    await expect(fetchDelegatedWeight(ADDRESS, [ADDRESS])).resolves.toBe(500n);
  });

  it('throws when simulation fails', async () => {
    simulateTransaction.mockResolvedValue({});
    await expect(fetchDelegatedWeight(ADDRESS, [])).rejects.toThrow(/Simulation failed/);
  });
});

// ---------------------------------------------------------------------------
// castVote
// ---------------------------------------------------------------------------

describe('castVote', () => {
  const signTx = vi.fn().mockResolvedValue('signed-xdr');

  it('builds, simulates, signs and submits a vote', async () => {
    getAccount.mockResolvedValue({ sequenceNumber: () => '1' });
    simulateTransaction.mockResolvedValue(success(nativeToScVal(1, { type: 'u32' })));
    const result = await castVote(ADDRESS, 1, 'Yes', signTx);
    expect(signTx).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('throws SimulationError when simulation reports an error', async () => {
    getAccount.mockResolvedValue({ sequenceNumber: () => '1' });
    simulateTransaction.mockResolvedValue({ error: 'boom' });
    await expect(castVote(ADDRESS, 1, 'No', signTx)).rejects.toBeInstanceOf(
      SimulationError
    );
  });
});
