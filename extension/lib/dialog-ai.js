// Provider access is deliberately separate from monitoring and has no browser tools.
export const AI_PROVIDERS = Object.freeze({
  openai:Object.freeze({id:'openai',label:'OpenAI',origin:'https://api.openai.com/*',endpoint:'https://api.openai.com/v1/chat/completions'}),
  anthropic:Object.freeze({id:'anthropic',label:'Claude (Anthropic)',origin:'https://api.anthropic.com/*',endpoint:'https://api.anthropic.com/v1/messages'}),
});
// Retain the original constants for callers that have not selected a provider.
export const AI_ORIGIN = AI_PROVIDERS.openai.origin;
export const AI_ENDPOINT = AI_PROVIDERS.openai.endpoint;

export function validateProvider(value='openai') {
  if (typeof value!=='string' || !Object.hasOwn(AI_PROVIDERS,value)) throw new Error('Выберите поддерживаемый сервис ИИ: OpenAI или Claude (Anthropic).');
  return value;
}

export function providerInfo(provider='openai') {
  return AI_PROVIDERS[validateProvider(provider)];
}

export function validateModel(value,provider='openai') {
  const info=providerInfo(provider);
  const model=String(value ?? '').trim();
  if (model && !/^[A-Za-z0-9._:-]{1,100}$/.test(model)) throw new Error(`Укажите корректное имя модели ${info.label}.`);
  return model;
}

function validateImages(images) {
  if (!Array.isArray(images) || images.length>8 || images.some(image=>typeof image!=='string' || image.length>4*1024*1024 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))) throw new Error('Неподдерживаемый формат или размер изображения.');
  if (images.reduce((total,image)=>total+image.length,0)>16*1024*1024) throw new Error('Изображения слишком велики для одного запроса.');
}

// Only errors constructed here may leave the transport boundary unchanged.
// A fetch implementation or server can echo credentials in any error message.
class ProviderResponseError extends Error {}

function requestBody({provider,model,prompt,images,structured}) {
  if (provider==='anthropic') {
    return {
      model,system:prompt.system,max_tokens:structured?6000:2000,
      messages:[{role:'user',content:images.length?[
        {type:'text',text:prompt.user},
        ...images.map(image=>{
          const [,media_type,data]=/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(image);
          return {type:'image',source:{type:'base64',media_type,data}};
        }),
      ]:prompt.user}],
    };
  }
  return {
    model,messages:[{role:'system',content:prompt.system},{role:'user',content:images.length?[
      {type:'text',text:prompt.user},...images.map(url=>({type:'image_url',image_url:{url,detail:'auto'}})),
    ]:prompt.user}],
    max_completion_tokens:structured?6000:2000,
    ...(structured?{response_format:{type:'json_object'}}:{}),
  };
}

function responseText(value,info) {
  const fail=message=>{throw new ProviderResponseError(`${info.label} ${message}`);};
  if (info.id==='anthropic') {
    if (value?.stop_reason==='max_tokens' || value?.stop_reason==='model_context_window_exceeded') fail('обрезал ответ. Проверьте размер материалов или модель.');
    if (value?.stop_reason==='refusal') fail('отказался подготовить ответ. Проверьте задание.');
    if (value?.type!=='message' || value?.role!=='assistant' || !['end_turn','stop_sequence'].includes(value?.stop_reason)) fail('не вернул завершённый текст ответа.');
    if (!Array.isArray(value.content) || !value.content.length || value.content.some(block=>block?.type!=='text' || typeof block.text!=='string')) fail('не вернул текст черновика.');
    return value.content.map(block=>block.text).join('\n').trim();
  }
  const choice=value?.choices?.[0];
  if (choice?.finish_reason==='length') fail('обрезал ответ. Проверьте размер материалов или модель.');
  if (choice?.finish_reason==='content_filter' || choice?.message?.refusal) fail('отказался подготовить ответ. Проверьте задание.');
  if (choice?.finish_reason!=null && choice.finish_reason!=='stop') fail('не вернул завершённый текст ответа.');
  const message=choice?.message;
  if (message?.tool_calls?.length || message?.function_call || typeof message?.content!=='string') fail('не вернул текст черновика.');
  return message.content.trim();
}

