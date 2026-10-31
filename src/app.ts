import type { Config } from './config.js';
import type { WhatsAppClient } from './whatsapp/client.js';
import type { Telegram } from './team/telegram.js';
import type { BrainStore } from './brain/store.js';
import type { LlmClient } from './brain/claude.js';
import type { ShopifyClient } from './shopify/client.js';
import type { Jobs } from './jobs/types.js';
import type { LeadsMirror } from './leads/mirror.js';

/** Dependency container passed to every module (keeps modules testable with fakes). */
export interface App {
  cfg: Config;
  wa: WhatsAppClient;
  tg: Telegram;
  brain: BrainStore;
  claude: LlmClient;
  shopify: ShopifyClient | null;
  jobs: Jobs;
  mirror: LeadsMirror | null;
  /** injectable for tests */
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
}
