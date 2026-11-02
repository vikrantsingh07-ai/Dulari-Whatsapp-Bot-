import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DB_URL, inbound, makeApp, reply, setupDb, teardownDb, toolUse } from './harness.js';
import { query } from '../../src/db/client.js';
import { handleEcho, handleEvents, handleInbound } from '../../src/webhook/ingest.js';
import { runReply } from '../../src/engine/reply.js';
import { getConversationByContactWa, setBotMode, setPendingPlan } from '../../src/db/repo.js';
import { sendHoldingLine, expireHumanMode, sendFollowup } from '../../src/engine/proactive.js';
import { handleTelegramUpdate } from '../../src/team/commands.js';
import { testChat } from '../../src/admin-chat.js';

const run = DB_URL ? describe : describe.skip;
const WA = '919999900001';
const texts = (sent: any[]) => sent.filter((s) => s.kind === 'text').map((s) => s.body);

run('pipeline (real Postgres, fake WhatsApp/Telegram/Claude)', () => {
  beforeAll(setupDb);
  afterAll(teardownDb);
  beforeEach(async () => { await query('truncate contacts cascade'); });

  it('batches a burst into one reply and never double-replies', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('hi'));
    t.clock.advance(2000);
    await handleInbound(t.app, inbound('daily table price?'));
    t.clock.advance(2000);
    await handleInbound(t.app, inbound('and delivery to gurgaon'));
    const conv = (await getConversationByContactWa(WA))!;
    // last message at +4s, due 8s after it, within the 25s cap
    expect(conv.reply_due_at!.getTime() - t.clock.now().getTime()).toBeGreaterThan(7000);
    // an early job (before due) does nothing
    t.script.push(reply({ messages: ['x'] }));
    await runReply(t.app, conv.id);
    expect(t.sent).toEqual([]);
    expect(t.claudeCalls).toHaveLength(0);
    t.script.length = 0;

    t.clock.advance(9000);
    t.script.push(
      toolUse('lookup_product', { query: 'daily table' }),
      reply({ messages: ['The Daily Table is Rs 9500, solid teak with a hand-rubbed finish.', 'Delivery in Gurgaon is free. Which room is it for?'] }),
    );
    await runReply(t.app, conv.id);
    expect(texts(t.sent)).toEqual(['The Daily Table is Rs. 9,500, solid teak with a hand-rubbed finish.', 'Delivery in Gurgaon is free. Which room is it for?']);
    expect(t.claudeCalls).toHaveLength(2); // one tool round trip, one answer
    // the batch (3 messages) reached Claude together
    const firstUser = JSON.stringify(t.claudeCalls[0].messages);
    expect(firstUser).toContain('hi'); expect(firstUser).toContain('daily table price?'); expect(firstUser).toContain('gurgaon');

    // a second job for the same chat finds nothing to do
    t.script.push(reply({ messages: ['dup'] }));
    await runReply(t.app, conv.id);
    expect(texts(t.sent)).toHaveLength(2);
  });

  it('drops duplicate webhooks', async () => {
    const t = makeApp();
    const m = inbound('hello');
    await handleInbound(t.app, m);
    await handleInbound(t.app, m);
    const [{ n }] = await query('select count(*) n from messages');
    expect(Number(n)).toBe(1);
  });

  it('reacts to "thanks" without calling Claude or asking anything', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('thanks'));
    t.clock.advance(9000);
    const conv = (await getConversationByContactWa(WA))!;
    await runReply(t.app, conv.id);
    expect(t.claudeCalls).toHaveLength(0);
    expect(t.sent).toEqual([{ kind: 'reaction', to: WA, emoji: '🙏' }]);
  });

  it('goes silent when a team member replies from the phone (echo), and stays silent', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('hello'));
    const conv = (await getConversationByContactWa(WA))!;
    await handleEcho(t.app, { waMessageId: 'wamid.ECHO1', to: WA, type: 'text', text: 'Hi Riya, Akash here', timestamp: new Date().toISOString() });
    expect((await getConversationByContactWa(WA))!.bot_mode).toBe('human');
    t.clock.advance(9000);
    await runReply(t.app, conv.id);
    await handleInbound(t.app, inbound('ok send me details'));
    t.clock.advance(9000);
    await runReply(t.app, conv.id);
    expect(t.sent).toEqual([]); // no replies, no read receipts, no typing
    expect(t.claudeCalls).toHaveLength(0);
    // our own bot messages echoing back must not flip the mode
    const [{ n }] = await query('select count(*) n from messages where direction = $1', ['echo']);
    expect(Number(n)).toBe(1);
  });

  it('echo of a message the bot itself sent is ignored', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('daily table?'));
    const conv = (await getConversationByContactWa(WA))!;
    t.clock.advance(9000);
    t.script.push(reply({ messages: ['Rs 9500.'] }));
    await runReply(t.app, conv.id);
    await handleEcho(t.app, { waMessageId: 'wamid.OUT1', to: WA, type: 'text', text: 'Rs. 9,500.', timestamp: new Date().toISOString() });
    expect((await getConversationByContactWa(WA))!.bot_mode).toBe('auto');
  });

  it('handoff: human mode, handoff row, Telegram alert with a real reply-by time', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('Hi, interior designer here. 14 binge chairs for a cafe in Noida, trade pricing?'));
    const conv = (await getConversationByContactWa(WA))!;
    t.clock.advance(9000);
    t.script.push(
      toolUse('update_lead', { type: 'trade', city: 'Noida', quantity: '14', products: ['Binge Chair'], project_type: 'cafe' }, 'a'),
      toolUse('handoff', { reason: 'trade pricing, quantity 14', urgency: 'hot', summary: 'Riya, interior designer\n14 Binge Chairs for a Noida cafe\nAsked trade pricing' }, 'b'),
      reply({ messages: ["Got it, 14 for a Noida cafe. Trade pricing comes from Akash directly, I've passed him this."] }),
    );
    await runReply(t.app, conv.id);
    const after = (await getConversationByContactWa(WA))!;
    expect(after.bot_mode).toBe('human');
    const [h] = await query('select * from handoffs');
    expect(h.urgency).toBe('hot');
    const [lead] = await query('select * from leads');
    expect(lead).toMatchObject({ type: 'trade', city: 'Noida', hot: true });
    expect(lead.products).toEqual(['Binge Chair']);
    const alert = t.tgMessages.find((m) => m.text.includes('HOT'));
    expect(alert?.text).toMatch(/HOT · Trade · Noida/);
    expect(alert?.text).toMatch(/Promised reply by: .*(today|tomorrow|on )/);
    expect(JSON.stringify(alert?.buttons)).toContain('take:');
    // the tool result gave Claude the honest time to quote
    const toolResultTurn = JSON.stringify(t.claudeCalls[2].messages.at(-1));
    expect(toolResultTurn).toContain('reply_by');
  });

  it('throws the draft away if a new message arrives while Claude is writing', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('daily table price'));
    const conv = (await getConversationByContactWa(WA))!;
    t.clock.advance(9000);
    t.script.push(async () => {
      await handleInbound(t.app, inbound('actually the binge chair too')); // lands mid-generation
      return reply({ messages: ['stale answer about the table only'] })();
    });
    await runReply(t.app, conv.id);
    expect(texts(t.sent)).toEqual([]);
    // the new message re-armed the timer so the next job answers both together
    t.clock.advance(9000);
    t.script.push(reply({ messages: ['Table is Rs 9500 and the chair is Rs 11000. Where is it going?'] }));
    await runReply(t.app, conv.id);
    expect(texts(t.sent)).toEqual(['Table is Rs. 9,500 and the chair is Rs. 11,000. Where is it going?']);
    expect(JSON.stringify(t.claudeCalls.at(-1).messages)).toContain('actually the binge chair too');
  });

  it('rewrites banned phrases once with Haiku, and falls back to a plain version', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('tell me about the daily table'));
    const conv = (await getConversationByContactWa(WA))!;
    t.clock.advance(9000);
    t.script.push(
      reply({ messages: ['Certainly! It is stunning. Solid teak.'] }),
      () => ({ content: [{ type: 'text', text: 'Solid teak with a hand-rubbed finish.' }], stop_reason: 'end_turn', usage: {} }),
    );
    await runReply(t.app, conv.id);
    expect(texts(t.sent)).toEqual(['Solid teak with a hand-rubbed finish.']);
    expect(t.claudeCalls[1].model).toBe('fast');

    // Haiku also fails the check -> plain version without the phrase
    await query('truncate contacts cascade');
    const t2 = makeApp();
    await handleInbound(t2.app, inbound('tell me about the daily table'));
    const c2 = (await getConversationByContactWa(WA))!;
    t2.clock.advance(9000);
    t2.script.push(
      reply({ messages: ['It is stunning. Solid teak.'] }),
      () => ({ content: [{ type: 'text', text: 'Truly stunning teak.' }], stop_reason: 'end_turn', usage: {} }),
    );
    await runReply(t2.app, c2.id);
    expect(texts(t2.sent)).toEqual(['Solid teak.']);
  });

  it('shadow mode posts a draft to Telegram and sends nothing to the customer', async () => {
    const t = makeApp({ settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00'], ['SHADOW_MODE', 'TRUE']] });
    await handleInbound(t.app, inbound('daily table price?'));
    const conv = (await getConversationByContactWa(WA))!;
    t.clock.advance(9000);
    t.script.push(reply({ messages: ['Rs 9500, solid teak. Which city?'] }));
    await runReply(t.app, conv.id);
    expect(t.sent).toEqual([]);
    expect(t.tgMessages[0]!.text).toContain('Draft');
    expect(JSON.stringify(t.tgMessages[0]!.buttons)).toContain('draft_up');
    const [d] = await query('select * from drafts');
    expect(d.customer_text).toBe('daily table price?');
  });

  it('Claude failing twice then Haiku failing -> one honest line, human mode, alert', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('daily table price?'));
    const conv = (await getConversationByContactWa(WA))!;
    t.clock.advance(9000);
    for (let i = 0; i < 3; i++) t.script.push(() => { throw new Error('overloaded'); });
    await runReply(t.app, conv.id);
    expect(texts(t.sent)).toEqual(['Give me a few minutes on this one.']);
    expect((await getConversationByContactWa(WA))!.bot_mode).toBe('human');
    expect(t.tgMessages.some((m) => m.text.includes('bot error'))).toBe(true);
    expect(t.claudeCalls.map((c) => c.model)).toEqual(['main', 'main', 'fast']);
  });

  it('opt-out: confirm once, never message again', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('stop'));
    const conv = (await getConversationByContactWa(WA))!;
    t.clock.advance(9000);
    await runReply(t.app, conv.id);
    expect(texts(t.sent)).toEqual(["Done, I won't message you again."]);
    await handleInbound(t.app, inbound('hello again'));
    const after = (await getConversationByContactWa(WA))!;
    expect(after.reply_due_at).toBeNull();
    expect(t.claudeCalls).toHaveLength(0);
  });

  it('kill switch (BOT_ENABLED=FALSE) means nothing, everywhere', async () => {
    const t = makeApp({ settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00'], ['BOT_ENABLED', 'FALSE']] });
    await handleInbound(t.app, inbound('hello'));
    expect((await getConversationByContactWa(WA))!.reply_due_at).toBeNull();
    expect(t.scheduled).toHaveLength(0);
  });

  it('voice notes: honest line + handoff', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('', WA, { type: 'audio', mediaId: 'm1', isVoice: true, text: undefined }));
    const conv = (await getConversationByContactWa(WA))!;
    t.clock.advance(9000);
    await runReply(t.app, conv.id);
    expect(texts(t.sent)[0]).toMatch(/^Got your voice note, passing it to the team\. They'll reply here by/);
    expect((await getConversationByContactWa(WA))!.bot_mode).toBe('human');
    expect(t.claudeCalls).toHaveLength(0);
  });

  it('photo bubbles: photo goes before the closing question, link is real', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('Hi, I would like to inquire about: Daily Table https://dulari.design/products/mini-table'));
    const conv = (await getConversationByContactWa(WA))!;
    t.clock.advance(9000);
    t.script.push(
      toolUse('send_product_photo', { product: 'mini-table', caption: 'Daily Table, teak' }),
      reply({ messages: ['Hi! The Daily Table is Rs 9500, solid teak.', 'Where would it be going?'] }),
    );
    await runReply(t.app, conv.id);
    expect(t.sent.filter((s) => s.kind !== 'read').map((s) => s.kind)).toEqual(['text', 'image', 'text']);
    expect(t.sent.find((s) => s.kind === 'image')!.body).toContain('https://img.test/daily1.jpg');
    const [lead] = await query('select * from leads');
    expect(lead.source).toBe('website_enquire');
  });

  it('Telegram /release hands the chat back, /forget deletes everything', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('hello'));
    const conv = (await getConversationByContactWa(WA))!;
    await setBotMode(conv.id, 'human', 'test');
    await handleTelegramUpdate(t.app, { message: { message_id: 5, chat: { id: -100 }, text: `/release ${WA}`, from: { id: 1, username: 'akash' } } });
    expect((await getConversationByContactWa(WA))!.bot_mode).toBe('auto');
    await handleTelegramUpdate(t.app, { message: { message_id: 6, chat: { id: -100 }, text: `/forget +${WA}`, from: { id: 1 } } });
    expect(await getConversationByContactWa(WA)).toBeNull();
    // commands from any other chat are ignored
    await handleTelegramUpdate(t.app, { message: { message_id: 7, chat: { id: -999 }, text: `/forget +${WA}`, from: { id: 1 } } });
  });

  it('parses and routes a real-shaped Meta payload end to end', async () => {
    const t = makeApp();
    const payload = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: {
      contacts: [{ profile: { name: 'Riya' }, wa_id: WA }],
      messages: [{ from: WA, id: 'wamid.PAYLOAD1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hello there' } }],
    } }] }] };
    const { parseWebhook } = await import('../../src/whatsapp/events.js');
    await handleEvents(t.app, parseWebhook(payload));
    const [c] = await query('select * from contacts');
    expect(c).toMatchObject({ wa_id: WA, name: 'Riya' });
    expect(t.scheduled).toHaveLength(1);
  });

  it('after a restart mid-reply, only the unsent bubbles go out (nothing repeats)', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('daily table?'));
    const conv = (await getConversationByContactWa(WA))!;
    t.clock.advance(9000);
    // simulate: first bubble already sent and stored, process died before the second
    await query(`insert into messages (conversation_id, wa_message_id, direction, author, type, text) values ($1,'wamid.PRE1','out','bot','text','Rs. 9,500, solid teak.')`, [conv.id]);
    await setPendingPlan(conv.id, { createdAt: t.clock.now().toISOString(), sent: 1, reactTo: null, react: null, bubbles: [
      { kind: 'text', text: 'Rs. 9,500, solid teak.' }, { kind: 'text', text: 'Which city?' }] });
    await runReply(t.app, conv.id);
    expect(texts(t.sent)).toEqual(['Which city?']);
    expect(t.claudeCalls).toHaveLength(0);
    expect((await getConversationByContactWa(WA))!.pending_plan).toBeNull();
  });

  it('promise kept: after the promised time, one honest holding line, then quiet', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('14 binge chairs for a cafe, trade pricing?'));
    const conv = (await getConversationByContactWa(WA))!;
    t.clock.advance(9000);
    t.script.push(
      toolUse('handoff', { reason: 'trade pricing', urgency: 'hot', summary: 'a\nb\nc' }),
      reply({ messages: ['Passed it on to Akash.'] }),
    );
    await runReply(t.app, conv.id);
    t.sent.length = 0; t.tgMessages.length = 0;
    t.clock.advance(3 * 86_400_000); // well past any promised time
    await sendHoldingLine(t.app, conv.id);
    expect(texts(t.sent)).toHaveLength(1);
    expect(texts(t.sent)[0]).toMatch(/^Sorry for the wait, Akash is on the workshop floor\. You'll hear back here by/);
    expect(t.tgMessages[0]!.text).toContain('WAITING PAST PROMISED TIME');
    await sendHoldingLine(t.app, conv.id); // second call must not send again
    expect(texts(t.sent)).toHaveLength(1);
  });

  it('human mode times out after 48h, except for trade leads', async () => {
    const t = makeApp();
    await handleInbound(t.app, inbound('hi', WA));
    await handleInbound(t.app, inbound('hi', '919999900002'));
    const home = (await getConversationByContactWa(WA))!;
    const trade = (await getConversationByContactWa('919999900002'))!;
    await query(`insert into leads (contact_id, type) values ($1,'trade')`, [trade.contact_id]);
    for (const c of [home, trade]) await setBotMode(c.id, 'human', 'test');
    t.clock.advance(49 * 3_600_000);
    await expireHumanMode(t.app);
    expect((await getConversationByContactWa(WA))!.bot_mode).toBe('auto');
    expect((await getConversationByContactWa('919999900002'))!.bot_mode).toBe('human');
  });

  it('follow-ups need consent and an approved template; customer reply cancels them', async () => {
    const t = makeApp({ settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00'], ['SHADOW_MODE', 'FALSE'], ['followup_template', 'dulari_followup_day2']] });
    await handleInbound(t.app, inbound('daily table?'));
    const conv = (await getConversationByContactWa(WA))!;
    // without consent: nothing is booked
    t.clock.advance(9000);
    t.script.push(reply({ messages: ['Rs 9500.'] }));
    await runReply(t.app, conv.id);
    expect(await query('select * from followups')).toHaveLength(0);
    // with consent: booked, then sent as a template; a customer message cancels a pending one
    await query('update contacts set followup_consent = true');
    await handleInbound(t.app, inbound('ok what about the chair?'));
    t.clock.advance(9000);
    t.script.push(reply({ messages: ['Chair is Rs 11000.'] }));
    await runReply(t.app, conv.id);
    const [f] = await query('select * from followups');
    expect(f.template).toBe('dulari_followup_day2');
    await sendFollowup(t.app, f.id);
    expect(t.sent.some((s) => s.kind === 'template' && s.body === 'dulari_followup_day2')).toBe(true);
    // a second booking is cancelled the moment the customer writes
    t.script.push(reply({ messages: ['Sure.'] }));
    await handleInbound(t.app, inbound('one more question'));
    t.clock.advance(9000);
    await runReply(t.app, conv.id);
    await handleInbound(t.app, inbound('hello?'));
    const pending = await query('select * from followups where sent_at is null and cancelled_reason is null');
    expect(pending).toHaveLength(0);
  });
});

