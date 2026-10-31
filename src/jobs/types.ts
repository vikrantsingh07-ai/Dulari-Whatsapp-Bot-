/**
 * Delayed work. Everything for one customer runs inside that customer's Durable Object (addressed by wa_id),
 * which serialises it: that is the "one lock per conversation".
 */
export interface Jobs {
  /** Arm (or push back) the conversation's reply timer. The latest call wins, which is exactly the batching rule. */
  scheduleReply(waId: string, conversationId: string, dueAt: Date): Promise<void>;
  scheduleEchoCheck(payload: EchoPayload, delaySeconds: number): Promise<void>;
  scheduleMediaDownload(waId: string, mediaId: string): Promise<void>;
  scheduleFollowup(waId: string, followupId: string, dueAt: Date): Promise<void>;
  scheduleHolding(waId: string, conversationId: string, delaySeconds: number): Promise<void>;
  scheduleResend(waId: string, waMessageId: string, delaySeconds: number): Promise<void>;
}
export interface EchoPayload { waMessageId: string; to: string; type: string; text?: string; timestamp: string }
