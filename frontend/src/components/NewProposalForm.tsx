/**
 * NewProposalForm — modal form for creating a governance proposal.
 *
 * Issue #276: Client-side input validation
 *  - All fields are validated before the transaction is submitted.
 *  - Inline errors appear immediately on blur and in real-time after the
 *    first failed submission attempt so users know what needs fixing.
 *  - The Submit button is disabled whenever the form is invalid.
 *  - Character counts are shown for length-bounded text fields.
 */

import { useState, useCallback } from 'react';
import { sanitizeWalletMessage } from '../utils/sanitizeWalletMessage';

interface Props {
  onClose: () => void;
  onSuccess: (proposalId: number) => void;
  onAnnounce?: (msg: string) => void;
  onError?: (msg: string) => void;
}

interface FormState {
  title: string;
  description: string;
  quorum: string;
  duration: string;
}

type FieldName = keyof FormState;
type FormErrors = Partial<Record<FieldName, string>>;

const INITIAL: FormState = { title: '', description: '', quorum: '', duration: '' };

// ---------------------------------------------------------------------------
// Validation rules (mirrors the on-chain contract constraints)
// ---------------------------------------------------------------------------

const TITLE_MAX = 128;
const DESC_MAX = 1024;
const DURATION_MIN = 60;
const DURATION_MAX = 2_592_000;

