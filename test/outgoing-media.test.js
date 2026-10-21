import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutgoingContent } from '../src/utils/outgoingMedia.js';

test('prepara imagen, audio y documento para WhatsApp', () => {
  const buffer = Buffer.from('archivo');

  const image = buildOutgoingContent(
    { buffer, mimetype: 'image/png', fileName: 'foto.png' },
    'hola'
  );
  assert.equal(image.content.image, buffer);
  assert.equal(image.content.caption, 'hola');
  assert.equal(image.leadingText, undefined);

  const audio = buildOutgoingContent(
    { buffer, mimetype: 'audio/mpeg', fileName: 'nota.mp3' },
    'voz'
  );
  assert.equal(audio.content.audio, buffer);
  assert.equal(audio.content.ptt, false);
  assert.equal(audio.leadingText, 'voz');

  const document = buildOutgoingContent(
    { buffer, mimetype: 'application/pdf', fileName: 'recibo.pdf' },
    '   '
  );
  assert.equal(document.content.document, buffer);
  assert.equal(document.content.fileName, 'recibo.pdf');
  assert.equal(document.content.caption, undefined);
});
