import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBrain } from '../src/brain/parse.js';
import { findProducts, handleFromUrl, parseEnquire } from '../src/brain/lookup.js';
import { renderKnowledge } from '../src/brain/prompt.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/brain.sample.json', import.meta.url), 'utf8'));

describe('brain parsing', () => {
  it('sample fixture has bad prices (SAMPLE 24000) so the validator rejects it', () => {
    const r = parseBrain({ products: fixture.Products, faq: fixture.FAQ, policies: fixture.Policies, settings: fixture.Settings, team: fixture.Team });
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
  it('rejects bad settings', () => {
    const r = parseBrain({ ...good, settings: [['key', 'value'], ['batch_seconds', 'fast'], ['SHADOW_MODE', 'maybe'], ['studio_hours', 'whenever']] });
    expect(r.errors.join('\n')).toMatch(/batch_seconds/);
    expect(r.errors.join('\n')).toMatch(/shadow_mode/);
    expect(r.errors.join('\n')).toMatch(/studio_hours/);
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
