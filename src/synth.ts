export const SYNTH_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

interface ChatResponse { response?: string }

export async function synthesize(
  ai: Ai,
  system: string,
  user: string,
  opts: { maxTokens?: number } = {},
): Promise<string> {
  const res = (await ai.run(SYNTH_MODEL, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.4,
    max_tokens: opts.maxTokens ?? 700,
  })) as unknown as ChatResponse;
  return (res.response ?? '').trim();
}
