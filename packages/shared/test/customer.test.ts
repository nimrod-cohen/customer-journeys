// The systemwide `customer.*` shorthand (§8/§11): customer.<key> ≡
// customer.attributes.<key>, while reserved profile columns stay scalar.
import { describe, it, expect } from 'vitest';
import {
  expandCustomerPath,
  expandCustomerToken,
  resolveCustomerField,
  customerMerge,
  RESERVED_CUSTOMER_FIELDS,
} from '../src/customer.js';

describe('expandCustomerPath (path after "customer.")', () => {
  it('shorthand → attribute', () => {
    expect(expandCustomerPath('tier')).toBe('attributes.tier');
    expect(expandCustomerPath('first_name')).toBe('attributes.first_name');
  });
  it('explicit attributes path is preserved', () => {
    expect(expandCustomerPath('attributes.tier')).toBe('attributes.tier');
  });
  it('reserved profile columns stay scalar', () => {
    for (const f of RESERVED_CUSTOMER_FIELDS) expect(expandCustomerPath(f)).toBe(f);
  });
  it('dotted non-reserved keys become attribute keys', () => {
    expect(expandCustomerPath('address.city')).toBe('attributes.address.city');
  });
});

describe('expandCustomerToken (full token, for email merge lookup)', () => {
  it('expands the customer shorthand', () => {
    expect(expandCustomerToken('customer.tier')).toBe('customer.attributes.tier');
    expect(expandCustomerToken('customer.attributes.tier')).toBe('customer.attributes.tier');
    expect(expandCustomerToken('customer.email')).toBe('customer.email');
  });
  it('leaves non-customer tokens unchanged', () => {
    expect(expandCustomerToken('first_name')).toBe('first_name');
    expect(expandCustomerToken('order.total')).toBe('order.total');
    expect(expandCustomerToken('customer')).toBe('customer'); // bare namespace
  });
});

describe('resolveCustomerField (segment field name)', () => {
  it('maps customer shorthand to the canonical attribute field', () => {
    expect(resolveCustomerField('customer.tier')).toBe('attributes.tier');
    expect(resolveCustomerField('customer.attributes.tier')).toBe('attributes.tier');
    expect(resolveCustomerField('customer.email')).toBe('email');
  });
  it('passes legacy / non-customer fields through unchanged', () => {
    expect(resolveCustomerField('attributes.tier')).toBe('attributes.tier');
    expect(resolveCustomerField('email')).toBe('email');
    expect(resolveCustomerField('features.counters.purchases')).toBe('features.counters.purchases');
    expect(resolveCustomerField('customer.')).toBe('customer.'); // bare → rejected downstream
  });
});

describe('customerMerge (profile → merge map keyed by canonical token)', () => {
  it('keys scalars and attributes under customer.* and stringifies values', () => {
    const merge = customerMerge({
      email: 'a@b.com',
      external_id: 'ext-1',
      email_status: 'active',
      attributes: { tier: 'gold', visits: 7, vip: true },
    });
    expect(merge['customer.email']).toBe('a@b.com');
    expect(merge['customer.external_id']).toBe('ext-1');
    expect(merge['customer.attributes.tier']).toBe('gold');
    expect(merge['customer.attributes.visits']).toBe('7');
    expect(merge['customer.attributes.vip']).toBe('true');
  });
  it('skips null/undefined and object/array attribute values', () => {
    const merge = customerMerge({
      email: null,
      attributes: { ok: 'yes', nested: { x: 1 }, list: [1, 2], blank: null },
    });
    expect(merge['customer.email']).toBeUndefined();
    expect(merge['customer.attributes.ok']).toBe('yes');
    expect(merge['customer.attributes.nested']).toBeUndefined();
    expect(merge['customer.attributes.list']).toBeUndefined();
    expect(merge['customer.attributes.blank']).toBeUndefined();
  });
});
