export function maskAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  const str = String(amount);
  if (decimals === 0) return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  
  const padded = str.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, -decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let fracPart = padded.slice(-decimals);
  
  // We can just keep 2 decimals for simplicity or trim trailing zeros
  fracPart = fracPart.slice(0, 2).padEnd(2, '0');
  
  return `${intPart}.${fracPart} CVT`;
}

/**
 * Maximum length (in characters) of a sanitized wallet-facing message.
 */
export const WALLET_MESSAGE_MAX_LENGTH = 200;

/**
 * Placeholder inserted in place of stripped non-ASCII characters.
 */
export const WALLET_MESSAGE_PLACEHOLDER = '?';

/**
 * Sanitizes a wallet-facing transaction memo/message so it is safe to display
 * in a wallet UI.
 *
 * Rules:
 * - Null bytes (`\u0000`) are removed.
 * - C0 control characters (`\u0000`-`\u001F`) and DEL (`\u007F`) are removed,
 *   except for common whitespace (`\t`, `\n`, `\r`) which are normalized below.
 * - C1 control characters (`\u0080`-`\u009F`) are removed.
 * - All non-ASCII characters (including Unicode, emoji, etc.) are replaced
 *   with `WALLET_MESSAGE_PLACEHOLDER`.
 * - Runs of whitespace are collapsed into a single space and the result is
 *   trimmed.
 * - The result is truncated to `WALLET_MESSAGE_MAX_LENGTH` characters.
 *
 * @param input The raw message string.
 * @returns An ASCII-safe, whitespace-normalized, length-bounded string.
 */
export function sanitizeWalletMessage(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    return '';
  }

  let result = '';

  for (const ch of input) {
    const code = ch.codePointAt(0)!;

    // Null byte: drop.
    if (code === 0x00) {
      continue;
    }

    // C0 control characters (including \t, \n, \r) -> treat as whitespace.
    if (code <= 0x1f) {
      result += ' ';
      continue;
    }

    // DEL and C1 control characters: drop.
    if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      continue;
    }

    // Non-ASCII (including emoji and other Unicode): replace with placeholder.
    if (code > 0x7e) {
      result += WALLET_MESSAGE_PLACEHOLDER;
      continue;
    }

    // Printable ASCII: keep.
    result += ch;
  }

  // Normalize whitespace: collapse runs and trim.
  result = result.replace(/\s+/g, ' ').trim();

  // Enforce max length.
  if (result.length > WALLET_MESSAGE_MAX_LENGTH) {
    result = result.slice(0, WALLET_MESSAGE_MAX_LENGTH).trim();
  }

  return result;
}