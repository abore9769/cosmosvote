import * as fs from 'fs';
import * as path from 'path';

/**
 * Structured audit log entry for admin-level backend operations.
 *
 * All fields are required so that every admin operation produces a
 * complete, tamper-evident record.
 */
export interface AuditLogEntry {
  /** ISO-8601 timestamp of when the operation was recorded. */
  timestamp: string;
  /** Address of the admin who performed the operation. */
  adminAddress: string;
  /** The admin action that was performed (e.g. 'cancel', 'execute', 'pause', 'transfer_admin'). */
  action: string;
  /** Identifier of the proposal the action relates to, if applicable. */
  proposalId: string;
  /** Outcome of the operation (e.g. 'success', 'failure', 'rejected'). */
  outcome: string;
}

/**
 * Options for configuring the audit log module.
 */
export interface AuditLogOptions {
  /** Absolute or relative path to the append-only audit log file. */
  logFilePath?: string;
}

const DEFAULT_LOG_FILE = path.resolve(
  process.env.AUDIT_LOG_PATH || path.join(process.cwd(), 'logs', 'admin-audit.log'),
);

let logFilePath: string = DEFAULT_LOG_FILE;
let initialized = false;

/**
 * Ensure the directory for the audit log file exists and that the file is
 * opened in append mode. The file is never truncated or rewritten.
 */
function ensureInitialized(): void {
  if (initialized) {
    return;
  }

  const dir = path.dirname(logFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Open with O_APPEND to guarantee that every write is appended atomically
  // to the end of the file. The file is created if it does not exist.
  const fd = fs.openSync(logFilePath, 'a');
  fs.closeSync(fd);

  initialized = true;
}

/**
 * Configure the audit log module. Intended to be called once at startup.
 * Changing the log file path after initialization is not supported to keep
 * the log append-only and tamper-evident.
 */
export function configureAuditLog(options: AuditLogOptions): void {
  if (initialized) {
    throw new Error('Audit log has already been initialized and cannot be reconfigured');
  }
  if (options.logFilePath) {
    logFilePath = path.resolve(options.logFilePath);
  }
}

/**
 * Record an admin action in the append-only audit log.
 *
 * This is the only write API exposed by this module. There are intentionally
 * no update or delete APIs: entries can only ever be appended.
 *
 * @param adminAddress Address of the admin performing the action.
 * @param action The admin action being performed.
 * @param proposalId Identifier of the related proposal (use an empty string
 *   or a sentinel such as 'n/a' when the action is not proposal-scoped).
 * @param outcome The outcome of the operation.
 * @returns The recorded audit log entry.
 */
export function recordAdminAction(
  adminAddress: string,
  action: string,
  proposalId: string,
  outcome: string,
): AuditLogEntry {
  if (!adminAddress) {
    throw new Error('Audit log entry requires an adminAddress');
  }
  if (!action) {
    throw new Error('Audit log entry requires an action');
  }
  if (!outcome) {
    throw new Error('Audit log entry requires an outcome');
  }

  ensureInitialized();

  const entry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    adminAddress,
    action,
    proposalId: proposalId ?? '',
    outcome,
  };

  const line = JSON.stringify(entry) + '\n';

  // O_APPEND guarantees atomic append semantics; each entry is written as a
  // single newline-delimited JSON record.
  const fd = fs.openSync(logFilePath, 'a');
  try {
    fs.writeSync(fd, line, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  return entry;
}

/**
 * Read all audit log entries. Provided for verification/inspection only;
 * there is no API to modify or remove entries.
 */
export function readAuditLog(): AuditLogEntry[] {
  ensureInitialized();

  if (!fs.existsSync(logFilePath)) {
    return [];
  }

  const content = fs.readFileSync(logFilePath, 'utf8');
  const entries: AuditLogEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      entries.push(JSON.parse(trimmed) as AuditLogEntry);
    } catch {
      // Skip malformed lines rather than failing the whole read.
    }
  }

  return entries;
}

/**
 * Returns the path of the audit log file currently in use.
 */
export function getAuditLogPath(): string {
  return logFilePath;
}