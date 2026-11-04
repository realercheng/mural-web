import { cleanText } from './helpers.js';

// Continue the last conversation: the browser sends the end of the saved text and the gateway
// puts it into the new session as earlier turns. Ports ConversationContinuation.history: the
// newest 40 messages, each at most 4,000 bytes, the whole list at most 6,000 bytes of JSON.
export const MAX_HISTORY_MESSAGES = 40;
const MAX_MESSAGE_BYTES = 4_000;
const MAX_HISTORY_BYTES = 6_000;

export interface HistoryItem {
  type: 'message';
  role: 'user' | 'assistant';
  content: { type: 'input_text' | 'output_text'; text: string }[];
}

/** Returns provider items for valid input, or undefined for anything that is not a plain list of messages. */
export function cleanHistory(value: unknown): HistoryItem[] | undefined {
  if (!Array.isArray(value) || value.length > 200) return undefined;
  const items: HistoryItem[] = [];
  for (const entry of value.slice(-MAX_HISTORY_MESSAGES)) {
    const role = (entry as { role?: unknown })?.role, raw = (entry as { text?: unknown })?.text;
    if (role !== 'user' && role !== 'assistant') return undefined;
    // Tabs and line breaks are allowed in a message; other control characters are not.
    const text = typeof raw === 'string' ? cleanText(raw.replace(/[\t\n\r]+/g, ' '), 20_000) : undefined;
    if (!text) { if (typeof raw === 'string' && !raw.trim()) continue; return undefined; }
    let clipped = text;
    while (Buffer.byteLength(clipped) > MAX_MESSAGE_BYTES) clipped = clipped.slice(0, -1);
    items.push({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: clipped }] });
  }
  while (items.length && Buffer.byteLength(JSON.stringify(items)) > MAX_HISTORY_BYTES) items.shift();
  return items;
}
