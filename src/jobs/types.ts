export interface Jobs {
  /** (Re)schedule the conversation's reply job at `dueAt`. Stale jobs no-op, see runReply. */
  scheduleReply(conversationId: string, dueAt: Date): Promise<void>;
  scheduleEchoCheck(payload: EchoPayload, delaySeconds: number): Promise<void>;
  scheduleMediaDownload(mediaId: string): Promise<void>;
  scheduleFollowup(followupId: string, dueAt: Date): Promise<void>;
  scheduleHolding(conversationId: string, delaySeconds: number): Promise<void>;
  scheduleResend(waMessageId: string, delaySeconds: number): Promise<void>;
}
export interface EchoPayload { waMessageId: string; to: string; type: string; text?: string; timestamp: string }
