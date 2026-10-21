/**
 * CosmosVote Notification Service – CLI entry point
 *
 * Issue #284 – multi-channel support
 * Issue #43  – graceful shutdown with in-flight request draining
 *
 * Usage:
 *   npx ts-node src/index.ts start
 *
 *   # Subscribe via email
 *   npx ts-node src/index.ts subscribe --email user@example.com --events created,final
 *
 *   # Subscribe via generic webhook
 *   npx ts-node src/index.ts subscribe --webhook https://example.com/hook --events created,voted,final,exec,cancel
 *
 *   # Subscribe via Slack Incoming Webhook
 *   npx ts-node src/index.ts subscribe --slack https://hooks.slack.com/services/... --events created,final
 *
 *   # Subscribe via Discord Webhook
 *   npx ts-node src/index.ts subscribe --discord https://discord.com/api/webhooks/... --events final,exec
 *
 *   # Mix channels in a single subscriber
 *   npx ts-node src/index.ts subscribe \
 *     --email alert@example.com \
 *     --slack https://hooks.slack.com/services/... \
 *     --events created,final
 *
 *   # Filter by proposal
 *   npx ts-node src/index.ts subscribe --email user@example.com --proposal-id 42 --events final
 *
 *   npx ts-node src/index.ts unsubscribe <id>
 *   npx ts-node src/index.ts list
 */

import 'fs'; // ensure Node built-ins are available before dotenv

// Load .env if present
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
} catch {
  // dotenv is optional
}

import { startWatcher, stopWatcher } from './watcher';
import { addSubscriber, removeSubscriber, listSubscribers } from './subscriptions';
import { GovernanceEventType } from './types';
import { validateWebhookUrl } from './ssrf';

const ALL_EVENTS: GovernanceEventType[] = ['created', 'voted', 'final', 'exec', 'cancel'];

/** Grace period (ms) to wait for in-flight webhook deliveries and DB writes. */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 30_000);

function parseArgs(): { cmd: string; args: string[] } {
  const [, , cmd = 'start', ...args] = process.argv;
  return { cmd, args };
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function parseEvents(raw?: string): GovernanceEventType[] {
  if (!raw) return ALL_EVENTS;
  return raw.split(',').map((e) => e.trim() as GovernanceEventType);
}

/**
 * Flush the error-tracking service before exit.
 *
 * In production this would call e.g. Sentry.flush() or Datadog's drain.
 * We expose a generic hook here so callers can inject the real flush.
 */
async function flushErrorTracking(): Promise<void> {
  try {
    // Dynamically require so the service is only imported when wired up.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tracking = require('./errorTracking');
    if (typeof tracking?.flush === 'function') {
      await Promise.resolve(tracking.flush());
    }
  } catch {
    // Error-tracking integration is optional; never block shutdown.
  }
}

/**
 * Graceful shutdown handler.
 *
 * 1. Signal the watcher to stop scheduling new polls.
 * 2. Wait up to SHUTDOWN_TIMEOUT_MS for in-flight deliveries to complete.
 * 3. Flush the error-tracking service.
 * 4. Exit with the supplied code.
 */
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  console.log(`\n[shutdown] Received ${signal}. Initiating graceful shutdown (timeout: ${SHUTDOWN_TIMEOUT_MS}ms)…`);

  // Step 1: ask the watcher to stop scheduling new polls and wait for the
  //         current in-flight poll (and any pending webhook deliveries) to finish.
  const drainPromise = stopWatcher();

  // Step 2: race the drain against the hard timeout.
  const timeoutPromise = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      console.warn(`[shutdown] Timeout reached after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit.`);
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
    // Allow the Node.js event loop to exit even if the timeout fires.
    if (t.unref) t.unref();
  });

  await Promise.race([drainPromise, timeoutPromise]);

  // Step 3: flush error tracking (best-effort, bounded by its own internal timeout).
  await flushErrorTracking();

  console.log('[shutdown] Shutdown complete.');
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Register OS signal handlers only when running the `start` command.
// ---------------------------------------------------------------------------
function registerSignalHandlers(): void {
  // SIGTERM is sent by process managers (Docker, systemd, Kubernetes).
  process.once('SIGTERM', () => void shutdown('SIGTERM', 0));

  // SIGINT is sent when the user presses Ctrl+C in a terminal.
  process.once('SIGINT', () => void shutdown('SIGINT', 0));
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs();

  switch (cmd) {
    case 'start':
      registerSignalHandlers();
      await startWatcher();
      break;

    case 'subscribe': {
      const email          = flag(args, 'email');
      const webhookUrl     = flag(args, 'webhook');
      const slackWebhookUrl   = flag(args, 'slack');
      const discordWebhookUrl = flag(args, 'discord');
      const proposalId     = flag(args, 'proposal-id');
      const events         = parseEvents(flag(args, 'events'));

      if (!email && !webhookUrl && !slackWebhookUrl && !discordWebhookUrl) {
        console.error(
          'Error: at least one channel is required.\n' +
          'Use: --email <addr>, --webhook <url>, --slack <url>, or --discord <url>',
        );
        process.exit(1);
      }

      // SSRF prevention (issue #116): validate every webhook URL at
      // registration time. Delivery-time validation is enforced separately.
      const webhookChannels: Array<[string, string | undefined]> = [
        ['--webhook', webhookUrl],
        ['--slack', slackWebhookUrl],
        ['--discord', discordWebhookUrl],
      ];
      for (const [flagName, url] of webhookChannels) {
        if (!url) continue;
        const result = await validateWebhookUrl(url);
        if (!result.ok) {
          console.error(`Error: ${flagName} URL rejected (403 Forbidden): ${result.reason}`);
          process.exit(1);
        }
      }

      const subscriber = addSubscriber({
        email,
        webhookUrl,
        slackWebhookUrl,
        discordWebhookUrl,
        proposalId,
        events,
      });
      console.log('Subscriber added:');
      console.log(JSON.stringify(subscriber, null, 2));
      break;
    }

    case 'unsubscribe': {
      const id = args[0];
      if (!id) { console.error('Usage: unsubscribe <id>'); process.exit(1); }
      const removed = removeSubscriber(id);
      console.log(removed ? `Removed subscriber ${id}` : `No subscriber found with id ${id}`);
      break;
    }

    case 'list':
      console.log(JSON.stringify(listSubscribers(), null, 2));
      break;

    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
