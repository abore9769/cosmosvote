/**
 * ProposalDetail — modal dialog showing full proposal info and vote controls.
 *
 * Accessibility (WCAG 2.1 AA) — Issue #16:
 *   - aria-pressed on Yes/No/Abstain vote buttons reflects the user's current vote.
 *   - aria-disabled + title communicate the disabled state to screen readers.
 *   - Keyboard shortcuts Y / N / A submit the corresponding vote when the dialog
 *     has focus; shortcuts are documented via aria-keyshortcuts and a tooltip.
 *   - After a successful vote submission focus moves to a confirmation message
 *     element so screen readers immediately announce the outcome.
 *   - Focus trap and Escape-to-close behaviour are preserved.
 *   - Focus is returned to the triggering element on unmount.
 *
 * Issue #15: Real-time tally polling
 *   - usePolling re-fetches tally data every VITE_TALLY_POLL_INTERVAL ms (default 15 s)
 *     while the proposal is Active.
 *   - Polling stops when the component unmounts or the proposal is no longer Active.
 *   - A "Updated X seconds ago" timestamp is shown in the UI.
 */
import type { Proposal } from '../types';
import { fetchHasVoted, fetchVoteRecord, fetchProposal } from '../api';
import { useEffect, useRef, useState, useCallback } from 'react';
import { formatTokenAmount, maskAddress, sanitizeWalletMessage } from '../utils';
import { explorerAccountUrl } from '../config';
import { usePolling } from '../hooks/usePolling';

/** Polling interval in ms — configurable via VITE_TALLY_POLL_INTERVAL, default 15 s. */
const TALLY_POLL_INTERVAL = Number(import.meta.env.VITE_TALLY_POLL_INTERVAL ?? 15_000);

interface Props {
  proposal: Proposal;
  decimals: number;
  walletAddress: string | null;
  adminAddress?: string | null;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement>;
}

function formatDate(ts: bigint): string {
  return new Date(Number(ts) * 1000).toLocaleString();
}

type VoteChoice = 'Yes' | 'No' | 'Abstain';

const VOTE_CONFIG: Array<{
  vote: VoteChoice;
  label: string;
  shortcut: string;
  emoji: string;
  color: string;
  shortcutKey: string;
}> = [
  { vote: 'Yes',     label: 'Vote Yes',    shortcut: 'Y', emoji: '✅', color: '#16a34a', shortcutKey: 'y' },
  { vote: 'No',      label: 'Vote No',     shortcut: 'N', emoji: '❌', color: '#dc2626', shortcutKey: 'n' },
  { vote: 'Abstain', label: 'Abstain',     shortcut: 'A', emoji: '⬜', color: '#6b7280', shortcutKey: 'a' },
];

