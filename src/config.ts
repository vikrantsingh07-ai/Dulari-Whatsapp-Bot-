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

  // AI provider: OpenRouter or Anthropic. Default = whichever key is present (OpenRouter wins if both).
  LLM_PROVIDER: z.enum(['anthropic', 'openrouter']).optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_FAST_MODEL: z.string().optional(),
  CLAUDE_MODEL: z.string().optional(), // old name, still accepted
  CLAUDE_FAST_MODEL: z.string().optional(),
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

type Parsed = z.infer<typeof schema>;
/** CLAUDE_MODEL / CLAUDE_FAST_MODEL hold the resolved model ids for whichever provider is active. */
export type Config = Omit<Parsed, 'LLM_PROVIDER' | 'CLAUDE_MODEL' | 'CLAUDE_FAST_MODEL'> & { LLM_PROVIDER: 'anthropic' | 'openrouter'; CLAUDE_MODEL: string; CLAUDE_FAST_MODEL: string };

export const DEFAULT_MODELS = {
  anthropic: { main: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5' },
  // openrouter/free lets OpenRouter pick any free model that can do tool calls. Pick a fixed model for a steady tone.
  openrouter: { main: 'openrouter/free', fast: 'openrouter/free' },
} as const;

let cached: Config | undefined;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached && env === process.env) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment. Fix: ${missing}`);
  }
  const p = parsed.data;
  const provider = p.LLM_PROVIDER ?? (p.OPENROUTER_API_KEY ? 'openrouter' : 'anthropic');
  if (provider === 'openrouter' && !p.OPENROUTER_API_KEY) throw new Error('Invalid environment. Fix: OPENROUTER_API_KEY');
  if (provider === 'anthropic' && !p.ANTHROPIC_API_KEY) throw new Error('Invalid environment. Fix: ANTHROPIC_API_KEY');
  const cfg: Config = {
    ...p, LLM_PROVIDER: provider,
    CLAUDE_MODEL: p.LLM_MODEL ?? p.CLAUDE_MODEL ?? DEFAULT_MODELS[provider].main,
    CLAUDE_FAST_MODEL: p.LLM_FAST_MODEL ?? p.CLAUDE_FAST_MODEL ?? DEFAULT_MODELS[provider].fast,
  };
  // Guard from the spec: local dev must never talk through the real number.
  if (cfg.NODE_ENV !== 'production' && !cfg.WHATSAPP_IS_TEST_NUMBER) {
    throw new Error('Refusing to start: non-production run with WHATSAPP_IS_TEST_NUMBER=false. Use the Meta test number locally.');
  }
  if (env === process.env) cached = cfg;
  return cfg;
}
