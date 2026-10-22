/**
 * CosmosVote Notification Service – Channel plugins
 *
 * Issue #284 – Add support for multiple notification channels
 *
 * Each channel implements the NotificationChannel interface:
 *
 *   interface NotificationChannel {
 *     name: string;
 *     isConfigured(subscriber: Subscriber): boolean;
 *     send(subscriber: Subscriber, event: GovernanceEvent): Promise<void>;
 *   }
 *
 * Adding a new channel is a matter of:
 *  1. Implementing NotificationChannel
 *  2. Adding an instance to CHANNELS below
 *
 * Available channels
 * ──────────────────
 *  • EmailChannel   – SMTP via nodemailer   (subscriber.email)
 *  • WebhookChannel – Generic HTTP POST      (subscriber.webhookUrl)
 *  • SlackChannel   – Slack Incoming Webhook (subscriber.slackWebhookUrl)
 *  • DiscordChannel – Discord Webhook        (subscriber.discordWebhookUrl)
 */

import crypto from 'crypto';
import nodemailer from 'nodemailer';
import axios from 'axios';
import type { GovernanceEvent, Subscriber } from './types';
import { renderEmailNotification } from './emailTemplates';
import { validateWebhookUrl, BlockedUrlError } from './ssrfGuard';

// ── Plugin interface ──────────────────────────────────────────────────────────

export interface NotificationChannel {
  /** Human-readable channel name used in logs and error messages */
  readonly name: string;

  /** Returns true when the subscriber has provided the credentials/URL for this channel */
  isConfigured(subscriber: Subscriber): boolean;

  /** Deliver the notification. Throws on failure. */
  send(subscriber: Subscriber, event: GovernanceEvent): Promise<void>;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function buildTextMessage(event: GovernanceEvent): string {
  const labels: Record<string, string> = {
    created: 'A new governance proposal has been created.',
    voted:   'A vote has been cast on a proposal.',
    final:   'A proposal has been finalized.',
    exec:    'A proposal has been executed.',
    cancel:  'A proposal has been cancelled.',
  };
  const base = labels[event.type] ?? `Governance event: ${event.type}`;
  return event.proposalId
    ? `${base}\nProposal ID: ${event.proposalId}\nLedger: ${event.ledger}`
    : `${base}\nLedger: ${event.ledger}`;
}

function buildSubjectLine(event: GovernanceEvent): string {
  const verb: Record<string, string> = {
    created: 'created',
    voted:   'vote cast on',
    final:   'finalized',
    exec:    'executed',
    cancel:  'cancelled',
  };
  const action = verb[event.type] ?? event.type;
  return event.proposalId
    ? `CosmosVote: proposal #${event.proposalId} ${action}`
    : `CosmosVote: proposal ${action}`;
}

/**
 * Registration-time SSRF validation for every subscriber-supplied webhook URL.
 * Throws a BlockedUrlError (403-mappable) when any URL is unsafe.
 */
export function validateChannelUrls(subscriber: Subscriber): void {
  const urls: Array<string | undefined> = [
    subscriber.webhookUrl,
    subscriber.slackWebhookUrl,
    subscriber.discordWebhookUrl,
  ];
  for (const url of urls) {
    if (url) validateWebhookUrl(url);
  }
}

/**
 * Delivery-time SSRF validation. Re-resolves the hostname immediately before
 * the request to defeat DNS rebinding. Throws a BlockedUrlError on failure.
 */
async function assertDeliverable(url: string): Promise<void> {
  try {
    await validateWebhookUrl(url);
  } catch (err) {
    if (err instanceof BlockedUrlError) throw err;
    throw new BlockedUrlError(url, (err as Error)?.message ?? 'URL validation failed');
  }
}

// ── Email channel ─────────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const EmailChannel: NotificationChannel = {
  name: 'email',

  isConfigured(subscriber) {
    return !!subscriber.email;
  },

  async send(subscriber, event) {
    if (!subscriber.email) return;
    const email = renderEmailNotification(event);
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: subscriber.email,
      subject: buildSubjectLine(event),
      text: email.text,
      html: email.html,
    });
  },
};