export function ProposalDetail({ proposal: p, decimals, walletAddress, adminAddress, onClose, triggerRef }: Props) {
  // Get signTransaction from the wallet store so votes can be signed by the real wallet.
  const { signTransaction } = useWallet();

  const [hasVoted, setHasVoted] = useState<boolean | null>(null);
  const [voteRecord, setVoteRecord] = useState<{ vote: string; weight: bigint } | null>(null);
  const [isVoting, setIsVoting] = useState(false);
  const [voteConfirmation, setVoteConfirmation] = useState<string | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [showFullProposer, setShowFullProposer] = useState(false);
  // For multi-choice proposals: the index the user has selected (null = none selected yet)
  const [selectedChoiceIndex, setSelectedChoiceIndex] = useState<number | null>(null);

  // Live tally — starts from the prop and updates via polling
  const [tally, setTally] = useState<{ yes: bigint; no: bigint; abstain: bigint }>({
    yes: p.votes_yes,
    no: p.votes_no,
    abstain: p.votes_abstain,
  });
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // Ref to the confirmation message — focus moves here after a successful vote
  const confirmationRef = useRef<HTMLDivElement>(null);

  const isProposalActive = p.state === 'Active';

  // Fetch latest tally from chain
  const fetchTally = useCallback(async () => {
    const fresh = await fetchProposal(Number(p.id));
    setTally({ yes: fresh.votes_yes, no: fresh.votes_no, abstain: fresh.votes_abstain });
    setLastUpdated(new Date());
  }, [p.id]);

  // Poll every TALLY_POLL_INTERVAL ms while Active
  usePolling(fetchTally, { interval: TALLY_POLL_INTERVAL, enabled: isProposalActive });

  // Update "X seconds ago" display every second
  useEffect(() => {
    if (!lastUpdated) return;
    const tick = () => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
    };
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [lastUpdated]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const votingOpen = isProposalActive && now >= p.start_time && now <= p.end_time;
  const canVote = !!walletAddress && votingOpen && hasVoted === false && !isVoting;

  // Fetch vote status when the dialog opens or walletAddress changes
  useEffect(() => {
    if (!walletAddress) return;
    Promise.all([
      fetchHasVoted(Number(p.id), walletAddress),
      fetchVoteRecord(Number(p.id), walletAddress),
    ]).then(([voted, record]) => {
      setHasVoted(voted);
      setVoteRecord(record);
    }).catch(() => {
      setHasVoted(false);
      setVoteRecord(null);
    });
  }, [p.id, walletAddress]);

  // Fetch voting power (own balance + delegated weight) — issue #20
  useEffect(() => {
    if (!walletAddress) return;
    setVotingPowerLoading(true);
    Promise.all([
      fetchTokenBalance(walletAddress),
      fetchDelegatedWeight(walletAddress, []),
    ])
      .then(([balance, delegated]) => {
        setOwnBalance(balance);
        setDelegatedWeight(delegated);
      })
      .catch(() => {
        setOwnBalance(BigInt(0));
        setDelegatedWeight(BigInt(0));
      })
      .finally(() => setVotingPowerLoading(false));
  }, [walletAddress]);

  // Focus the close button when the dialog opens
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  // Return focus to the element that opened the dialog on unmount
  useEffect(() => {
    return () => {
      triggerRef?.current?.focus();
    };
  }, [triggerRef]);

  // Move focus to the confirmation message after a successful vote
  useEffect(() => {
    if (voteConfirmation) {
      confirmationRef.current?.focus();
    }
  }, [voteConfirmation]);

  // Focus trap + Escape close + keyboard shortcuts Y / N / A
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    const handleKeyDown = (e: KeyboardEvent) => {
      // Keyboard shortcuts — only fire when the user is not typing in an input
      const tag = (e.target as HTMLElement).tagName;
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (!isTyping && canVote) {
        const match = VOTE_CONFIG.find(v => v.shortcutKey === e.key.toLowerCase());
        if (match) {
          e.preventDefault();
          void handleVote(match.vote);
          return;
        }
      }

      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key !== 'Tab') return;

      const elements = Array.from(dialog.querySelectorAll<HTMLElement>(focusable));
      if (elements.length === 0) return;

      const first = elements[0];
      const last = elements[elements.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, canVote]);  // re-bind when canVote changes so shortcuts stay accurate

  const total = tally.yes + tally.no + tally.abstain;
  const shortAddress = maskAddress(p.proposer);
  const hasChoices = Array.isArray(p.choices) && p.choices.length > 0;

  // Wallet-facing message fields are sanitized to ASCII-safe characters so that
  // frontend-supplied proposal content cannot inject misleading content into
  // wallet prompts or vote memos (see docs/wallet-message-sanitization.md).
  const safeTitle = sanitizeWalletMessage(p.title);
  const safeDescription = sanitizeWalletMessage(p.description);
  const safeChoices = hasChoices
    ? (p.choices ?? []).map(choice => sanitizeWalletMessage(choice))
    : [];

  // Submit a vote via the connected wallet. Signs and broadcasts a real Soroban transaction.
  async function handleVote(voteInput: VoteInput) {
    if (!canVote || !walletAddress) return;
    setIsVoting(true);
    setVoteError(null);
    setVoteConfirmation(null);
    try {
      await castVote(walletAddress, Number(p.id), voteInput, signTransaction);
      setHasVoted(true);
      const voteLabel =
        typeof voteInput === 'object' && 'choice' in voteInput
          ? (safeChoices[voteInput.choice] ?? `Choice ${voteInput.choice}`)
          : voteInput;
      setVoteRecord({ vote: voteLabel, weight: BigInt(0) });
      setVoteConfirmation(
        sanitizeWalletMessage(
          `Your vote "${voteLabel}" on proposal #${String(p.id)} has been submitted.`,
        ),
      );
    } catch (e) {
      setVoteError(`Vote failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setIsVoting(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
      onClick={onClose}
      aria-hidden="true"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="proposal-dialog-title"
        style={{ background: '#fff', borderRadius: 12, padding: '2rem', maxWidth: 600, width: '90%', maxHeight: '80vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Skeleton pulse animation */}
        <style>{`@keyframes pulse{0%,100%{background-position:100% 50%}50%{background-position:0% 50%}}`}</style>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <h2 id="proposal-dialog-title" style={{ margin: 0 }}>Proposal #{String(p.id)}</h2>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close proposal detail dialog"
            style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}
          >×</button>
        </div>

        <h3 style={{ margin: '0 0 0.5rem' }}>{safeTitle}</h3>
        <p style={{ color: '#555' }}>{safeDescription}</p>

        {/* Discussion link — shown only when discussion_url is a valid HTTPS URL */}
        {p.discussion_url && /^https:\/\/.+/.test(p.discussion_url) && (
          <p style={{ marginBottom: '1rem' }}>
            <a
              href={p.discussion_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                padding: '0.375rem 0.75rem',
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
                borderRadius: 6,
                color: '#1d4ed8',
                textDecoration: 'none',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              💬 Discussion
            </a>
          </p>
        )}

        {/* Details table */}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1rem' }}>
          <tbody>
            {[
              ['State', p.state],
              ['Proposer', (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                  <a
                    href={explorerAccountUrl(p.proposer)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={p.proposer}
                    style={{ color: '#2563eb', textDecoration: 'none' }}
                  >
                    {showFullProposer ? p.proposer : shortAddress}
                  </a>
                  <button
                    onClick={() => setShowFullProposer(s => !s)}
                    aria-label={showFullProposer ? 'Hide full proposer address' : 'Reveal full proposer address'}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: '0.75rem', padding: 0 }}
                  >
                    {showFullProposer ? '🙈' : '👁'}
                  </button>
                </span>
              )],
              ['Start', formatDate(p.start_time)],
              ['End', formatDate(p.end_time)],
              ['Quorum', formatTokenAmount(p.quorum, decimals)],
              ['Total Votes', formatTokenAmount(total, decimals)],
            ].map(([k, v]) => (
              <tr key={String(k)} style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: '0.4rem 0', color: '#888', width: '40%' }}>{k}</td>
                <td style={{ padding: '0.4rem 0', fontWeight: 500 }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Live tally — updated via polling while Active */}
        {isProposalActive && (
          <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'var(--bg-vote-cell, #f9fafb)', borderRadius: 8, border: '1px solid var(--border-color, #e5e7eb)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary, #1e293b)' }}>Live Tally</span>
              {secondsAgo !== null && (
                <span
                  aria-live="polite"
                  aria-atomic="true"
                  style={{ fontSize: '0.75rem', color: 'var(--text-muted, #888)' }}
                >
                  Updated {secondsAgo}s ago
                </span>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem', textAlign: 'center' }}>
              <div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: '#16a34a' }}>{formatTokenAmount(tally.yes, decimals)}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #888)' }}>Yes</div>
              </div>
              <div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: '#dc2626' }}>{formatTokenAmount(tally.no, decimals)}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #888)' }}>No</div>
              </div>
              <div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: '#6b7280' }}>{formatTokenAmount(tally.abstain, decimals)}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #888)' }}>Abstain</div>
              </div>
            </div>
          </div>
        )}

        {/* ── Vote confirmation message (receives focus after vote) ── */}
        {voteConfirmation && (
          <div
            ref={confirmationRef}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            tabIndex={-1}
            style={{
              padding: '0.75rem', background: '#dcfce7', borderRadius: 8,
              fontSize: '0.875rem', marginBottom: '1rem', color: '#166534',
              outline: 'none',
            }}
          >
            ✅ {voteConfirmation}
          </div>
        )}

        {/* ── Vote error message ── */}
        {voteError && (
          <div
            role="alert"
            aria-live="assertive"
            style={{
              padding: '0.75rem', background: '#fee2e2', borderRadius: 8,
              fontSize: '0.875rem', marginBottom: '1rem', color: '#991b1b',
            }}
          >
            ⚠️ {voteError}
          </div>
        )}

        {/* ── Vote section ── */}
        {walletAddress && (
          <div style={{ padding: '0.75rem', background: '#f0f9ff', borderRadius: 8, fontSize: '0.875rem', marginBottom: '1rem' }}>
            {/* Voting power panel — issue #20 */}
            {hasVoted === false && isProposalActive && (
              <div
                style={{
                  background: '#fff',
                  border: '1px solid #bfdbfe',
                  borderRadius: 6,
                  padding: '0.6rem 0.85rem',
                  marginBottom: '0.75rem',
                  fontSize: '0.8rem',
                }}
              >
                <div style={{ fontWeight: 600, color: '#1e40af', marginBottom: '0.35rem' }}>
                  🗳️ Your Voting Power
                </div>
                {votingPowerLoading ? (
                  <div
                    aria-busy="true"
                    aria-label="Loading voting power"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.3rem',
                    }}
                  >
                    {/* Skeleton lines */}
                    {[100, 80].map(w => (
                      <div
                        key={w}
                        style={{
                          height: 12,
                          width: `${w}%`,
                          background: 'linear-gradient(90deg,#e0e7ff 25%,#c7d2fe 50%,#e0e7ff 75%)',
                          backgroundSize: '200% 100%',
                          borderRadius: 4,
                          animation: 'pulse 1.4s ease-in-out infinite',
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                      <span>
                        <span style={{ color: '#64748b' }}>Own balance: </span>
                        <strong>{ownBalance !== null ? formatTokenAmount(ownBalance, decimals) : '—'}</strong>
                      </span>
                      <span>
                        <span style={{ color: '#64748b' }}>Delegated: </span>
                        <strong>{delegatedWeight !== null ? formatTokenAmount(delegatedWeight, decimals) : '—'}</strong>
                      </span>
                    </div>
                    {ownBalance !== null && delegatedWeight !== null && ownBalance + delegatedWeight === BigInt(0) && (
                      <div
                        role="alert"
                        style={{
                          marginTop: '0.5rem',
                          padding: '0.4rem 0.6rem',
                          background: '#fef9c3',
                          border: '1px solid #fde047',
                          borderRadius: 5,
                          color: '#78350f',
                          fontWeight: 500,
                        }}
                      >
                        ⚠️ You have 0 voting power. Acquire CVT tokens or receive a delegation to vote.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {hasVoted === null && <span>Checking vote status…</span>}

            {hasVoted && voteRecord && !voteConfirmation && (
              <span>
                You voted <strong>{voteRecord.vote}</strong> with weight{' '}
                {formatTokenAmount(voteRecord.weight, decimals)}
              </span>
            )}

            {hasVoted === false && isProposalActive && (
              <>
                {hasChoices ? (
                  /* ── Multi-choice vote UI ── */
                  <fieldset
                    style={{ border: 'none', padding: 0, margin: 0 }}
                    aria-labelledby="choice-legend"
                    disabled={!canVote || isVoting}
                  >
                    <legend
                      id="choice-legend"
                      style={{ margin: '0 0 0.5rem', color: '#374151', fontWeight: 500, fontSize: '0.875rem' }}
                    >
                      Select your choice:
                    </legend>
                    <ul
                      role="radiogroup"
                      aria-labelledby="choice-legend"
                      style={{ listStyle: 'none', padding: 0, margin: '0 0 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
                    >
                      {safeChoices.map((choiceLabel, idx) => {
                        const inputId = `choice-${String(p.id)}-${idx}`;
                        const isSelected = selectedChoiceIndex === idx;
                        return (
                          <li key={idx}>
                            <label
                              htmlFor={inputId}
                              style={{
                                display: 'flex', alignItems: 'center', gap: '0.5rem',
                                padding: '0.6rem 0.75rem',
                                border: `2px solid ${isSelected ? '#2563eb' : '#e5e7eb'}`,
                                borderRadius: 6,
                                cursor: canVote && !isVoting ? 'pointer' : 'not-allowed',
                                background: isSelected ? '#eff6ff' : '#fff',
                                fontSize: '0.875rem',
                              }}
                            >
                              <input
                                id={inputId}
                                type="radio"
                                name={`proposal-${String(p.id)}-choice`}
                                value={idx}
                                checked={isSelected}
                                disabled={!canVote || isVoting}
                                onChange={() => setSelectedChoiceIndex(idx)}
                                aria-label={choiceLabel}
                                style={{ accentColor: '#2563eb' }}
                              />
                              {choiceLabel}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    <button
                      onClick={() => {
                        if (selectedChoiceIndex !== null) {
                          void handleVote({ choice: selectedChoiceIndex });
                        }
                      }}
                      disabled={!canVote || isVoting || selectedChoiceIndex === null}
                      aria-disabled={!canVote || isVoting || selectedChoiceIndex === null}
                      style={{
                        padding: '0.6rem 1.25rem',
                        background: !canVote || isVoting || selectedChoiceIndex === null ? '#e5e7eb' : '#2563eb',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        cursor: !canVote || isVoting || selectedChoiceIndex === null ? 'not-allowed' : 'pointer',
                        fontWeight: 600,
                        fontSize: '0.875rem',
                      }}
                    >
                      {isVoting ? 'Submitting…' : 'Submit Vote'}
                    </button>
                  </fieldset>
                ) : (
                  /* ── Standard Yes / No / Abstain vote UI ── */
                  <>
                    {/* Keyboard shortcut hint */}
                    <p
                      id="vote-shortcut-hint"
                      style={{ margin: '0 0 0.5rem', color: '#374151' }}
                    >
                      Cast your vote{' '}
                      <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                        (keyboard shortcuts: <kbd>Y</kbd> Yes · <kbd>N</kbd> No · <kbd>A</kbd> Abstain)
                      </span>
                    </p>

                    {/* Vote buttons */}
                    <div
                      role="group"
                      aria-labelledby="vote-shortcut-hint"
                      style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}
                    >
                      {VOTE_CONFIG.map(({ vote, label, shortcut, emoji, color, shortcutKey }) => {
                        const isCurrentVote = voteRecord?.vote === vote;
                        const isDisabled = !canVote;

                        return (
                          <button
                            key={vote}
                            onClick={() => void handleVote(vote)}
                            // aria-pressed reflects whether this choice is the user's current vote
                            aria-pressed={isCurrentVote}
                            // aria-disabled communicates the disabled state to screen readers
                            // without removing the button from the tab order
                            aria-disabled={isDisabled || isVoting}
                            // Keyboard shortcut documented for AT users
                            aria-keyshortcuts={shortcutKey}
                        // Tooltip explains shortcut and disabled reason
                        title={
                          isVoting
                            ? 'Submitting vote…'
                            : !walletAddress
                              ? 'Connect your wallet to vote'
                              : isDisabled
                                ? 'Voting is not available for this proposal'
                                : `${label} (shortcut: ${shortcut})`
                        }
                        disabled={isDisabled || isVoting}
                        style={{
                          padding: '0.75rem',
                          background: isDisabled || isVoting ? '#e5e7eb' : color,
                          color: '#fff',
                          border: isCurrentVote ? '3px solid #1e40af' : 'none',
                          borderRadius: 8,
                          cursor: isDisabled || isVoting ? 'not-allowed' : 'pointer',
                          fontWeight: 500,
                          opacity: isDisabled || isVoting ? 0.6 : 1,
                          position: 'relative',
                        }}
                      >
                        {isVoting
                          ? 'Submitting…'
                          : <>{emoji} {label} <kbd style={{ fontSize: '0.65rem', opacity: 0.75, marginLeft: '0.25rem' }}>{shortcut}</kbd></>
                        }
                      </button>
                    );
                  })}
                </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Connect wallet prompt */}
        {!walletAddress && (
          <div style={{ padding: '0.75rem', background: '#fef3c7', borderRadius: 8, fontSize: '0.875rem', color: '#92400e' }}>
            ℹ️ Connect your wallet to vote on this proposal
          </div>
        )}

        {/* ── Vote Simulation Preview (Active proposals only) ── */}
        {/* Rendered for Active proposals regardless of wallet connection so
            users can see an estimate before connecting. When walletAddress is
            present the preview reflects the user's pending vote in real time. */}
        {isProposalActive && walletAddress && hasVoted === false && (
          <VoteSimulationPreview
            proposalId={Number(p.id)}
            walletAddress={walletAddress}
          />
        )}

        {/* Already voted confirmation (when loaded from chain, not just submitted) */}
        {walletAddress && hasVoted && !voteConfirmation && voteRecord && (
          <div
            role="status"
            style={{ marginTop: '1rem', padding: '0.75rem', background: '#e0e7ff', borderRadius: 8, fontSize: '0.875rem', color: '#3730a3' }}
          >
            ✓ You have already voted <strong>{voteRecord.vote}</strong> on this proposal
          </div>
        )}

        {/* Proposal not active */}
        {walletAddress && !isProposalActive && (
          <div style={{ marginTop: '1rem', padding: '0.75rem', background: '#f3e8ff', borderRadius: 8, fontSize: '0.875rem', color: '#6b21a8' }}>
            ℹ️ This proposal is not active and cannot receive new votes
          </div>
        )}

        {/* Voting not yet open or closed */}
        {walletAddress && isProposalActive && !votingOpen && (
          <div style={{ marginTop: '1rem', padding: '0.75rem', background: '#f3e8ff', borderRadius: 8, fontSize: '0.875rem', color: '#6b21a8' }}>
            ℹ️ Voting is not open yet or has ended for this proposal
          </div>
        )}
      </div>
    </div>
  );
}
