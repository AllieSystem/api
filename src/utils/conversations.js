export function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function samePhone(left, right) {
  const a = digits(left);
  const b = digits(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 10 && long.endsWith(short) && long.length - short.length <= 4;
}

function describe(chat) {
  const lids = new Set();
  const phones = new Set();
  const lidTails = new Set();
  for (const msg of chat.messages || []) {
    if (typeof msg.jid === 'string' && msg.jid.endsWith('@lid')) {
      lids.add(msg.jid);
      const tail = digits(msg.jid.split('@')[0]).slice(-10);
      if (tail.length === 10) lidTails.add(tail);
    }
    const sender = digits(msg.senderPhone);
    if (sender.length >= 10) phones.add(sender);
  }
  const own = digits(chat.phone);
  if (own.length >= 12) phones.add(own);
  return { lids, phones, lidTails };
}

function sharesIdentity(left, right, chatLeft, chatRight) {
  for (const lid of left.lids) {
    if (right.lids.has(lid)) return true;
  }
  const phones = [...left.phones, digits(chatLeft.phone)].filter((phone) => phone.length >= 10);
  const others = [...right.phones, digits(chatRight.phone)].filter((phone) => phone.length >= 10);
  return phones.some((phone) => others.some((other) => samePhone(phone, other)));
}

function mergeGroup(members) {
  const phones = [];
  const lidTails = new Set();
  for (const chat of members) {
    const info = describe(chat);
    for (const phone of info.phones) phones.push(phone);
    for (const tail of info.lidTails) lidTails.add(tail);
  }
  const real = phones.filter((phone) => !lidTails.has(phone));
  real.sort((a, b) => b.length - a.length || a.localeCompare(b));
  const own = members
    .map((chat) => digits(chat.phone))
    .filter((phone) => phone && !lidTails.has(phone));
  own.sort((a, b) => b.length - a.length || a.localeCompare(b));
  const phone = real[0] || own[0] || digits(members[0].phone) || members[0].phone;

  const byId = new Map();
  for (const chat of members) {
    for (const msg of chat.messages || []) {
      if (!msg?.id || byId.has(msg.id)) continue;
      byId.set(msg.id, msg);
    }
  }
  let messages = Array.from(byId.values()).sort(
    (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
  );
  if (messages.some(messageHasContent)) {
    messages = messages.filter(messageHasContent);
  }
  const lastMessage = messages[messages.length - 1] || null;
  const named = members.find((chat) => chat.name && digits(chat.name) !== digits(chat.phone));
  return {
    phone,
    name: named?.name || phone,
    messages,
    lastMessage,
    timestamp: lastMessage?.timestamp || Math.max(0, ...members.map((chat) => chat.timestamp || 0)),
  };
}

export function groupConversations(chats) {
  const items = Array.from(chats.values());
  const parent = items.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (left, right) => {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft !== rootRight) parent[rootRight] = rootLeft;
  };

  const info = items.map(describe);
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (sharesIdentity(info[left], info[right], items[left], items[right])) {
        union(left, right);
      }
    }
  }

  const groups = new Map();
  items.forEach((chat, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(chat);
  });
  return Array.from(groups.values()).map(mergeGroup);
}

export function findConversation(chats, phone) {
  const wanted = digits(phone);
  return groupConversations(chats).find((chat) => {
    if (samePhone(chat.phone, wanted)) return true;
    return (chat.messages || []).some((msg) => {
      if (samePhone(msg.senderPhone, wanted)) return true;
      if (typeof msg.jid === 'string' && msg.jid.endsWith('@lid')) {
        return digits(msg.jid.split('@')[0]).slice(-10) === wanted;
      }
      return false;
    });
  }) || null;
}

export function messageHasContent(message) {
  return Boolean(message?.text || message?.mediaType);
}

export function upsertChatMessage(chat, message) {
  if (!chat.messages) chat.messages = [];
  const index = chat.messages.findIndex((item) => item.id === message.id);
  if (index >= 0) {
    const current = chat.messages[index];
    if (messageHasContent(current) || !messageHasContent(message)) return false;
    chat.messages[index] = { ...current, ...message };
  } else if (messageHasContent(message)) {
    chat.messages.push(message);
  } else {
    return false;
  }

  if (chat.messages.some(messageHasContent)) {
    chat.messages = chat.messages.filter(messageHasContent);
  }
  chat.messages.sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
  chat.lastMessage = chat.messages[chat.messages.length - 1] || null;
  chat.timestamp = chat.lastMessage?.timestamp || chat.timestamp || Date.now();
  return true;
}

export function toChatSummary(chat) {
  return {
    phone: chat.phone,
    name: chat.name,
    lastMessage: chat.lastMessage,
    messageCount: chat.messages?.length || 0,
  };
}
