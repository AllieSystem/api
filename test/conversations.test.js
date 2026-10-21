import test from 'node:test';
import assert from 'node:assert/strict';
import { findConversation, groupConversations, toChatSummary, upsertChatMessage } from '../src/utils/conversations.js';

test('agrupa por teléfono y conserva el hilo completo', () => {
  const chats = new Map([
    ['5535000761', {
      phone: '5535000761',
      name: '5535000761',
      messages: [{ id: 'a', text: 'uno', timestamp: 1, senderPhone: '5215535000761', jid: '247695109267588@lid' }],
    }],
    ['5215535000761', {
      phone: '5215535000761',
      name: '5215535000761',
      messages: [{ id: 'b', text: 'dos', timestamp: 2, senderPhone: '5215535000761', jid: '247695109267588@lid' }],
    }],
    ['5109267588', {
      phone: '5109267588',
      name: '5109267588',
      messages: [{ id: 'c', text: 'tres', timestamp: 3, jid: '247695109267588@lid' }],
    }],
    ['6197972056', {
      phone: '6197972056',
      name: '6197972056',
      messages: [{ id: 'd', text: 'otro', timestamp: 4, jid: '267096197972056@lid' }],
    }],
  ]);

  const groups = groupConversations(chats);
  assert.equal(groups.length, 2);

  const merged = groups.find((chat) => chat.phone === '5215535000761');
  assert.ok(merged);
  assert.deepEqual(merged.messages.map((msg) => msg.id), ['a', 'b', 'c']);
  assert.equal(merged.lastMessage.id, 'c');

  const summary = toChatSummary(merged);
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.lastMessage.text, 'tres');
  assert.equal(Object.hasOwn(summary, 'messages'), false);
  assert.equal(findConversation(chats, '5109267588').phone, '5215535000761');
  assert.equal(findConversation(chats, '6197972056').messages.length, 1);
});

test('un mensaje vacío no tapa el texto que llega después', () => {
  const chat = {
    phone: '6197972056',
    name: '6197972056',
    messages: [
      { id: 'vacio', text: '', timestamp: 50, jid: '267096197972056@lid' },
      { id: 'otro-vacio', text: '', timestamp: 60, jid: '267096197972056@lid' },
    ],
    lastMessage: { id: 'otro-vacio', text: '', timestamp: 60 },
  };

  assert.equal(upsertChatMessage(chat, { id: 'vacio', text: '', timestamp: 50 }), false);
  assert.equal(upsertChatMessage(chat, {
    id: 'real',
    text: 'hola',
    timestamp: 10,
    jid: '267096197972056@lid',
  }), true);
  assert.deepEqual(chat.messages.map((msg) => msg.id), ['real']);
  assert.equal(chat.lastMessage.text, 'hola');

  const grouped = groupConversations(new Map([[chat.phone, {
    ...chat,
    messages: [
      { id: 'vacio', text: '', timestamp: 90, jid: '267096197972056@lid' },
      { id: 'real', text: 'hola', timestamp: 10, jid: '267096197972056@lid' },
    ],
  }]]));
  assert.equal(grouped[0].lastMessage.text, 'hola');
  assert.equal(grouped[0].messages.length, 1);
});
