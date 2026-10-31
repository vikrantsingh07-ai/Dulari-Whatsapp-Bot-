import { buildApp, runDb } from './worker/app.js';
import { DoJobs } from './worker/jobs.js';
import { runCron } from './worker/cron.js';
import { buildServer } from './webhook/routes.js';
import type { Env } from './worker/env.js';

export { ChatDO } from './worker/chat-do.js';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = buildApp(env, new DoJobs(env.CHAT));
    const server = buildServer(app, {
      db: (fn) => runDb(env, app, fn),
      waitUntil: (p) => ctx.waitUntil(p),
    });
    return server.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const app = buildApp(env, new DoJobs(env.CHAT));
    ctx.waitUntil(runDb(env, app, () => runCron(app, controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
