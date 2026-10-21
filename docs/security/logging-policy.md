# Notification Service Logging Policy

## Overview

The CosmosVote notification service processes on-chain governance events and
dispatches notifications via webhooks and email.  Because event payloads
reference wallet addresses and transaction hashes, all log output must be
treated as potentially sensitive.

This document defines what **must** and **must not** appear in logs and
describes the masking helpers in `notification/src/secure_log.rs`.

---

## PII and Sensitive Data Classification

| Data Type | Example | Classification | Log Treatment |
|---|---|---|---|
| Full wallet address | `GABCDE…FGHIJ1234` | Pseudonymous identifier | Truncate: first 6 + last 4 chars |
| Transaction / ledger hash | `deadbeef1234…` | Sensitive reference | Truncate: first 8 chars + `…` |
| Email address | `user@example.com` | PII | Replace with `[email]` |
| Webhook URL (full) | `https://hooks.ex.com/path?token=x` | Potentially sensitive | Log domain only |
| Error messages | May embed addresses | Varies | Run through `mask_address` before logging |

---

## Log Levels

| Level | When to use | PII rules |
|---|---|---|
| `ERROR` | Dispatch failures, unrecoverable errors | Masked identifiers only |
| `WARN` | Retry attempts, unexpected HTTP responses | Masked identifiers only |
| `INFO` | One line per processed event | Event kind, masked event ID, masked actor |
| `DEBUG` | Internal state, request/response bodies | **Disabled in production** |

Debug logging **must be disabled** in any environment where logs are
persisted or forwarded to external systems (e.g., CloudWatch, Datadog).

---

## Masking Helpers (`secure_log.rs`)

All helpers live in `notification/src/secure_log.rs`.

### `mask_address(addr: &str) -> String`

Masks a Stellar wallet address: `GABCDE1234567890FGHIJ` → `GABCDE…GHIJ`.

Addresses shorter than 10 characters are replaced with `[masked]`.

### `mask_tx_hash(hash: &str) -> String`

Truncates a transaction or ledger hash to its first 8 characters: `abcdef1234567890` → `abcdef12…`.

### `mask_email(_email: &str) -> &'static str`

Returns the fixed string `[email]` regardless of input.

### `sanitise_webhook_url(url: &str) -> String`

Strips path and query parameters, keeping only `scheme://host`:
`https://hooks.example.com/gov/proposals?token=secret` → `https://hooks.example.com`.

### `SafeLogEntry`

Structured log entry that accepts raw values and masks them at construction
time.  Call `.to_log_line()` to produce a single INFO-level log string that
is safe to write to any sink.

```rust
let entry = SafeLogEntry::from_vote_cast(event_id, proposal_id, voter_address);
println!("{}", entry.to_log_line());
// [INFO] event=txhash12… kind=vote_cast proposal_id=3 actor=GABCDE…GHIJ
```

---

## Audit Trail Requirements

Each successfully processed event **must** produce one `INFO` log line using
`SafeLogEntry`.  This provides a tamper-evident sequence of event IDs that
can be correlated with on-chain data during incident response, without
exposing raw wallet addresses.

Failed dispatch attempts **must** produce one `ERROR` log line that includes:
- The masked event ID
- The dispatch channel (webhook / email)
- The error class (not a raw error message that may embed addresses)

---

## Admin Audit Log

All admin-level backend operations **must** produce a structured audit log
entry.  Admin operations include (but are not limited to) `cancel`,
`execute`, `pause`, `unpause`, and `transfer_admin`, whether triggered via
the on-chain contract or through any off-chain admin API.

### Required Fields

Every audit entry is a single JSON object written on one line and **must**
contain all of the following fields:

| Field | Type | Description |
|---|---|---|
| `timestamp` | string (RFC 3339, UTC) | When the operation was processed |
| `admin` | string | Admin address that authorised the operation (masked per `mask_address` when written to general-purpose sinks; stored in full only in the restricted audit sink) |
| `action` | string | Operation name, e.g. `cancel`, `execute`, `pause`, `unpause`, `transfer_admin` |
| `proposal_id` | number \| null | Target proposal ID; `null` for non-proposal operations such as `pause` or `transfer_admin` |
| `outcome` | string | One of `success`, `rejected`, `failed` |

Implementations **may** add fields (e.g. `request_id`, `error_class`) but
**must not** omit or rename the fields above.

Example entry:

```json
{"timestamp":"2025-01-15T12:34:56Z","admin":"GABCDE…GHIJ","action":"execute","proposal_id":42,"outcome":"success"}
```

### Append-Only Sink

- Audit entries are written to a dedicated append-only sink (append-only
  file with restricted permissions, or a write-once database table).
- The application role used by the backend **must not** have `UPDATE` or
  `DELETE` privileges on the audit table, and the audit file must be opened
  in append mode only.
- Entries are never edited or removed in place.  Corrections are made by
  appending a new entry that references the original (e.g. via
  `request_id`).
- Writes are flushed and, where the sink supports it, `fsync`ed before the
  operation is reported as complete.

### Tamper Evidence

- Each entry is written as a single atomic line to prevent interleaving.
- Where supported, entries are chained by including the hash of the
  previous entry (`prev_hash`) so that deletion or reordering of entries is
  detectable during incident response.
- The audit sink is periodically exported to write-once storage (e.g.
  object storage with retention lock) to provide an independent copy.

### Retention

- Audit entries are retained for a minimum of **1 year**, or longer where
  required by applicable regulation.
- Retention is enforced by the storage backend's lifecycle policy; the
  application itself never deletes audit entries.

### Access Controls

- Read access to the audit sink is limited to operators and security
  responders on a need-to-know basis.
- The audit sink is stored separately from application logs so that log
  rotation or retention policies cannot affect audit records.
- Access to the audit sink is itself logged.

---

## Log Sink Guidance

| Sink | Recommendation |
|---|---|
| Local file | Restrict file permissions (`chmod 640`) |
| CloudWatch Logs | Enable encryption at rest; no raw-address log groups |
| Datadog / Splunk | Apply field-level masking rules for any `actor=` fields |
| CI/CD stdout | Acceptable; no persistent storage |

---

## Compliance Notes

- Stellar wallet addresses are pseudonymous but can be correlated with
  real-world identities via chain analysis.  Treat them as PII per GDPR
  Article 4(1) and equivalent regulations.
- Email addresses are PII and must never appear in log output.
- This policy applies to all environments: local, testnet, and mainnet.
