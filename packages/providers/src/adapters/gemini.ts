import { OpenAiAdapter } from './openai.js';

// Google Gemini OpenAI-uyumlu uç sunar; adaptör aynı, yalnız baseURL/id/model listesi değişir.
export function createGeminiAdapter(
  apiKey: string,
  baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/',
  models?: string[],
): OpenAiAdapter {
  return new OpenAiAdapter({
    apiKey,
    baseURL,
    id: 'google',
    models: models ?? ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    healthModel: 'gemini-2.5-flash',
  });
}
