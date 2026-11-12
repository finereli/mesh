/**
 * Everything that touches keys. Only WebCrypto, so the same code runs in the Worker and in Node tests.
 *
 * The model:
 *   - Each person has an X25519 keypair. The public key is stored readable. The private key is stored only
 *     sealed under a key derived from the login key, which login.finereli.com hands this server at sign-in.
 *   - Each grant (one approved pair of agents) has a random 32-byte key. It is stored once per person involved,
 *     wrapped to that person's public key, so approving works while the other side is offline.
 *   - Messages and conversation topics are sealed with the grant key: AES-256-GCM, random nonce, and an
 *     associated-data label naming what the blob is, so one kind can't be passed off as another.
 *   - An agent's OAuth grant carries its owner's private key (the OAuth library encrypts it under the token).
 *     Nothing stored at rest can open a conversation by itself.
 *
 * Not end-to-end: while an agent makes a request the server holds keys in memory, and whoever runs the login
 * service can derive a person's login key. Run your own copy to remove that question.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const FORMAT = 1;

export const b64 = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const randomId = (prefix: string, bytes = 12) =>
  prefix + b64(randomBytes(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hkdf(secret: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, base, 256));
}

const aesKey = (raw: Uint8Array) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function sealBytes(key: Uint8Array, plain: Uint8Array, aad: string): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(aad) }, await aesKey(key), plain);
  return concat(new Uint8Array([FORMAT]), nonce, new Uint8Array(body));
}

async function openBytes(key: Uint8Array, blob: Uint8Array, aad: string): Promise<Uint8Array> {
  if (blob.length < 1 + 12 + 16 || blob[0] !== FORMAT) throw new Error('unrecognised ciphertext');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.subarray(1, 13), additionalData: enc.encode(aad) }, await aesKey(key), blob.subarray(13),
  );
  return new Uint8Array(plain);
}

// ---------- a person's keypair ----------

export interface PersonKeys { pub: string; sealedPriv: string }

const loginWrapKey = (loginKey: string) => hkdf(unb64(loginKey), enc.encode('mesh'), 'mesh:person-private-key');

/** A new keypair for someone signing in for the first time. Returns what to store, and the private key for the session. */
export async function newPerson(loginKey: string): Promise<{ stored: PersonKeys; priv: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const priv = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const sealed = await sealBytes(await loginWrapKey(loginKey), priv, 'person-private-key');
  return { stored: { pub: b64(pub), sealedPriv: b64(sealed) }, priv: b64(priv) };
}

/** The private key, or null if this login key isn't the one the keys were made with. */
export async function openPerson(loginKey: string, stored: PersonKeys): Promise<string | null> {
  try { return b64(await openBytes(await loginWrapKey(loginKey), unb64(stored.sealedPriv), 'person-private-key')); }
  catch { return null; }
}

// ---------- grant keys, wrapped to a public key ----------

async function ecdh(privPkcs8: Uint8Array, pubRaw: Uint8Array): Promise<Uint8Array> {
  const priv = await crypto.subtle.importKey('pkcs8', privPkcs8, { name: 'X25519' }, false, ['deriveBits']);
  const pub = await crypto.subtle.importKey('raw', pubRaw, { name: 'X25519' }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: pub } as any, priv, 256));
}

export const newGrantKey = () => b64(randomBytes(32));

/** Seal a grant key so only the holder of `pub`'s private key can open it. An ephemeral key does the exchange. */
export async function wrapTo(pub: string, grantKey: string, grantId: string): Promise<string> {
  const eph = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const ephPub = new Uint8Array((await crypto.subtle.exportKey('raw', eph.publicKey)) as ArrayBuffer);
  const ephPriv = new Uint8Array((await crypto.subtle.exportKey('pkcs8', eph.privateKey)) as ArrayBuffer);
  const pubRaw = unb64(pub);
  const kek = await hkdf(await ecdh(ephPriv, pubRaw), concat(ephPub, pubRaw), 'mesh:grant-key');
  return b64(concat(ephPub, await sealBytes(kek, unb64(grantKey), `grant-key:${grantId}`)));
}

export async function unwrapGrantKey(priv: string, pub: string, wrapped: string, grantId: string): Promise<string> {
  const blob = unb64(wrapped);
  const ephPub = blob.subarray(0, 32);
  const kek = await hkdf(await ecdh(unb64(priv), ephPub), concat(ephPub, unb64(pub)), 'mesh:grant-key');
  return b64(await openBytes(kek, blob.subarray(32), `grant-key:${grantId}`));
}

// ---------- sealing text with a grant key ----------

export async function sealText(grantKey: string, text: string, label: string): Promise<string> {
  return b64(await sealBytes(unb64(grantKey), enc.encode(text), label));
}

export async function openText(grantKey: string, sealed: string, label: string): Promise<string> {
  return dec.decode(await openBytes(unb64(grantKey), unb64(sealed), label));
}

// ---------- small things ----------

export async function sha256(s: string): Promise<string> {
  return b64(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
