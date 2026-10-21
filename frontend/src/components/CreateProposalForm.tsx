import { useState, useEffect, useRef, useCallback } from 'react';
import {
  SorobanRpc,
  TransactionBuilder,
  Account,
  Operation,
  nativeToScVal,
  Networks,
  Keypair,
} from '@stellar/stellar-sdk';
import { config, ACTIVE_NETWORK } from '../config';
import { sanitizeWalletMessage } from '../utils/sanitizeWalletMessage';

interface Props {
  walletAddress: string;
  onSuccess: (proposalId: number) => void;
  onCancel: () => void;
}

interface FormState {
  title: string;
  description: string;
  quorum: string;
  duration: string;
}

const INITIAL_FORM: FormState = {
  title: '',
  description: '',
  quorum: '1000',
  duration: '86400', // 1 day in seconds
};

/** Returns the localStorage key scoped to the wallet address to prevent cross-user leakage. */
function draftKey(walletAddress: string): string {
  return `cosmosvote:proposal_draft:${walletAddress}`;
}

function saveDraft(walletAddress: string, form: FormState): void {
  try {
    localStorage.setItem(draftKey(walletAddress), JSON.stringify(form));
  } catch {
    // Storage may be full or unavailable — silently ignore
  }
}

function loadDraft(walletAddress: string): FormState | null {
  try {
    const raw = localStorage.getItem(draftKey(walletAddress));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FormState>;
    // Validate shape before returning
    if (
      typeof parsed.title === 'string' &&
      typeof parsed.description === 'string' &&
      typeof parsed.quorum === 'string' &&
      typeof parsed.duration === 'string'
    ) {
      return parsed as FormState;
    }
    return null;
  } catch {
    return null;
  }
}

function clearDraft(walletAddress: string): void {
  try {
    localStorage.removeItem(draftKey(walletAddress));
  } catch {
    // ignore
  }
}

const DURATION_PRESETS = [
  { label: '1 day', value: '86400' },
  { label: '3 days', value: '259200' },
  { label: '7 days', value: '604800' },
  { label: '14 days', value: '1209600' },
  { label: '30 days', value: '2592000' },
];

function fieldError(form: FormState): Partial<Record<keyof FormState, string>> {
  const errors: Partial<Record<keyof FormState, string>> = {};
  if (!form.title.trim()) errors.title = 'Title is required.';
  else if (form.title.length > 128) errors.title = 'Title must be ≤ 128 characters.';
  if (!form.description.trim()) errors.description = 'Description is required.';
  else if (form.description.length > 1024) errors.description = 'Description must be ≤ 1024 characters.';
  const q = Number(form.quorum);
  if (!form.quorum || isNaN(q) || q <= 0) errors.quorum = 'Quorum must be a positive number.';
  const d = Number(form.duration);
  if (!form.duration || isNaN(d) || d < 60 || d > 2_592_000)
    errors.duration = 'Duration must be between 60 seconds and 30 days.';
  return errors;
}

