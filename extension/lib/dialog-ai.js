// Provider access is deliberately separate from monitoring and has no browser tools.
export const AI_ORIGIN = 'https://api.openai.com/*';
export const AI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export function validateModel(value) {
  const model = String(value ?? '').trim();
  if (model && !/^[A-Za-z0-9._:-]{1,100}$/.test(model)) throw new Error('Укажите корректное имя модели OpenAI.');
  return model;
}
function validateImages(images) {
  if(!Array.isArray(images) || images.length>8 || images.some(image=>typeof image!=='string' || image.length>4*1024*1024 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)))throw new Error('Неподдерживаемый формат или размер изображения.');
  if(images.reduce((total,image)=>total+image.length,0)>16*1024*1024)throw new Error('Изображения слишком велики для одного запроса.');
}

async function requestText({apiKey, model, prompt, signal, fetchImpl = globalThis.fetch, timeoutMs = 45000, images=[], structured=false}) {
  if (!apiKey || !model) throw new Error('Укажите API-ключ и модель OpenAI в настройках диалогов.');
  validateModel(model);
  validateImages(images);
  if (!prompt || typeof prompt.system !== 'string' || typeof prompt.user !== 'string') throw new Error('Не удалось подготовить контекст диалога.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(abort, timeoutMs);
  try {
    if(controller.signal.aborted)throw new Error('cancelled');
    const response = await fetchImpl(AI_ENDPOINT, {
      method:'POST', credentials:'omit', redirect:'error', cache:'no-store', signal:controller.signal,
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({model, messages:[{role:'system',content:prompt.system},{role:'user',content:images.length?[{type:'text',text:prompt.user},...images.map(url=>({type:'image_url',image_url:{url,detail:'auto'}}))]:prompt.user}], max_completion_tokens:structured?6000:2000,...(structured?{response_format:{type:'json_object'}}:{})}),
    });
    // Provider response bodies and transport exceptions may contain sensitive data.
    if (!response.ok) throw new Error(`OpenAI вернул HTTP ${Number(response.status) || 0}. Проверьте настройки и доступность API.`);
    const body = await response.text();
    if(controller.signal.aborted)throw new Error('cancelled');
    if (body.length > 128000) throw new Error('Ответ OpenAI слишком большой.');
    let value;
    try { value = JSON.parse(body); } catch { throw new Error('OpenAI вернул некорректный ответ.'); }
    if(value?.choices?.[0]?.finish_reason==='length')throw new Error('OpenAI обрезал ответ. Проверьте размер материалов или модель.');
    const message = value?.choices?.[0]?.message;
    if (message?.tool_calls?.length || typeof message?.content !== 'string') throw new Error('OpenAI не вернул текст черновика.');
    const text = message.content.trim();
    if (!text || text.length > (structured?40000:6000)) throw new Error(structured?'Ответ OpenAI пуст или слишком большой.':'Черновик пуст или превышает 6000 символов.');
    return text;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Подготовка черновика отменена или время ожидания истекло.');
    if (error instanceof Error && /^(OpenAI |Ответ OpenAI |Черновик )/.test(error.message)) throw error;
    throw new Error('Не удалось обратиться к OpenAI. Проверьте соединение и настройки API.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function generateDialogDraft(options) {
  const text=await requestText(options);
  return {text,reason:'Черновик учитывает подтверждённое задание и доступную историю. Отправка не выполнялась.'};
}

export async function extractProductKeyPoints(options) {
  const images=options.images || [];
  const text=await requestText({...options,images,structured:true});
  let value;
  try {value=JSON.parse(text);}catch {throw new Error('OpenAI вернул некорректный список тезисов.');}
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('OpenAI вернул некорректный список тезисов.');
  const output={};
  for(const [key,max] of [['keyPoints',16000],['questions',8000],['warnings',4000]]) {
    if(typeof value[key]!=='string' || value[key].length>max)throw new Error('OpenAI вернул некорректные поля тезисов.');
    output[key]=value[key].trim();
  }
  if(!output.keyPoints)throw new Error('OpenAI не выделил тезисы. Проверьте исходные данные товара.');
  return output;
}
