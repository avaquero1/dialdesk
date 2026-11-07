/**
 * The read-scope check (D1) on recorded GET /api_keys answers, key parsing for Ed25519 and RSA, and Kalshi's
 * request signature.
 */
import { constants, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApiKeysResponse, checkScopes, KALSHI_BASES, kalshiClient, KeyFormatError, parsePrivateKey, signRequest } from '../src/kalshi.ts';
import { mockExchange, recorded } from './mock-exchange.ts';

const READ_ID = 'a1b2c3d4-0000-4000-8000-00000000read';
const TRADE_ID = 'a1b2c3d4-0000-4000-8000-0000000trade';
const answer = (f: string) => ApiKeysResponse.parse(recorded(f));

describe('checkScopes on recorded answers', () => {
  it('accepts the read-only key', () => {
    expect(checkScopes(answer('kalshi-api_keys-read.json'), READ_ID, 'ed25519')).toEqual({ ok: true, scopes: ['read'] });
  });
  it('refuses a key with write scope (Kalshi default for a new key)', () => {
    expect(checkScopes(answer('kalshi-api_keys-write.json'), TRADE_ID, 'ed25519')).toMatchObject({ ok: false, reason: 'write_scope' });
  });
  it('refuses the write key even when the same account also has a read-only one', () => {
    expect(checkScopes(answer('kalshi-api_keys-read.json'), TRADE_ID, 'rsa')).toMatchObject({ ok: false, reason: 'write_scope' });
  });
  it('refuses write::trade and any write:: scope', () => {
    expect(checkScopes(answer('kalshi-api_keys-write-trade.json'), 'a1b2c3d4-0000-4000-8000-00000000wtrd', 'ed25519')).toMatchObject({
      ok: false,
      reason: 'write_scope',
    });
    for (const s of ['write::transfer', 'write::fcm_risk', 'write::block_trade_accept', 'writer'])
      expect(checkScopes({ api_keys: [{ api_key_id: 'k', scopes: ['read', s] }] }, 'k', 'rsa')).toMatchObject({ ok: false, reason: 'write_scope' });
  });
  it('refuses scopes it does not know (an allowlist, not a denylist)', () => {
    for (const s of ['admin', 'read::block_trade_accept', 'trade', 'READ'])
      expect(checkScopes({ api_keys: [{ api_key_id: 'k', scopes: ['read', s] }] }, 'k', 'rsa')).toMatchObject({ ok: false, reason: 'unknown_scope' });
  });
  it('refuses a key that is not in the answer, and a key with no scopes', () => {
    expect(checkScopes(answer('kalshi-api_keys-other.json'), READ_ID, 'ed25519')).toMatchObject({ ok: false, reason: 'key_not_listed' });
    expect(checkScopes({ api_keys: [{ api_key_id: 'k', scopes: [] }] }, 'k', 'rsa')).toMatchObject({ ok: false, reason: 'no_scope' });
  });
  it('refuses a key whose type is not the one the user picked', () => {
    expect(checkScopes(answer('kalshi-api_keys-read.json'), READ_ID, 'rsa')).toMatchObject({ ok: false, reason: 'key_type_mismatch' });
  });
});

describe('parsePrivateKey', () => {
  const pem = (k: { export: (o: object) => string | Buffer }, type = 'pkcs8') => k.export({ type, format: 'pem' }) as string;
  it('accepts Ed25519 (PKCS#8) and RSA (PKCS#8 and PKCS#1)', () => {
    const ed = generateKeyPairSync('ed25519').privateKey;
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(parsePrivateKey(pem(ed), 'ed25519').asymmetricKeyType).toBe('ed25519');
    expect(parsePrivateKey(pem(rsa), 'rsa').asymmetricKeyType).toBe('rsa');
    expect(parsePrivateKey(pem(rsa, 'pkcs1'), 'rsa').asymmetricKeyType).toBe('rsa');
  });
  it('refuses the wrong type, short RSA, a public key and junk', () => {
    const ed = generateKeyPairSync('ed25519');
    expect(() => parsePrivateKey(pem(ed.privateKey), 'rsa')).toThrow(KeyFormatError);
    expect(() => parsePrivateKey(pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), 'ed25519')).toThrow(KeyFormatError);
    expect(() => parsePrivateKey(pem(generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey), 'rsa')).toThrow(/2048/);
    expect(() => parsePrivateKey(ed.publicKey.export({ type: 'spki', format: 'pem' }) as string, 'ed25519')).toThrow(KeyFormatError);
    expect(() => parsePrivateKey('-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----', 'ed25519')).toThrow(KeyFormatError);
  });
});

describe("Kalshi's signature", () => {
  it('Ed25519 over timestamp + GET + full path', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const sig = signRequest(privateKey, '1794052800000', 'GET', '/trade-api/v2/portfolio/balance');
    expect(verify(null, Buffer.from('1794052800000GET/trade-api/v2/portfolio/balance'), publicKey, Buffer.from(sig, 'base64'))).toBe(true);
  });
  it('RSA-PSS SHA-256 with the salt as long as the digest', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const sig = signRequest(privateKey, '1794052800000', 'GET', '/trade-api/v2/api_keys');
    const msg = Buffer.from('1794052800000GET/trade-api/v2/api_keys');
    expect(verify('sha256', msg, { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sig, 'base64'))).toBe(true);
  });
  it('the client signs the path without the query, and the mock exchange accepts it', async () => {
    const ex = mockExchange();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    ex.addKey('k-rsa', privateKey);
    const pos = await kalshiClient({ env: 'demo', keyId: 'k-rsa', key: privateKey, fetch: ex.fetch }).positions();
    expect(pos).toHaveLength(4);
    const call = ex.calls[0]!;
    expect(call.url.startsWith(`${KALSHI_BASES.demo}/portfolio/positions?`)).toBe(true);
    expect(call.headers['kalshi-access-key']).toBe('k-rsa');
    const msg = Buffer.from(call.headers['kalshi-access-timestamp'] + 'GET/trade-api/v2/portfolio/positions');
    const ok = verify(
      'sha256',
      msg,
      { key: createPublicKey(privateKey), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      Buffer.from(call.headers['kalshi-access-signature']!, 'base64'),
    );
    expect(ok).toBe(true);
  });
});
