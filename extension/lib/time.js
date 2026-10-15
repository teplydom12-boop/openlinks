const pad=(value,size=2)=>String(value).padStart(size,'0');
const valid=at=>at!==null && at!==undefined && Number.isFinite(Number(at));
export const timeZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
export function offsetText(at) {
  const minutes=-new Date(at).getTimezoneOffset(),absolute=Math.abs(minutes);
  return `${minutes<0?'-':'+'}${pad(Math.floor(absolute/60))}:${pad(absolute%60)}`;
}
export function localTimestamp(at) {
  if(!valid(at))return '—';
  const date=new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(),3)}${offsetText(at)}`;
}
export function displayTime(at) {
  return valid(at)?new Date(at).toLocaleString('ru-RU',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
}
// Excel stores a timezone-free wall clock. Use local date components, not UTC.
export function excelDate(at) {
  if(!valid(at))return null;
  const date=new Date(at);
  return Date.UTC(date.getFullYear(),date.getMonth(),date.getDate(),date.getHours(),date.getMinutes(),date.getSeconds(),date.getMilliseconds())/86400000+25569;
}
