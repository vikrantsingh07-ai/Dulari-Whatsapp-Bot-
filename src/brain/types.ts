export interface Product {
  name: string;
  handle: string;
  otherNames: string[];
  price: number;
  size: string;
  woods: string;
  finishes: string;
  leadTime: string;
  inStock: boolean;
  photoUrls: string[];
  productUrl: string;
  notes: string;
  active: boolean;
}
export interface FaqRow { question: string; answer: string }
export interface PolicyRow { topic: string; text: string }
export interface TeamMember { name: string; telegram: string; role: string; onDuty: boolean }

export interface Settings {
  studioHours: string;
  holidays: string;
  handoffReplyHours: number;
  batchSeconds: number;
  batchMaxSeconds: number;
  typingBaseMs: number;
  typingMsPerChar: number;
  typingMinSeconds: number;
  typingMaxSeconds: number;
  jitter: number;
  gapMinSeconds: number;
  gapMaxSeconds: number;
  replyMaxSeconds: number;
  humanTimeoutHours: number;
  followupDays: number;
  followupTemplate: string;
  followupLanguage: string;
  retentionMonths: number;
  botEnabled: boolean;
  shadowMode: boolean;
  shadowDuringStudioHours: boolean;
  /** numbers (digits with country code) the bot answers for real, even while shadow mode is on */
  liveNumbers: string[];
  /** when true (and liveNumbers is not empty) every other customer is ignored: no drafts, no replies */
  onlyLiveNumbers: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  studioHours: 'Mon-Sat 10:00-19:00',
  holidays: '',
  handoffReplyHours: 2,
  batchSeconds: 8,
  batchMaxSeconds: 25,
  typingBaseMs: 1500,
  typingMsPerChar: 35,
  typingMinSeconds: 2,
  typingMaxSeconds: 9,
  jitter: 0.2,
  gapMinSeconds: 1,
  gapMaxSeconds: 3,
  replyMaxSeconds: 30,
  humanTimeoutHours: 48,
  followupDays: 2,
  followupTemplate: '',
  followupLanguage: 'en',
  retentionMonths: 12,
  botEnabled: true,
  shadowMode: true, // safe default: nothing reaches customers until switched off
  shadowDuringStudioHours: false,
  liveNumbers: [],
  onlyLiveNumbers: false,
};

export interface Brain {
  products: Product[];
  faq: FaqRow[];
  policies: PolicyRow[];
  settings: Settings;
  team: TeamMember[];
  loadedAt: string;
}