run('chat tester (fake customer, no WhatsApp)', () => {
  beforeAll(setupDb);
  afterAll(teardownDb);
  beforeEach(async () => { await query('truncate contacts cascade'); });

  it('answers a fake customer for real while the whole bot is in shadow mode, and never touches WhatsApp', async () => {
    const t = makeApp({ settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00'], ['SHADOW_MODE', 'TRUE']] });
    t.script.push(reply({ messages: ['Hi! The Daily Table is Rs 9500, solid teak.', 'Which city is it for?'] }));
    const r = await testChat(t.app, { id: '7', text: 'Hi, I would like to inquire about: Daily Table' });
    expect(r.replies.map((x) => (x.kind === 'text' ? x.text : x.kind))).toEqual(['Hi! The Daily Table is Rs. 9,500, solid teak.', 'Which city is it for?']);
    expect(t.sent).toEqual([]); // the real WhatsApp client was never used
    const [c] = await query('select wa_id, name from contacts');
    expect(c).toMatchObject({ wa_id: '0000000007', name: 'Test chat' });
    // second turn remembers the first
    t.script.push(reply({ messages: ['Gurgaon is fine, delivery is free there.'] }));
    const r2 = await testChat(t.app, { id: '7', text: 'gurgaon' });
    expect(r2.replies).toHaveLength(1);
    expect(JSON.stringify(t.claudeCalls.at(-1).messages)).toContain('Daily Table is Rs. 9,500');
  });

  it('handoff puts the test customer in human mode, and reset gives a fresh one', async () => {
    const t = makeApp();
    t.script.push(toolUse('handoff', { reason: 'trade pricing', urgency: 'hot', summary: 'a\nb\nc' }), reply({ messages: ['Passed it to Akash.'] }));
    const r = await testChat(t.app, { id: '8', text: '14 binge chairs for a cafe, trade pricing?' });
    expect(r.mode).toBe('human');
    expect(t.tgMessages.some((m) => m.text.includes('HOT'))).toBe(true);
    const silent = await testChat(t.app, { id: '8', text: 'hello?' });
    expect(silent.replies).toEqual([]);
    expect(silent.note).toMatch(/handed to the team/);
    await testChat(t.app, { id: '8', reset: true });
    expect(await query('select 1 from contacts')).toHaveLength(0);
  });
});

run('pilot: only listed numbers get replies', () => {
  beforeAll(setupDb);
  afterAll(teardownDb);
  beforeEach(async () => { await query('truncate contacts cascade'); });

  it('answers listed phones for real, ignores real leads completely, keeps storing their messages', async () => {
    const t = makeApp({ settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00'], ['SHADOW_MODE', 'TRUE'], ['live_numbers', '+91 99999 00001'], ['only_live_numbers', 'TRUE']] });
    await handleInbound(t.app, inbound('hello from a real lead', '919111111111'));
    await handleInbound(t.app, inbound('daily table price?', '919999900001'));
    const stranger = (await getConversationByContactWa('919111111111'))!;
    const mine = (await getConversationByContactWa('919999900001'))!;
    expect(stranger.reply_due_at).toBeNull(); // nothing scheduled, no draft, no reply
    expect(mine.reply_due_at).not.toBeNull();
    expect(Number((await query('select count(*) n from messages'))[0].n)).toBe(2); // both stored
    t.clock.advance(9000);
    t.script.push(reply({ messages: ['Rs 9500, solid teak.'] }));
    await runReply(t.app, mine.id);
    expect(t.sent.filter((s) => s.kind === 'text').map((s) => s.to)).toEqual(['919999900001']); // only to the listed phone
    expect(t.tgMessages.some((m) => m.text.includes('Draft'))).toBe(false); // listed phone is live, not a draft
    await runReply(t.app, stranger.id);
    expect(t.claudeCalls).toHaveLength(1);
  });
});
