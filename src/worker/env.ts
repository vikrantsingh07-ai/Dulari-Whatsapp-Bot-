import type { ChatDO } from './chat-do.js';

/** Cloudflare bindings + vars/secrets. Config keys are validated by src/config.ts. */
export interface Env {
  HYPERDRIVE: Hyperdrive;
  CHAT: DurableObjectNamespace<ChatDO>;
  [key: string]: any;
}