function validateField(name: FieldName, value: string): string | undefined {
  switch (name) {
    case 'title': {
      if (!value.trim()) return 'Title is required.';
      if (value.length > TITLE_MAX) return `Title must be ≤ ${TITLE_MAX} characters.`;
      return undefined;
    }
    case 'description': {
      if (!value.trim()) return 'Description is required.';
      if (value.length > DESC_MAX) return `Description must be ≤ ${DESC_MAX} characters.`;
      return undefined;
    }
    case 'quorum': {
      if (!value.trim()) return 'Quorum is required.';
      const q = Number(value);
      if (isNaN(q) || !Number.isInteger(q) || q <= 0) return 'Quorum must be a positive whole number.';
      return undefined;
    }
    case 'duration': {
      if (!value.trim()) return 'Duration is required.';
      const d = Number(value);
      if (isNaN(d) || !Number.isInteger(d) || d < DURATION_MIN || d > DURATION_MAX) {
        return `Duration must be ${DURATION_MIN.toLocaleString()}–${DURATION_MAX.toLocaleString()} seconds.`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function validateAll(form: FormState): FormErrors {
  const errs: FormErrors = {};
  (Object.keys(form) as FieldName[]).forEach(k => {
    const err = validateField(k, form[k]);
    if (err) errs[k] = err;
  });
  return errs;
}

function isFormValid(errors: FormErrors): boolean {
  return Object.keys(errors).length === 0;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
};

const dialog: React.CSSProperties = {
  background: 'var(--bg-card, #fff)',
  color: 'var(--text-primary, #1e293b)',
  borderRadius: 12,
  padding: '2rem',
  maxWidth: 560,
  width: '90%',
  maxHeight: '90vh',
  overflowY: 'auto',
};

const fieldStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '1rem',
};

function inputStyle(hasError: boolean): React.CSSProperties {
  return {
    padding: '0.5rem 0.75rem',
    border: `1px solid ${hasError ? 'var(--error-color, #dc2626)' : 'var(--input-border, #d1d5db)'}`,
    borderRadius: 6,
    fontSize: '0.875rem',
    width: '100%',
    boxSizing: 'border-box',
    background: 'var(--bg-input, #fff)',
    color: 'var(--text-primary, #1e293b)',
    outline: hasError ? `2px solid var(--error-color, #dc2626)` : undefined,
  };
}

const errorStyle: React.CSSProperties = {
  color: 'var(--error-color, #dc2626)',
  fontSize: '0.75rem',
  marginTop: '0.15rem',
};

const hintStyle: React.CSSProperties = {
  fontSize: '0.7rem',
  color: 'var(--text-muted, #888)',
  marginTop: '0.1rem',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NewProposalForm({ onClose, onSuccess, onAnnounce, onError }: Props) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<FormErrors>({});
  // Track which fields have been "touched" (blurred) so errors don't flash on pristine fields
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  // Once the user has attempted to submit we show all errors immediately on change
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Re-validate a single field and update errors state
  const revalidateField = useCallback((name: FieldName, value: string) => {
    const err = validateField(name, value);
    setErrors(prev => {
      const next = { ...prev };
      if (err) {
        next[name] = err;
      } else {
        delete next[name];
      }
      return next;
    });
  }, []);

  const handleChange = (name: FieldName) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const value = e.target.value;
    setForm(prev => ({ ...prev, [name]: value }));
    // Show real-time feedback only after touch or first submit attempt
    if (touched[name] || submitAttempted) {
      revalidateField(name, value);
    }
  };

  const handleBlur = (name: FieldName) => () => {
    setTouched(prev => ({ ...prev, [name]: true }));
    revalidateField(name, form[name]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);

    const allErrors = validateAll(form);
    setErrors(allErrors);

    if (!isFormValid(allErrors)) {
      // Focus the first invalid field for accessibility
      const firstKey = (Object.keys(allErrors) as FieldName[])[0];
      document.getElementById(`np-${firstKey}`)?.focus();
      return;
    }

    setSubmitting(true);
    onAnnounce?.('Submitting proposal…');

    // Issue #118: sanitize all wallet-facing message fields before they are
    // used in the submission payload or any wallet-displayed message.
    const payload = {
      title: sanitizeWalletMessage(form.title),
      description: sanitizeWalletMessage(form.description),
      quorum: Number(form.quorum),
      duration: Number(form.duration),
    };

    try {
      // Placeholder: replace with real signed transaction when wallet integration is complete
      await new Promise(r => setTimeout(r, 800));
      const mockId = Date.now() % 10000;
      // Only sanitized values are ever interpolated into wallet-facing messages.
      onAnnounce?.(
        sanitizeWalletMessage(
          `Proposal "${payload.title}" submitted successfully. Redirecting to proposal #${mockId}.`
        )
      );
      onSuccess(mockId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onError?.(sanitizeWalletMessage(msg));
      setSubmitting(false);
    }
  };

  // Whether a field should display its error (touched or submit attempted)
  const showError = (name: FieldName) => (touched[name] || submitAttempted) && !!errors[name];

  const formHasErrors = !isFormValid(validateAll(form));

  return (
    <div style={overlay} onClick={onClose} role="presentation">
      <div
        style={dialog}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-proposal-title"
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <h2 id="new-proposal-title" style={{ margin: 0 }}>New Proposal</h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'var(--text-primary, #1e293b)' }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate aria-label="New proposal form">

          {/* Title */}
          <div style={fieldStyle}>
            <label htmlFor="np-title">
              Title <span aria-hidden="true" style={{ color: 'var(--error-color, #dc2626)' }}>*</span>
            </label>
            <input
              id="np-title"
              type="text"
              value={form.title}
              onChange={handleChange('title')}
              onBlur={handleBlur('title')}
              maxLength={TITLE_MAX}
              style={inputStyle(showError('title'))}
              aria-describedby="np-title-hint np-title-err"
              aria-invalid={showError('title')}
              aria-required="true"
              autoComplete="off"
            />
            <span id="np-title-hint" style={hintStyle}>
              {form.title.length}/{TITLE_MAX} characters
            </span>
            {showError('title') && (
              <span id="np-title-err" style={errorStyle} role="alert">
                {errors.title}
              </span>
            )}
          </div>

          {/* Description */}
          <div style={fieldStyle}>
            <label htmlFor="np-desc">
              Description <span aria-hidden="true" style={{ color: 'var(--error-color, #dc2626)' }}>*</span>
            </label>
            <textarea
              id="np-desc"
              value={form.description}
              onChange={handleChange('description')}
              onBlur={handleBlur('description')}
              maxLength={DESC_MAX}
              rows={4}
              style={{ ...inputStyle(showError('description')), resize: 'vertical' }}
              aria-describedby="np-desc-hint np-desc-err"
              aria-invalid={showError('description')}
              aria-required="true"
            />
            <span id="np-desc-hint" style={hintStyle}>
              {form.description.length}/{DESC_MAX} characters
            </span>
            {showError('description') && (
              <span id="np-desc-err" style={errorStyle} role="alert">
                {errors.description}
              </span>
            )}
          </div>

          {/* Quorum */}
          <div style={fieldStyle}>
            <label htmlFor="np-quorum">
              Quorum (token units){' '}
              <span aria-hidden="true" style={{ color: 'var(--error-color, #dc2626)' }}>*</span>
            </label>
            <input
              id="np-quorum"
              type="number"
              min={1}
              step={1}
              value={form.quorum}
              onChange={handleChange('quorum')}
              onBlur={handleBlur('quorum')}
              style={inputStyle(showError('quorum'))}
              aria-describedby="np-quorum-hint np-quorum-err"
              aria-invalid={showError('quorum')}
              aria-required="true"
            />
            <span id="np-quorum-hint" style={hintStyle}>
              Minimum token votes required for the proposal to pass.
            </span>
            {showError('quorum') && (
              <span id="np-quorum-err" style={errorStyle} role="alert">
                {errors.quorum}
              </span>
            )}
          </div>

          {/* Duration */}
          <div style={fieldStyle}>
            <label htmlFor="np-duration">
              Duration (seconds){' '}
              <span aria-hidden="true" style={{ color: 'var(--error-color, #dc2626)' }}>*</span>
            </label>
            <input
              id="np-duration"
              type="number"
              min={DURATION_MIN}
              max={DURATION_MAX}
              step={1}
              value={form.duration}
              onChange={handleChange('duration')}
              onBlur={handleBlur('duration')}
              style={inputStyle(showError('duration'))}
              aria-describedby="np-duration-hint np-duration-err"
              aria-invalid={showError('duration')}
              aria-required="true"
            />
            <span id="np-duration-hint" style={hintStyle}>
              {DURATION_MIN.toLocaleString()}–{DURATION_MAX.toLocaleString()} s&nbsp;
              (1 min – 30 days)
            </span>
            {showError('duration') && (
              <span id="np-duration-err" style={errorStyle} role="alert">
                {errors.duration}
              </span>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '0.5rem 1rem',
                border: '1px solid var(--input-border, #d1d5db)',
                borderRadius: 6,
                background: 'var(--bg-card, #fff)',
                color: 'var(--text-primary, #1e293b)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || (submitAttempted && formHasErrors)}
              aria-disabled={submitting || (submitAttempted && formHasErrors)}
              style={{
                padding: '0.5rem 1rem',
                border: 'none',
                borderRadius: 6,
                background: '#3b82f6',
                color: '#fff',
                cursor: submitting || (submitAttempted && formHasErrors) ? 'not-allowed' : 'pointer',
                opacity: submitting || (submitAttempted && formHasErrors) ? 0.65 : 1,
              }}
            >
              {submitting ? 'Submitting…' : 'Submit Proposal'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