// ── Webhook request signing ───────────────────────────────────────────────────
//
// Every webhook delivery is signed with HMAC-SHA256 so subscribers can verify
// that the request originated from CosmosVote and was not tampered with.
//
// Headers sent with each delivery:
//   X-CosmosVote-Signature  – hex HMAC-SHA256 of `${timestamp}.${rawBody}`
//   X-CosmosVote-Timestamp  – Unix timestamp (ms) used in the signature
//
// The shared secret is read from the WEBHOOK_SIGNING_SECRET env var. Rotate it
// as part of the key rotation procedure; subscribers should accept both the
// current and previous secret during a rotation window.
//
// Subscriber verification (Node.js example):
//
//   import crypto from 'crypto';
//
//   const timestamp = req.headers['x-cosmosvote-timestamp'];
//   const signature = req.headers['x-cosmosvote-signature'];
//   const rawBody   = req.rawBody.toString('utf8'); // exact bytes received
//
//   // Reject replayed requests older than 5 minutes
//   if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) {
//     return res.status(401).send('stale timestamp');
//   }
//
//   const expected = crypto
//     .createHmac('sha256', process.env.WEBHOOK_SIGNING_SECRET)
//     .update(`${timestamp}.${rawBody}`)
//     .digest('hex');
//
//   const valid = crypto.timingSafeEqual(
//     Buffer.from(expected, 'hex'),
//     Buffer.from(signature, 'hex'),
//   );
//   if (!valid) return res.status(401).send('invalid signature');

/** Returns the shared webhook signing secret, or throws if it is not configured. */
export function getWebhookSigningSecret(): string {
  const secret = process.env.WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    throw new Error('WEBHOOK_SIGNING_SECRET is not configured');
  }
  return secret;
}

/**
 * Computes the HMAC-SHA256 signature for a webhook delivery.
 *
 * The signed message is `${timestamp}.${body}` where `body` is the exact JSON
 * string sent as the request body. Returns the signature as a lowercase hex string.
 */
export function computeWebhookSignature(
  timestamp: string | number,
  body: string,
  secret: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

// ── Generic webhook channel ───────────────────────────────────────────────────

export const WebhookChannel: NotificationChannel = {
  name: 'webhook',

  isConfigured(subscriber) {
    if (!subscriber.webhookUrl) return false;
    validateWebhookUrl(subscriber.webhookUrl);
    return true;
  },

  async send(subscriber, event) {
    if (!subscriber.webhookUrl) return;

    const body = JSON.stringify({ event });
    const timestamp = Date.now().toString();
    const signature = computeWebhookSignature(
      timestamp,
      body,
      getWebhookSigningSecret(),
    );

    await axios.post(
      subscriber.webhookUrl,
      body,
      {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          'X-CosmosVote-Signature': signature,
          'X-CosmosVote-Timestamp': timestamp,
        },
      },
    );
  },
};

// ── Slack channel ─────────────────────────────────────────────────────────────
// Uses Slack Incoming Webhooks (https://api.slack.com/messaging/webhooks).
// Configure with: SLACK_WEBHOOK_URL env var (global), or subscriber.slackWebhookUrl.

export const SlackChannel: NotificationChannel = {
  name: 'slack',

  isConfigured(subscriber) {
    const url = subscriber.slackWebhookUrl ?? process.env.SLACK_WEBHOOK_URL;
    if (!url) return false;
    validateWebhookUrl(url);
    return true;
  },

  async send(subscriber, event) {
    const url = subscriber.slackWebhookUrl ?? process.env.SLACK_WEBHOOK_URL;
    if (!url) return;
    await assertDeliverable(url);

    const text = buildTextMessage(event);
    const emoji: Record<string, string> = {
      created: ':memo:',
      voted:   ':ballot_box:',
      final:   ':checkered_flag:',
      exec:    ':rocket:',
      cancel:  ':x:',
    };
    const icon = emoji[event.type] ?? ':bell:';

    await axios.post(
      url,
      {
        text: `${icon} *CosmosVote* — ${buildSubjectLine(event)}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${icon} *${buildSubjectLine(event)}*\n\`\`\`${text}\`\`\``,
            },
          },
        ],
      },
      { timeout: 10_000 },
    );
  },
};

// ── Discord channel ───────────────────────────────────────────────────────────
// Uses Discord Webhook Execute (https://discord.com/developers/docs/resources/webhook).
// Configure with: DISCORD_WEBHOOK_URL env var (global), or subscriber.discordWebhookUrl.

export const DiscordChannel: NotificationChannel = {
  name: 'discord',

  isConfigured(subscriber) {
    const url = subscriber.discordWebhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
    if (!url) return false;
    validateWebhookUrl(url);
    return true;
  },

  async send(subscriber, event) {
    const url = subscriber.discordWebhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
    if (!url) return;
    await assertDeliverable(url);

    const text = buildTextMessage(event);
    await axios.post(
      url,
      {
        content: `**CosmosVote** — ${buildSubjectLine(event)}\n\`\`\`\n${text}\n\`\`\``,
      },
      { timeout: 10_000 },
    );
  },
};

// ── Channel registry ──────────────────────────────────────────────────────────
// Add new channel implementations here to enable them automatically.

export const CHANNELS: NotificationChannel[] = [
  EmailChannel,
  WebhookChannel,
  SlackChannel,
  DiscordChannel,
];
