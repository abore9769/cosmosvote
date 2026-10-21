/**
 * Environment variable schema validation using Zod.
 *
 * Call `loadEnv()` once at startup (before any other imports that read
 * process.env).  If any required variable is missing or invalid the process
 * exits immediately with a descriptive error listing every problem.
 *
 * Add new variables here and document them in backend/.env.example.
 */

import { z } from 'zod';

const envSchema = z.object({
  // ── Core service ──────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(['development', 'staging', 'production'])
    .default('development'),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  APP_VERSION: z.string().optional(),

  // ── Stellar / contract ────────────────────────────────────────────────────
  STELLAR_RPC_URL: z.string().url().default('http://localhost:8000'),

  GOVERNANCE_CONTRACT_ID: z.string().min(1, 'GOVERNANCE_CONTRACT_ID is required'),

  WEBHOOK_URL: z.string().url('WEBHOOK_URL must be a valid URL'),

  POLL_INTERVAL_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 6_000))
    .refine((n) => Number.isInteger(n) && n > 0, 'POLL_INTERVAL_MS must be a positive integer'),

  // ── Health server ─────────────────────────────────────────────────────────
  HEALTH_PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 8080))
    .refine((n) => Number.isInteger(n) && n >= 1 && n <= 65535, 'HEALTH_PORT must be 1–65535'),

  // ── Error tracking ────────────────────────────────────────────────────────
  SENTRY_DSN: z.string().url().optional().or(z.literal('')),

  // ── CORS ──────────────────────────────────────────────────────────────────
  ALLOWED_ORIGINS: z.string().optional(),

  // ── Audit log ─────────────────────────────────────────────────────────────
  AUDIT_LOG_PATH: z
    .string()
    .min(1, 'AUDIT_LOG_PATH must not be empty')
    .default('./data/audit.log'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validate process.env against the schema.
 * Exits the process on failure so startup fails fast with a clear message.
 */
export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    process.stderr.write(
      `[cosmosvote-backend] Invalid environment configuration — startup aborted.\n${issues}\n`,
    );
    process.exit(1);
  }

  return result.data;
}
