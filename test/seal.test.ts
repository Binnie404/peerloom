import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal, unseal, isSealed } from '../core/seal.ts';

const token = () => randomBytes(32).toString('base64url');

test('only the presented token and the same record open a sealed credential', () => {
  const presented = token(); const secret = token(); const context = 'p_1:invite-astra:abc';
  const sealed = seal(presented, secret, context);
  assert.equal(unseal(presented, sealed, context), secret);
  assert.equal(unseal(token(), sealed, context), undefined, 'another token');
  assert.equal(unseal(secret, sealed, context), undefined, 'the secret itself is not the key');
  assert.equal(unseal(presented, sealed, 'p_1:invite-bolt:abc'), undefined, 'moved to another record');
  assert.equal(unseal(presented.toLowerCase(), sealed, context), undefined);
});

test('the stored form reveals neither the credential nor the token that sealed it, and never repeats', () => {
  const presented = token(); const secret = token();
  const first = seal(presented, secret, 'c'); const second = seal(presented, secret, 'c');
  const stored = JSON.stringify([first, second]);
  assert.ok(!stored.includes(secret) && !stored.includes(presented));
  assert.ok(!Buffer.from(first.data, 'base64url').includes(Buffer.from(secret)), 'not merely encoded');
  assert.notEqual(first.salt, second.salt); assert.notEqual(first.nonce, second.nonce); assert.notEqual(first.data, second.data);
  assert.equal(unseal(presented, second, 'c'), secret);
});

test('altered or malformed sealed values open nothing and do not throw', () => {
  const presented = token(); const sealed = seal(presented, token(), 'c');
  const flip = (value: string) => { const raw = Buffer.from(value, 'base64url'); raw[0] ^= 1; return raw.toString('base64url'); };
  for (const field of ['salt', 'nonce', 'data'] as const) assert.equal(unseal(presented, { ...sealed, [field]: flip(sealed[field]) }, 'c'), undefined, field);
  const truncated = { ...sealed, data: Buffer.from(sealed.data, 'base64url').subarray(0, 20).toString('base64url') };
  assert.equal(unseal(presented, truncated, 'c'), undefined);
  for (const bad of [undefined, null, 'x', [], {}, { ...sealed, v: 2 }, { ...sealed, extra: 1 }, { ...sealed, salt: 'short' }, { ...sealed, nonce: `${sealed.nonce}=` }, { ...sealed, data: '' }, { v: 1, salt: sealed.salt, nonce: sealed.nonce }]) {
    assert.equal(isSealed(bad), false); assert.equal(unseal(presented, bad, 'c'), undefined);
  }
  assert.equal(isSealed(sealed), true);
});
