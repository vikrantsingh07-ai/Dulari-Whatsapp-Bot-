import { z } from 'zod';

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().optional(),
  DATABASE_URL: z.string().min(1),

  WHATSAPP_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_BUSINESS_NUMBER: z.string().default(''),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_IS_TEST_NUMBER: bool(true),

  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default('claude-sonnet-5-5'),
  CLAUDE_FAST_MODEL: z.string().default('claude-haiku-5-5'),
  PRICE_MAIN_IN_PER_MTOK: z.coerce.number().optional(),
  PRICE_MAIN_OUT_PER_MTOK: z.coerce.number().optional(),
  PRICE_FAST_IN_PER_MTOK: z.coerce.number().optional(),
  PRICE_FAST_OUT_PER_MTOK: z.coerce.number().optional(),

  BRAIN_SOURCE: z.enum(['sheet', 'file']).default('sheet'),
  BRAIN_SHEET_ID: z.string().optional(),
  LEADS_SHEET_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  SHOPIFY_SHOP_DOMAIN: z.string().optional(),
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),

  // dashboard
  ADMIN_TOKEN: z.string().optional(),
  DASHBOARD_ORIGIN: z.string().optional(),

  // endpoint overrides, used by the local end-to-end test (point at mock servers)
  WHATSAPP_API_BASE: z.string().optional(),
  TELEGRAM_API_BASE: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  GOOGLE_SHEETS_BASE: z.string().optional(),
  GOOGLE_TOKEN_URL: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached && env === process.env) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment. Fix: ${missing}`);
  }
  const cfg = parsed.data;
  // Guard from the spec: local dev must never talk through the real number.
  if (cfg.NODE_ENV !== 'production' && !cfg.WHATSAPP_IS_TEST_NUMBER) {
    throw new Error('Refusing to start: non-production run with WHATSAPP_IS_TEST_NUMBER=false. Use the Meta test number locally.');
  }
  if (env === process.env) cached = cfg;
  return cfg;
}
