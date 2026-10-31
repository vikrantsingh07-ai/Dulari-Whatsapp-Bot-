/** Normalised events parsed from Meta webhook payloads. */
export interface InboundMessage {
  kind: 'inbound';
  waMessageId: string;
  from: string; // customer wa_id
  profileName?: string;
  timestamp: Date;
  type: string; // text | image | document | audio | video | sticker | location | reaction | button | interactive | unsupported
  text?: string;
  mediaId?: string;
  mimeType?: string;
  filename?: string;
  caption?: string;
  isVoice?: boolean;
  quotedId?: string;
  referral?: Record<string, unknown>;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  reaction?: { messageId: string; emoji: string };
}
export interface EchoMessage {
  kind: 'echo';
  waMessageId: string;
  to: string; // customer wa_id
  timestamp: Date;
  type: string;
  text?: string;
}
export interface StatusEvent {
  kind: 'status';
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  recipient?: string;
  errorCode?: string;
  errorTitle?: string;
}
export interface HistoryMessage {
  kind: 'history';
  waMessageId: string;
  customer: string;
  fromBusiness: boolean;
  timestamp: Date;
  type: string;
  text?: string;
}
export type WaEvent = InboundMessage | EchoMessage | StatusEvent | HistoryMessage;

const ts = (v: unknown) => new Date(Number(v) * 1000 || Date.now());

function parseInboundMessage(m: any, names: Map<string, string>): InboundMessage | null {
  if (!m?.id || !m?.from) return null;
  const base: InboundMessage = {
    kind: 'inbound', waMessageId: m.id, from: String(m.from), profileName: names.get(String(m.from)),
    timestamp: ts(m.timestamp), type: String(m.type ?? 'unsupported'),
    quotedId: m.context?.id, referral: m.referral && typeof m.referral === 'object' ? m.referral : undefined,
  };
  switch (m.type) {
    case 'text': base.text = m.text?.body; break;
    case 'image': Object.assign(base, { mediaId: m.image?.id, mimeType: m.image?.mime_type, caption: m.image?.caption }); break;
    case 'video': Object.assign(base, { mediaId: m.video?.id, mimeType: m.video?.mime_type, caption: m.video?.caption }); break;
    case 'document': Object.assign(base, { mediaId: m.document?.id, mimeType: m.document?.mime_type, filename: m.document?.filename, caption: m.document?.caption }); break;
    case 'audio': Object.assign(base, { mediaId: m.audio?.id, mimeType: m.audio?.mime_type, isVoice: !!m.audio?.voice }); break;
    case 'sticker': Object.assign(base, { mediaId: m.sticker?.id, mimeType: m.sticker?.mime_type }); break;
    case 'location': base.location = m.location; break;
    case 'reaction': base.reaction = { messageId: m.reaction?.message_id, emoji: m.reaction?.emoji }; break;
    case 'button': base.text = m.button?.text; break;
    case 'interactive': base.text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title; break;
  }
  return base;
}

export function parseWebhook(body: any): WaEvent[] {
  const out: WaEvent[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      switch (change?.field) {
        case 'messages': {
          const names = new Map<string, string>();
          for (const c of v.contacts ?? []) if (c?.wa_id && c?.profile?.name) names.set(String(c.wa_id), c.profile.name);
          for (const m of v.messages ?? []) { const e = parseInboundMessage(m, names); if (e) out.push(e); }
          for (const s of v.statuses ?? []) {
            if (!s?.id) continue;
            out.push({ kind: 'status', waMessageId: s.id, status: s.status, recipient: s.recipient_id, errorCode: s.errors?.[0]?.code != null ? String(s.errors[0].code) : undefined, errorTitle: s.errors?.[0]?.title });
          }
          break;
        }
        // Coexistence: messages typed on the WhatsApp Business app arrive as echoes.
        case 'smb_message_echoes': {
          for (const m of v.message_echoes ?? []) {
            if (!m?.id || !m?.to) continue;
            out.push({ kind: 'echo', waMessageId: m.id, to: String(m.to), timestamp: ts(m.timestamp), type: String(m.type ?? 'text'), text: m.text?.body });
          }
          break;
        }
        // Coexistence history sync. Shape verified loosely, see docs/NOTES.md "Verify against Meta".
        case 'history': {
          for (const h of v.history ?? []) {
            for (const t of h?.threads ?? []) {
              for (const m of t?.messages ?? []) {
                if (!m?.id) continue;
                const biz = String(v.metadata?.display_phone_number ?? '').replace(/\D/g, '');
                const fromBusiness = !!biz && String(m.from ?? '').replace(/\D/g, '') === biz;
                const customer = String(t.id ?? (fromBusiness ? m.to : m.from) ?? '');
                if (!customer) continue;
                out.push({ kind: 'history', waMessageId: m.id, customer, fromBusiness, timestamp: ts(m.timestamp), type: String(m.type ?? 'text'), text: m.text?.body });
              }
            }
          }
          break;
        }
      }
    }
  }
  return out;
}
