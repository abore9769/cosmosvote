# Wallet message sanitization

This document describes how consumer-supplied strings are sanitized before they are displayed in a wallet or embedded in a wallet payload (transaction memo, prompt, or message field).

## Background

Proposal titles and descriptions are rendered as React text nodes (not HTML), so consumer-supplied strings are escaped and cannot inject markup into the DOM. However, wallet-facing fields are a separate trust boundary: they are shown by third-party wallet software and may be embedded in transaction memos. Misleading content (control characters, invisible Unicode, bidi overrides, emoji, null bytes) can be used to spoof or confuse what a user sees. All wallet-facing message fields must therefore be sanitized to ASCII-safe characters only.

## Sanitized fields

The following fields are sanitized before being shown in a wallet or placed in a wallet payload:

- Transaction memo / message fields set by the frontend
- Proposal titles used in wallet prompts
- Proposal descriptions used in wallet prompts
- Any other consumer-supplied string that is passed to a wallet display or wallet payload

## Sanitization rules

Sanitization is applied in the following order. The result is guaranteed to contain only printable ASCII characters (U+0020–U+007E) plus normalized whitespace.

1. **Null byte removal** — all `U+0000` (NUL) characters are removed.
2. **Control character stripping** — all C0 control characters (`U+0000`–`U+001F`) and DEL (`U+007F`) are removed. This includes newlines, tabs, carriage returns, and escape sequences.
3. **Non-ASCII replacement** — any character outside the printable ASCII range (`U+0020`–`U+007E`) is removed. This covers Unicode letters, combining marks, bidi control characters (e.g. `U+202E`), zero-width characters, and emoji.
4. **Whitespace normalization** — runs of whitespace are collapsed to a single space (`U+0020`), and leading/trailing whitespace is trimmed.
5. **Max length** — the result is truncated to a fixed maximum length (e.g. 200 characters) to keep wallet displays readable and to bound payload size.

If the sanitized result is empty, the field should be treated as absent rather than displayed as an empty string.

## Examples

| Input | Output | Reason |
| --- | --- | --- |
| `Hello, world!` | `Hello, world!` | Already ASCII-safe |
| `Café proposal` | `Caf proposal` | `é` is non-ASCII and removed |
| `Vote 🚀 now` | `Vote  now` → `Vote now` | Emoji removed, whitespace normalized |
| `Line one\nLine two` | `Line oneLine two` | Newline is a control character and removed |
| `Bad\0Actor` | `BadActor` | Null byte removed |
| `Esc\x1b[31mred` | `Esc[31mred` | Escape control character removed |
| `Spoof\u202Etxet` | `Spooftxet` | Bidi override is non-ASCII and removed |
| `   spaced   out   ` | `spaced out` | Whitespace normalized and trimmed |
| `\0\x01\x02` | *(empty — treated as absent)* | Only control characters present |

## Guidance for future wallet-facing fields

- Route every new wallet-facing string through the shared sanitization function before display or payload construction. Do not hand-roll per-field cleaning.
- Never pass raw consumer input into a transaction memo or wallet prompt.
- Treat sanitized-empty results as absent, not as an empty string.
- Avoid using `dangerouslySetInnerHTML` unless you explicitly sanitize input with a robust HTML sanitizer (e.g., DOMPurify). Wallet payloads should treat titles/descriptions as plain text when building prompts or transactions.
- Add tests for new fields covering Unicode, emoji, null bytes, and control characters.