import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/brain.sample.json' with { type: 'json' };
import { parseBrain } from '../src/brain/parse.js';
import { findProducts, handleFromUrl, parseEnquire } from '../src/brain/lookup.js';
import { renderKnowledge, unsample } from '../src/brain/prompt.js';
import { DEFAULT_SETTINGS } from '../src/brain/types.js';


describe('brain parsing', () => {
  it('the sample fixture used for local/e2e runs validates', () => {
    const r = parseBrain({ products: fixture.Products, faq: fixture.FAQ, policies: fixture.Policies, settings: fixture.Settings, team: fixture.Team });
    expect(r.errors).toEqual([]);
    expect(r.brain!.products).toHaveLength(11);
  });
  it('rejects a non-numeric price', () => {
    const r = parseBrain({ products: [['name', 'handle', 'price'], ['X', 'x', 'call us']], settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00']] });
    expect(r.brain).toBeNull();
    expect(r.errors[0]).toMatch(/Products row 2.*price/);
  });
  const good = {
    products: [
      ['name', 'website handle', 'other names', 'price', 'in stock', 'photo urls', 'active'],
      ['Daily Table', 'mini-table', 'daily dining table, mini table', 'Rs. 9,500', 'yes', 'https://x/1.jpg\nhttps://x/2.jpg', 'yes'],
      ['Daily Chair', 'mini-chair', '', '4500', 'no', '', ''],
    ],
    faq: [['question', 'answer'], ['Where?', 'Gurugram']],
    policies: [['delivery', 'payment'], ['Free in NCR', '50% advance']],
    settings: [['key', 'value'], ['batch_seconds', '10'], ['SHADOW_MODE', 'FALSE'], ['studio_hours', 'Mon-Sat 10:00-19:00']],
    team: [['name', 'telegram handle', 'on duty'], ['Akash', '@akash', 'yes']],
  };
  it('parses a valid brain', () => {
    const r = parseBrain(good);
    expect(r.errors).toEqual([]);
    const b = r.brain!;
    expect(b.products[0]).toMatchObject({ price: 9500, photoUrls: ['https://x/1.jpg', 'https://x/2.jpg'], otherNames: ['daily dining table', 'mini table'] });
    expect(b.products[1]).toMatchObject({ inStock: false, active: true });
    expect(b.settings).toMatchObject({ batchSeconds: 10, shadowMode: false });
    expect(b.policies).toEqual([{ topic: 'delivery', text: 'Free in NCR' }, { topic: 'payment', text: '50% advance' }]);
    expect(b.team[0]).toMatchObject({ telegram: 'akash', onDuty: true });
    expect(renderKnowledge(b)).toContain('Daily Table (handle mini-table');
  });
  it('reports the row number of a broken edit', () => {
    const bad = { ...good, products: [...good.products, ['', 'x', '', '1', '', '', '']] };
    const r = parseBrain(bad);
    expect(r.brain).toBeNull();
    expect(r.errors).toContain('Products row 4: name is empty');
  });
  it('reads live_numbers in any phone format and guards only_live_numbers', () => {
    const base = { products: good.products, settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00'], ['live_numbers', '+91 98765 43210, 9123456789\n919000000000'], ['only_live_numbers', 'TRUE']] };
    const r = parseBrain(base);
    expect(r.errors).toEqual([]);
    expect(r.brain!.settings).toMatchObject({ liveNumbers: ['919876543210', '919123456789', '919000000000'], onlyLiveNumbers: true });
    expect(parseBrain({ ...base, settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00'], ['live_numbers', '12ab'], ['only_live_numbers', 'TRUE']] }).errors.join()).toMatch(/cannot read.*12ab/);
    expect(parseBrain({ ...base, settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00'], ['only_live_numbers', 'TRUE']] }).errors.join()).toMatch(/would ignore everyone/);
  });
  it('rejects bad settings', () => {
    const r = parseBrain({ ...good, settings: [['key', 'value'], ['batch_seconds', 'fast'], ['SHADOW_MODE', 'maybe'], ['studio_hours', 'whenever']] });
    expect(r.errors.join('\n')).toMatch(/batch_seconds/);
    expect(r.errors.join('\n')).toMatch(/shadow_mode/);
    expect(r.errors.join('\n')).toMatch(/studio_hours/);
  });
});

describe('placeholder text never reaches the model', () => {
  const b = parseBrain({
    products: [['name', 'handle', 'price', 'woods', 'finishes', 'lead time', 'notes'], ['Daily Table', 'mini-table', '9500', 'solid wood (SAMPLE)', 'hand-rubbed oil', '2 weeks (SAMPLE)', 'SAMPLE ROW']],
    faq: [['question', 'answer'], ['Where?', 'SAMPLE Gurugram'], ['Parking?', 'Yes, free']],
    policies: [['topic', 'text'], ['delivery', 'SAMPLE replace'], ['care', 'Wipe with a dry cloth']],
    settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00'], ['holding_line_seconds', '0']],
  }).brain!;
  it('drops SAMPLE cells from the knowledge base, keeps real ones', () => {
    const kb = renderKnowledge(b);
    expect(kb).not.toMatch(/SAMPLE/);
    expect(kb).toContain('finishes hand-rubbed oil');
    expect(kb).not.toContain('woods');
    expect(kb).toContain('Parking?');
    expect(kb).not.toContain('Gurugram');
    expect(kb).toContain('care: Wipe with a dry cloth');
    expect(unsample('solid wood (SAMPLE)')).toBe('');
    expect(unsample('solid teak')).toBe('solid teak');
  });
  it('reads holding_line_seconds (0 turns the filler line off)', () => {
    expect(b.settings.holdingLineSeconds).toBe(0);
    expect(DEFAULT_SETTINGS.holdingLineSeconds).toBe(15);
  });
});

describe('product lookup', () => {
  const b = parseBrain({
    products: [
      ['name', 'handle', 'other names', 'price'],
      ['Pie Table', 'mesh-table', '', '24000'],
      ['Sundae Sofa', 'binge-sofa', 'sundae', '64000'],
      ['Daily Table', 'mini-table', '', '9500'],
      ['Daily Chair', 'mini-chair', '', '4500'],
    ],
    settings: [['key', 'value'], ['studio_hours', 'Mon-Sat 10:00-19:00']],
  }).brain!;
  it('reads the handle from a website link (handles differ from names)', () => {
    expect(handleFromUrl('https://dulari.design/products/mesh-table?x=1')).toBe('mesh-table');
    expect(findProducts('https://dulari.design/products/mesh-table', b.products)[0]!.product.name).toBe('Pie Table');
  });
  it('matches by name, alias and fuzzy words', () => {
    expect(findProducts('sundae sofa', b.products)[0]!.product.handle).toBe('binge-sofa');
    expect(findProducts('sundae', b.products)[0]!.product.handle).toBe('binge-sofa');
    expect(findProducts('the daily table please', b.products)[0]!.product.handle).toBe('mini-table');
    expect(findProducts('xyz lamp', b.products)).toEqual([]);
  });
  it('parses the website Enquire opener', () => {
    expect(parseEnquire('Hi, I would like to inquire about: Daily Table https://dulari.design/products/mini-table')).toEqual({
      productText: 'Daily Table', handle: 'mini-table', url: 'https://dulari.design/products/mini-table',
    });
    expect(parseEnquire('how much is the sofa')).toBeNull();
  });
});
