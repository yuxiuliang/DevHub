export const MAX_LOG_CHARS = 131072;
export const MAX_LOG_LINES = 2000;

/** Keep the visible tail bounded without splitting a surrogate pair or first line. */
export function limitLog(value) {
  let text = String(value ?? '');
  let truncated = false;
  if (text.length > MAX_LOG_CHARS) {
    let start = text.length - MAX_LOG_CHARS;
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start++;
    text = text.slice(start);
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0 && firstNewline < text.length - 1) text = text.slice(firstNewline + 1);
    truncated = true;
  }
  let lines = 0;
  let cursor = text.length - 1;
  if (text[cursor] === '\n') cursor--;
  for (; cursor >= 0; cursor--) {
    if (text[cursor] === '\n' && ++lines === MAX_LOG_LINES) {
      text = text.slice(cursor + 1);
      truncated = true;
      break;
    }
  }
  return { text, truncated };
}

export function appendRecentLog(current, line) {
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  return limitLog(`${current}${separator}${String(line ?? '')}\n`);
}
