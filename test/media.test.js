import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaKeyToBuffer, normalizeFileLength, normalizeMediaKey } from '../src/utils/media.js';

test('la llave de un archivo se recupera aunque venga partida en JSON', () => {
  const original = Buffer.from('llave-de-prueba-1234');
  const numeric = {};
  original.forEach((byte, index) => {
    numeric[index] = byte;
  });

  assert.deepEqual(mediaKeyToBuffer(numeric), original);
  assert.equal(normalizeMediaKey(numeric), original.toString('base64'));
  assert.deepEqual(mediaKeyToBuffer(original.toString('base64')), original);
  assert.equal(normalizeFileLength({ low: 2048, high: 0, unsigned: true }), 2048);
});
