/**
 * Notification service — polls Horizon/Soroban RPC for contract events
 * and delivers them to configured webhooks.
 */

import axios from 'axios';
import { captureError } from './errorTracking';
import { logger } from './logger';
import { validateWebhookUrl } from './webhookUrlValidator';
import {
  notificationSentTotal,
  notificationFailedTotal,
  webhookLatencySeconds,
  activeSubscriptions,
} from './metrics';

const MAX_POLL_FAILURES = 3;
const MAX_WEBHOOK_RETRIES = 3;
const INITIAL_WEBHOOK_RETRY_DELAY_MS = 1_000;

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  return typeof status === 'number' ? status : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WebhookPayload {
  contractId: string;
  event: string;
  ledger: number;
  data: unknown;
}

export interface NotificationServiceConfig {
  rpcUrl: string;
  contractId: string;
  webhookUrl: string;
  pollIntervalMs?: number;
}

export class NotificationService {
  private consecutiveFailures = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly config: NotificationServiceConfig) {
    activeSubscriptions.inc();
    const validation = validateWebhookUrl(this.config.webhookUrl);
    if (!validation.ok) {
      logger.error(
        {
          event: 'webhook_url_blocked',
          context: 'webhook-registration',
          webhookUrl: this.config.webhookUrl,
          reason: validation.reason,
        },
        'webhook URL rejected by SSRF guard'
      );
      throw new Error(`Blocked webhook URL: ${validation.reason}`);
    }
  }

  async checkReadiness(): Promise<boolean> {
    try {
      const response = await axios.post<{ result?: { status?: string } }>(
        `${this.config.rpcUrl.replace(/\/+$/, '')}/`,
        { jsonrpc: '2.0', id: 1, method: 'getHealth' },
        { timeout: 5_000 }
      );
      return response.data.result?.status === 'healthy';
    } catch {
      return false;
    }
  }

  async pollEvents(): Promise<WebhookPayload[]> {
    try {
      const response = await axios.post<{ events: WebhookPayload[] }>(
        `${this.config.rpcUrl}/getEvents`,
        { contractIds: [this.config.contractId] },
        { timeout: 10_000 }
      );
      this.consecutiveFailures = 0;
      return response.data.events ?? [];
    } catch (err) {
      this.consecutiveFailures += 1;
      const alertThresholdReached = this.consecutiveFailures >= MAX_POLL_FAILURES;
      captureError(err, {
        context: 'event-polling',
        contractId: this.config.contractId,
        consecutiveFailures: this.consecutiveFailures,
        alertThresholdReached,
      });
      if (alertThresholdReached) {
        logger.error(
          {
            event: 'poll_failure_threshold',
            consecutiveFailures: this.consecutiveFailures,
            contractId: this.config.contractId,
          },
          `${this.consecutiveFailures} consecutive poll failures — alert sent`
        );
      } else {
        logger.warn(
          {
            event: 'poll_failure',
            consecutiveFailures: this.consecutiveFailures,
            contractId: this.config.contractId,
            err,
          },
          'event poll failed'
        );
      }
      return [];
    }
  }

  async deliverWebhook(payload: WebhookPayload): Promise<void> {
    for (let attempt = 0; attempt <= MAX_WEBHOOK_RETRIES; attempt += 1) {
      const validation = validateWebhookUrl(this.config.webhookUrl);
      if (!validation.ok) {
        logger.error(
          {
            event: 'webhook_url_blocked',
            context: 'webhook-delivery',
            webhookUrl: this.config.webhookUrl,
            eventType: payload.event,
            reason: validation.reason,
          },
          'webhook delivery skipped: URL rejected by SSRF guard'
        );
        notificationFailedTotal.inc({ contract_id: this.config.contractId });
        return;
      }

      const end = webhookLatencySeconds.startTimer({ contract_id: this.config.contractId });
      try {
        const response = await axios.post(this.config.webhookUrl, payload, {
          timeout: 5_000,
          maxRedirects: 0,
        });
        end({ status_code: String(response.status) });
        notificationSentTotal.inc({ contract_id: this.config.contractId });
        return;
      } catch (err) {
        const statusCode = getHttpStatus(err);
        end({ status_code: statusCode !== undefined ? String(statusCode) : 'error' });
        const status = statusCode === undefined ? 'unknown status' : `HTTP ${statusCode}`;
        const attemptNumber = attempt + 1;
        const message = getErrorMessage(err);

        if (attempt === MAX_WEBHOOK_RETRIES) {
          notificationFailedTotal.inc({ contract_id: this.config.contractId });
          console.error(
            `[notification] Webhook delivery permanently failed after ${attemptNumber} attempts (${status}): ${message}`
          );
          captureError(err, {
            context: 'webhook-delivery',
            webhookUrl: this.config.webhookUrl,
            event: payload.event,
            attempts: attemptNumber,
            statusCode,
          });
          return;
        }

        console.error(
          `[notification] Webhook delivery attempt ${attemptNumber}/${MAX_WEBHOOK_RETRIES + 1} failed (${status}): ${message}`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, INITIAL_WEBHOOK_RETRY_DELAY_MS * 2 ** attempt)
        );
      }
    }
  }

  async runOnce(): Promise<void> {
    const events = await this.pollEvents();
    logger.debug({ event: 'poll_cycle', eventCount: events.length }, 'poll cycle complete');
    for (const event of events) {
      await this.deliverWebhook(event);
    }
  }

  start(): void {
    this.running = true;
    logger.info({ event: 'service_start' }, 'notification service loop started');
    const tick = async () => {
      if (!this.running) return;
      await this.runOnce();
      this.timer = setTimeout(tick, this.config.pollIntervalMs ?? 6_000);
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    activeSubscriptions.dec();
    logger.info({ event: 'service_stop' }, 'notification service loop stopped');
  }
}
