export function buildOutgoingContent(file, caption) {
  const buffer = file?.buffer;
  if (!buffer || !buffer.length) {
    throw new Error('El archivo está vacío');
  }

  const mimeType = file.mimetype || 'application/octet-stream';
  const fileName = file.fileName || 'archivo';
  const text = typeof caption === 'string' ? caption.trim() : '';
  const content = { mimetype: mimeType };

  if (mimeType.startsWith('image/')) {
    content.image = buffer;
    if (text) content.caption = text;
    return { content };
  }

  if (mimeType.startsWith('video/')) {
    content.video = buffer;
    if (text) content.caption = text;
    return { content };
  }

  if (mimeType.startsWith('audio/')) {
    content.audio = buffer;
    content.ptt = false;
    return { content, leadingText: text || undefined };
  }

  content.document = buffer;
  content.fileName = fileName;
  if (text) content.caption = text;
  return { content };
}
