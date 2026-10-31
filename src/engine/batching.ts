/**
 * Rule 1 "Listen before replying": every inbound message (re)schedules the reply
 * `batchSeconds` later; the timer resets on each new message but never runs past
 * `maxSeconds` after the FIRST message of the batch.
 */
export function computeReplyDue(opts: {
  now: Date;
  firstPendingAt: Date | null;
  batchSeconds: number;
  maxSeconds: number;
}): { dueAt: Date; firstPendingAt: Date } {
  const first = opts.firstPendingAt ?? opts.now;
  const wanted = opts.now.getTime() + opts.batchSeconds * 1000;
  const cap = first.getTime() + opts.maxSeconds * 1000;
  return { dueAt: new Date(Math.min(wanted, cap)), firstPendingAt: first };
}
