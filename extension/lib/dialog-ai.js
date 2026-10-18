// Provider access is deliberately separate from monitoring and has no browser tools.
export const AI_ORIGIN = 'https://api.openai.com/*';
export const AI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export function validateModel(value) {
  const model = String(value ?? '').trim();
  if (model && !/^[A-Za-z0-9._:-]{1,100}$/.test(model)) throw new Error('Укажите корректное имя модели OpenAI.');
  return model;
}

export async function generateDialogDraft({apiKey, model, prompt, signal, fetchImpl = globalThis.fetch, timeoutMs = 45000}) {
  if (!apiKey || !model) throw new Error('Укажите API-ключ и модель OpenAI в настройках диалогов.');
  validateModel(model);
  if (!prompt || typeof prompt.system !== 'string' || typeof prompt.user !== 'string') throw new Error('Не удалось подготовить контекст диалога.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(AI_ENDPOINT, {
      method:'POST', credentials:'omit', redirect:'error', cache:'no-store', signal:controller.signal,
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({model, messages:[{role:'system',content:prompt.system},{role:'user',content:prompt.user}], max_completion_tokens:2000}),
    });
    // Provider response bodies and transport exceptions may contain sensitive data.
    if (!response.ok) throw new Error(`OpenAI вернул HTTP ${Number(response.status) || 0}. Проверьте настройки и доступность API.`);
    const body = await response.text();
    if (body.length > 128000) throw new Error('Ответ OpenAI слишком большой.');
    let value;
    try { value = JSON.parse(body); } catch { throw new Error('OpenAI вернул некорректный ответ.'); }
    const message = value?.choices?.[0]?.message;
    if (message?.tool_calls?.length || typeof message?.content !== 'string') throw new Error('OpenAI не вернул текст черновика.');
    const text = message.content.trim();
    if (!text || text.length > 6000) throw new Error('Черновик пуст или превышает 6000 символов.');
    return {text,reason:'Черновик подготовлен по явному запросу. Отправка не выполнялась.'};
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Подготовка черновика отменена или время ожидания истекло.');
    if (error instanceof Error && /^(OpenAI |Ответ OpenAI |Черновик )/.test(error.message)) throw error;
    throw new Error('Не удалось обратиться к OpenAI. Проверьте соединение и настройки API.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
