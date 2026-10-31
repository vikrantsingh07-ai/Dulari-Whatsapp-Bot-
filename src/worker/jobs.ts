import type { EchoPayload, Jobs } from '../jobs/types.js';
import type { ChatDO } from './chat-do.js';

/** Jobs backed by one Durable Object per customer (named by wa_id). */
export class DoJobs implements Jobs {
  constructor(private ns: DurableObjectNamespace<ChatDO>) {}
  private stub(waId: string) { return this.ns.get(this.ns.idFromName(waId)); }
  private at(delaySeconds: number) { return Date.now() + delaySeconds * 1000; }

  scheduleReply(waId: string, conversationId: string, dueAt: Date) {
    // key 'reply': a newer message replaces the pending timer, which is the "reset the 8s timer" rule
    return this.stub(waId).schedule({ key: 'reply', kind: 'reply', at: dueAt.getTime(), payload: { conversationId } });
  }
  scheduleEchoCheck(p: EchoPayload, delaySeconds: number) {
    return this.stub(p.to).schedule({ key: `echo:${p.waMessageId}`, kind: 'echo', at: this.at(delaySeconds), payload: p });
  }
  scheduleMediaDownload(waId: string, mediaId: string) {
    return this.stub(waId).schedule({ key: `media:${mediaId}`, kind: 'media', at: Date.now(), payload: { mediaId } });
  }
  scheduleFollowup(waId: string, followupId: string, dueAt: Date) {
    return this.stub(waId).schedule({ key: `followup:${followupId}`, kind: 'followup', at: dueAt.getTime(), payload: { followupId } });
  }
  scheduleHolding(waId: string, conversationId: string, delaySeconds: number) {
    return this.stub(waId).schedule({ key: 'holding', kind: 'holding', at: this.at(delaySeconds), payload: { conversationId } });
  }
  scheduleResend(waId: string, waMessageId: string, delaySeconds: number) {
    return this.stub(waId).schedule({ key: `resend:${waMessageId}`, kind: 'resend', at: this.at(delaySeconds), payload: { waMessageId } });
  }
}