export function CreateProposalForm({ walletAddress, onSuccess, onCancel }: Props) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showRestorePrompt, setShowRestorePrompt] = useState(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On mount: check for a saved draft and prompt the user to restore it
  useEffect(() => {
    const draft = loadDraft(walletAddress);
    if (draft && (draft.title || draft.description)) {
      setShowRestorePrompt(true);
    }
  }, [walletAddress]);

  // Auto-save after 1 second of inactivity whenever form changes
  const scheduleAutosave = useCallback(
    (nextForm: FormState) => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = setTimeout(() => saveDraft(walletAddress, nextForm), 1000);
    },
    [walletAddress],
  );

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  const errors = fieldError(form);
  const hasErrors = Object.keys(errors).length > 0;

  function handleChange(field: keyof FormState, value: string) {
    setForm(prev => {
      const next = { ...prev, [field]: value };
      scheduleAutosave(next);
      return next;
    });
  }

  function handleBlur(field: keyof FormState) {
    setTouched(prev => ({ ...prev, [field]: true }));
  }

  function handleRestoreDraft() {
    const draft = loadDraft(walletAddress);
    if (draft) setForm(draft);
    setShowRestorePrompt(false);
  }

  function handleDiscardDraft() {
    clearDraft(walletAddress);
    setShowRestorePrompt(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Mark all fields as touched to show validation errors
    setTouched({ title: true, description: true, quorum: true, duration: true });
    if (hasErrors) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      const server = new SorobanRpc.Server(config.rpcUrl);

      // Fetch the live account to get the current sequence number
      const accountData = await server.getAccount(walletAddress);
      const account = new Account(walletAddress, accountData.sequence);

      const networkPassphrase =
        ACTIVE_NETWORK === 'mainnet'
          ? Networks.PUBLIC
          : Networks.TESTNET;

      // Sanitize all wallet-facing message fields to ASCII-safe characters only
      // before they are embedded in the transaction (and shown by the wallet).
      const safeTitle = sanitizeWalletMessage(form.title.trim(), 128);
      const safeDescription = sanitizeWalletMessage(form.description.trim(), 1024);

      const tx = new TransactionBuilder(account, {
        fee: '1000000', // 0.1 XLM max fee — governance calls are compute-heavy
        networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: config.governanceContractId,
            function: 'create_proposal',
            args: [
              nativeToScVal(walletAddress, { type: 'address' }),
              nativeToScVal(safeTitle, { type: 'string' }),
              nativeToScVal(safeDescription, { type: 'string' }),
              nativeToScVal(BigInt(Math.round(Number(form.quorum))), { type: 'i128' }),
              nativeToScVal(BigInt(Math.round(Number(form.duration))), { type: 'u64' }),
            ],
          })
        )
        .setTimeout(30)
        .build();

      // Simulate to get the footprint and fee
      const simResult = await server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation error: ${simResult.error}`);
      }

      // Assemble the transaction with the simulated footprint
      const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();

      // In a real app the wallet extension (Freighter, Albedo, etc.) would sign here.
      // Since CosmosVote uses a manual address entry flow without a signing extension,
      // we surface the unsigned XDR so the user can sign and submit externally, OR
      // accept a secret key in development environments via a prompt.
      //
      // Development / testnet path: ask for secret key via prompt.
      // Production path: integrate wallet extension SDK and replace this block.
      const secretKey = window.prompt(
        sanitizeWalletMessage(
          'Development mode: enter your Stellar secret key (S...) to sign this transaction. ' +
          'In production, connect a wallet extension (Freighter) instead.',
          512,
        )
      );

      if (!secretKey) {
        setSubmitError('Transaction signing cancelled.');
        setSubmitting(false);
        return;
      }

      if (!secretKey.startsWith('S')) {
        setSubmitError('Invalid secret key. It must start with "S".');
        setSubmitting(false);
        return;
      }

      const keypair = Keypair.fromSecret(secretKey);
      assembled.sign(keypair);

      const sendResult = await server.sendTransaction(assembled);
      if (sendResult.status === 'ERROR') {
        throw new Error(`Submission error: ${JSON.stringify(sendResult.errorResult)}`);
      }

      // Poll for confirmation
      let hash = sendResult.hash;
      let attempts = 0;
      while (attempts < 20) {
        await new Promise(r => setTimeout(r, 2000));
        const status = await server.getTransaction(hash);
        if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          // Extract the returned proposal ID from the result
          const returnedId = status.returnValue
            ? Number(status.returnValue.u64().toString())
            : 0;
          // Clear the draft on successful submission
          clearDraft(walletAddress);
          onSuccess(returnedId);
          return;
        }
        if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
          throw new Error('Transaction failed on-chain.');
        }
        attempts++;
      }
      throw new Error('Transaction timed out waiting for confirmation.');
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle = (field: keyof FormState): React.CSSProperties => ({
    width: '100%',
    padding: '0.5rem 0.75rem',
    border: `1px solid ${touched[field] && errors[field] ? '#dc2626' : '#d1d5db'}`,
    borderRadius: 6,
    fontSize: '0.875rem',
    boxSizing: 'border-box',
    background: '#fff',
    color: '#1e293b',
    outline: 'none',
  });

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 600,
    color: '#374151',
    marginBottom: '0.35rem',
  };

  const errorStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: '#dc2626',
    marginTop: '0.25rem',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          padding: '2rem',
          maxWidth: 560,
          width: '90%',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.25rem', color: '#1e293b' }}>Create Proposal</h2>
          <button
            onClick={onCancel}
            aria-label="Close"
            style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#6b7280', lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {/* Restore draft banner */}
        {showRestorePrompt && (
          <div
            role="alert"
            style={{
              marginBottom: '1rem',
              padding: '0.75rem',
              background: '#eff6ff',
              border: '1px solid #93c5fd',
              borderRadius: 6,
              fontSize: '0.875rem',
              color: '#1d4ed8',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <span>📝 You have a saved draft. Restore it?</span>
            <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
              <button
                type="button"
                onClick={handleRestoreDraft}
                style={{
                  background: '#2563eb',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  padding: '0.25rem 0.75rem',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                Restore
              </button>
              <button
                type="button"
                onClick={handleDiscardDraft}
                style={{
                  background: 'none',
                  color: '#64748b',
                  border: '1px solid #d1d5db',
                  borderRadius: 4,
                  padding: '0.25rem 0.75rem',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                Discard
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div style={{ display: 'grid', gap: '1rem' }}>

            {/* Title */}
            <div>
              <label htmlFor="cp-title" style={labelStyle}>
                Title <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <input
                id="cp-title"
                type="text"
                value={form.title}
                onChange={e => handleChange('title', e.target.value)}
                onBlur={() => handleBlur('title')}
                placeholder="e.g. Increase validator rewards by 5%"
                maxLength={128}
                style={inputStyle('title')}
                aria-describedby={errors.title ? 'cp-title-error' : undefined}
                aria-invalid={touched.title && !!errors.title}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                {touched.title && errors.title
                  ? <span id="cp-title-error" style={errorStyle}>{errors.title}</span>
                  : <span />
                }
                <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{form.title.length}/128</span>
              </div>
            </div>

            {/* Description */}
            <div>
              <label htmlFor="cp-description" style={labelStyle}>
                Description <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <textarea
                id="cp-description"
                value={form.description}
                onChange={e => handleChange('description', e.target.value)}
                onBlur={() => handleBlur('description')}
                placeholder="Describe the proposal in detail…"
                maxLength={1024}
                rows={5}
                style={{ ...inputStyle('description'), resize: 'vertical', fontFamily: 'inherit' }}
                aria-describedby={errors.description ? 'cp-desc-error' : undefined}
                aria-invalid={touched.description && !!errors.description}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                {touched.description && errors.description
                  ? <span id="cp-desc-error" style={errorStyle}>{errors.description}</span>
                  : <span />
                }
                <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{form.description.length}/1024</span>
              </div>
            </div>

            {/* Quorum */}
            <div>
              <label htmlFor="cp-quorum" style={labelStyle}>
                Quorum (CVT) <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <input
                id="cp-quorum"
                type="number"
                min={1}
                value={form.quorum}
                onChange={e => handleChange('quorum', e.target.value)}
                onBlur={() => handleBlur('quorum')}
                placeholder="e.g. 1000"
                style={inputStyle('quorum')}
                aria-describedby={errors.quorum ? 'cp-quorum-error' : undefined}
                aria-invalid={touched.quorum && !!errors.quorum}
              />
              {touched.quorum && errors.quorum && (
                <span id="cp-quorum-error" style={errorStyle}>{errors.quorum}</span>
              )}
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.25rem' }}>
                Minimum total votes (Yes + No + Abstain) required for this proposal to be valid.
              </div>
            </div>

            {/* Duration */}
            <div>
              <label htmlFor="cp-duration" style={labelStyle}>
                Duration <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                {DURATION_PRESETS.map(p => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => handleChange('duration', p.value)}
                    style={{
                      padding: '3px 10px',
                      borderRadius: 4,
                      border: '1px solid',
                      borderColor: form.duration === p.value ? '#2563eb' : '#d1d5db',
                      background: form.duration === p.value ? '#eff6ff' : '#fff',
                      color: form.duration === p.value ? '#2563eb' : '#555',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                id="cp-duration"
                type="number"
                min={60}
                max={2592000}
                value={form.duration}
                onChange={e => handleChange('duration', e.target.value)}
                onBlur={() => handleBlur('duration')}
                placeholder="seconds (60 – 2592000)"
                style={inputStyle('duration')}
                aria-describedby={errors.duration ? 'cp-duration-error' : undefined}
                aria-invalid={touched.duration && !!errors.duration}
              />
              {touched.duration && errors.duration && (
                <span id="cp-duration-error" style={errorStyle}>{errors.duration}</span>
              )}
              {!errors.duration && form.duration && (
                <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.25rem' }}>
                  ≈ {(Number(form.duration) / 86400).toFixed(1)} days
                </div>
              )}
            </div>

          </div>

          {/* Submission error */}
          {submitError && (
            <div style={{
              margin: '1rem 0 0',
              padding: '0.75rem',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 6,
              fontSize: '0.875rem',
              color: '#dc2626',
            }}
              role="alert"
            >
              <strong>Error:</strong> {submitError}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.5rem' }}>
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              style={{
                background: 'none',
                color: '#64748b',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                padding: '0.5rem 1.25rem',
                fontSize: '0.875rem',
                cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting ? 0.6 : 1,
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={{
                background: submitting ? '#93c5fd' : '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '0.5rem 1.25rem',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: submitting ? 'not-allowed' : 'pointer',
                minWidth: 140,
              }}
            >
              {submitting ? '⏳ Submitting…' : 'Create Proposal'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
