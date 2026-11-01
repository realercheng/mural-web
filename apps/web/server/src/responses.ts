import type { Config } from './config.js';

export class TextUnavailable extends Error {}

export interface ResponsesCall {
  instructions: string;
  input: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Strict JSON schema for structured output; plain text when absent. */
  schema?: { name: string; schema: Record<string, unknown> };
}

/** One OpenAI Responses API call through the text gateway. The key stays on this server; nothing is stored upstream. */
export async function respond(text: NonNullable<Config['text']>, call: ResponsesCall, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(`${text.url}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${text.key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(call.timeoutMs),
    body: JSON.stringify({
      model: text.model, instructions: call.instructions, input: call.input, max_output_tokens: call.maxOutputTokens,
      reasoning: { effort: 'low' }, store: false,
      ...(call.schema ? { text: { format: { type: 'json_schema', name: call.schema.name, strict: true, schema: call.schema.schema } } } : {}),
    }),
  });
  if (!response.ok) throw new TextUnavailable(`upstream_${response.status}`);
  const body = await response.json() as { output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
  const output = body.output?.flatMap(item => item.type === 'message' ? item.content ?? [] : [])
    .find(part => part.type === 'output_text')?.text;
  if (!output?.trim()) throw new TextUnavailable('empty_output');
  return output;
}