async function requestText({apiKey,model,prompt,provider='openai',signal,fetchImpl=globalThis.fetch,timeoutMs=45000,images=[],structured=false}) {
  const info=providerInfo(provider);
  model=validateModel(model,provider);
  if (typeof apiKey!=='string' || !apiKey.trim() || !model) throw new Error(`Укажите API-ключ и модель ${info.label} в настройках диалогов.`);
  if (apiKey.length>4096 || /[\r\n\u0000]/.test(apiKey)) throw new Error(`Укажите корректный API-ключ ${info.label}.`);
  validateImages(images);
  if (!prompt || typeof prompt.system!=='string' || typeof prompt.user!=='string') throw new Error('Не удалось подготовить контекст диалога.');
  const controller=new AbortController();
  const abort=()=>controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeoutMs);
  try {
    if (controller.signal.aborted) throw new Error('cancelled');
    const headers=provider==='anthropic'
      ? {'Content-Type':'application/json','x-api-key':apiKey.trim(),'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'}
      : {'Content-Type':'application/json',Authorization:`Bearer ${apiKey.trim()}`};
    const response=await fetchImpl(info.endpoint,{
      method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal,
      headers,body:JSON.stringify(requestBody({provider,model,prompt,images,structured})),
    });
    // Never expose provider bodies, status text or transport exception details.
    if (!response.ok) throw new ProviderResponseError(`${info.label} вернул HTTP ${Number(response.status) || 0}. Проверьте настройки и доступность API.`);
    const body=await response.text();
    if (controller.signal.aborted) throw new Error('cancelled');
    if (body.length>128000) throw new ProviderResponseError(`Ответ ${info.label} слишком большой.`);
    let value;
    try {value=JSON.parse(body);} catch {throw new ProviderResponseError(`${info.label} вернул некорректный ответ.`);}
    const text=responseText(value,info);
    if (!text || text.length>(structured?40000:6000)) throw new ProviderResponseError(structured?`Ответ ${info.label} пуст или слишком большой.`:'Черновик пуст или превышает 6000 символов.');
    return text;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Подготовка черновика отменена или время ожидания истекло.');
    if (error instanceof ProviderResponseError) throw error;
    throw new Error(`Не удалось обратиться к ${info.label}. Проверьте соединение и настройки API.`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',abort);
  }
}

export async function generateDialogDraft(options) {
  const text=await requestText(options);
  return {text,reason:'Черновик учитывает подтверждённое задание и доступную историю. Отправка не выполнялась.'};
}

export function parseProductKeyPoints(text,provider='openai') {
  const {label}=providerInfo(provider);
  if (typeof text!=='string' || text.length>40000) throw new Error(`${label} вернул некорректный список тезисов.`);
  let source=text.trim();
  // Claude and manually copied answers may wrap the entire object in a JSON fence.
  const fenced=/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(source);
  if (fenced) source=fenced[1].trim();
  let value;
  try {value=JSON.parse(source);} catch {throw new Error(`${label} вернул некорректный список тезисов.`);}
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(`${label} вернул некорректный список тезисов.`);
  const fields=[['keyPoints',16000],['questions',8000],['warnings',4000]];
  if (Object.keys(value).length!==fields.length || Object.keys(value).some(key=>!fields.some(([name])=>key===name))) throw new Error(`${label} вернул некорректные поля тезисов.`);
  const output={};
  for (const [key,max] of fields) {
    if (typeof value[key]!=='string' || value[key].length>max) throw new Error(`${label} вернул некорректные поля тезисов.`);
    output[key]=value[key].trim();
  }
  if (!output.keyPoints) throw new Error(`${label} не выделил тезисы. Проверьте исходные данные товара.`);
  return output;
}

export async function extractProductKeyPoints(options) {
  const text=await requestText({...options,images:options.images || [],structured:true});
  return parseProductKeyPoints(text,options.provider);
}
