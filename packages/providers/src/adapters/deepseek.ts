import { OpenAiAdapter } from './openai.js';

// DeepSeek OpenAI-uyumlu uç sunar; adaptör aynı, yalnız baseURL/id/model listesi değişir.
export function createDeepseekAdapter(apiKey: string, baseURL = 'https://api.deepseek.com'): OpenAiAdapter {
  return new OpenAiAdapter({
    apiKey,
    baseURL,
    id: 'deepseek',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    healthModel: 'deepseek-chat',
  });
}
