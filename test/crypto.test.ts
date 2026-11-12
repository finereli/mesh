import assert from 'node:assert/strict';
import { b64, newGrantKey, newPerson, openPerson, openText, randomBytes, sealText, unwrapGrantKey, wrapTo } from '../src/crypto.ts';

const loginA = b64(randomBytes(32));
const loginB = b64(randomBytes(32));

const a = await newPerson(loginA);
const b = await newPerson(loginB);

// The private key comes back only with the right login key.
assert.equal(await openPerson(loginA, a.stored), a.priv);
assert.equal(await openPerson(loginB, a.stored), null);

// A grant key wrapped to each side opens for that side only.
const key = newGrantKey();
const forA = await wrapTo(a.stored.pub, key, 'g1');
const forB = await wrapTo(b.stored.pub, key, 'g1');
assert.equal(await unwrapGrantKey(a.priv, a.stored.pub, forA, 'g1'), key);
assert.equal(await unwrapGrantKey(b.priv, b.stored.pub, forB, 'g1'), key);
await assert.rejects(unwrapGrantKey(b.priv, b.stored.pub, forA, 'g1'));
await assert.rejects(unwrapGrantKey(a.priv, a.stored.pub, forA, 'g2'), 'a wrapped key is bound to its grant');

// Text sealed under a label opens only under the same label.
const sealed = await sealText(key, 'שלום, Tom 👋', 'msg:c1');
assert.equal(await openText(key, sealed, 'msg:c1'), 'שלום, Tom 👋');
await assert.rejects(openText(key, sealed, 'topic:c1'));
await assert.rejects(openText(newGrantKey(), sealed, 'msg:c1'));

console.log('crypto: all pass');
