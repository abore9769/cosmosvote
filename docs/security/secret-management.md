# Secret Management

## Core Rules

- **Never commit secrets** — private keys, tokens, passwords, and API keys must not appear in source code or git history.
- Use `.gitignore` to exclude `.env` and credential files. See `.env.example` for the list of required variables.
- Rotate any secret that has been accidentally committed immediately.

## Environment Variables

Copy `.env.example` to `.env` and populate locally:

```bash
cp .env.example .env
```

`.env` is git-ignored. Never commit it. Required variables:

| Variable | Purpose |
|---|---|
| `STELLAR_SECRET_KEY` | Signing key for deployments |
| `STELLAR_RPC_URL` | Network RPC endpoint |
| `GOVERNANCE_CONTRACT_ID` | Deployed governance contract |
| `TOKEN_CONTRACT_ID` | Deployed token contract |

## CI / GitHub Actions

Store all secrets in **GitHub Secrets** (Settings → Secrets and variables → Actions), not in workflow files or committed configs.

Reference them in workflows as `${{ secrets.SECRET_NAME }}`. Never `echo` secret values in logs.

## Service Account Keys

- Generate dedicated service accounts with the minimum required permissions.
- Store keys exclusively in GitHub Secrets or a secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault).
- Rotate keys on a schedule (recommend: 90 days) and immediately after any team member departure.
- Delete unused keys promptly.

## Secret Scanning

A `secret-scan` CI job runs [gitleaks](https://github.com/gitleaks/gitleaks) on every push and pull request to detect committed secrets. The job is **required for merge** — a detected secret blocks the PR until it is removed from the code (and, if already pushed, from git history) and the secret is rotated.

The rule set (configured in `.gitleaks.toml`) detects, among others:

- **Stellar secret keys** — strings starting with `S` followed by 55 base32 characters (`S[A-Z2-7]{55}`).
- **API tokens** — generic high-entropy tokens and known provider token formats.
- **JWT secrets** — hardcoded signing keys and secret assignments.
- **Database connection strings** — URIs containing embedded credentials (e.g. `postgres://user:pass@host`).
- **Private key headers** — `-----BEGIN ... PRIVATE KEY-----` blocks.

### Suppressing false positives

If gitleaks flags a non-secret (e.g. a test fixture or documentation example), add a suppression entry to `.gitleaksignore` at the repository root instead of disabling the rule. Each entry is a finding fingerprint in the form `commit:file:rule-id:line`:

```
# .gitleaksignore
# Example: placeholder key in docs
abc123def456:docs/security/secret-management.md:stellar-secret-key:42
```

Get the fingerprint from the gitleaks output in the failed CI job, or run locally:

```bash
gitleaks detect --source . --report-format json --report-path gitleaks-report.json
```

Suppressions should be rare and reviewed — never add an entry to silence a real secret.
