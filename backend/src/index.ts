import { loadEnv } from './env';
import { initErrorTracking, flushErrorTracking } from './errorTracking';
import { createHealthServer } from './health';
import { NotificationService } from './notificationService';
import { logger } from './logger';
import { auditLogger, recordAdminAction } from './auditLogger';

// Validate env vars before anything else — fails fast with a clear message.
const env = loadEnv();

// Must be called before any async work so unhandled rejections are captured.
initErrorTracking();

// Initialize the append-only audit log for admin operations.
auditLogger.init({ logPath: env.AUDIT_LOG_PATH });

const service = new NotificationService({
  rpcUrl: env.STELLAR_RPC_URL,
  contractId: env.GOVERNANCE_CONTRACT_ID,
  webhookUrl: env.WEBHOOK_URL,
  pollIntervalMs: env.POLL_INTERVAL_MS,
});

/**
 * Wrap an admin-level backend operation so that every invocation produces a
 * structured, append-only audit log entry containing timestamp, admin address,
 * action, proposal ID and outcome.
 */
export async function runAdminOperation<T>(
  adminAddress: string,
  action: 'cancel' | 'execute' | 'pause' | 'transfer_admin',
  proposalId: string | number | null,
  operation: () => Promise<T>,
): Promise<T> {
  const timestamp = new Date().toISOString();
  try {
    const result = await operation();
    await recordAdminAction({
      timestamp,
      adminAddress,
      action,
      proposalId,
      outcome: 'success',
    });
    return result;
  } catch (err) {
    await recordAdminAction({
      timestamp,
      adminAddress,
      action,
      proposalId,
      outcome: 'failure',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

const healthServer = createHealthServer(() => service.checkReadiness());
const healthPort = env.HEALTH_PORT;
healthServer.listen(healthPort, '0.0.0.0', () => {
  console.info(`[cosmosvote-backend] health endpoints listening on port ${healthPort}`);
});

service.start();
logger.info({ event: 'startup' }, 'notification service started');

async function shutdown() {
  logger.info({ event: 'shutdown' }, 'notification service stopping');
  service.stop();
  healthServer.close();
  await auditLogger.flush();
  await flushErrorTracking();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);