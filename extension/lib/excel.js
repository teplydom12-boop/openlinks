import {linkResults,PLATFORMS,EVENT_LABELS,classify} from './core.js';
import {excelDate,timeZone,offsetText} from './time.js';

export const EXCEL_MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const WORKBOOK_MARKER='OpenLinks report.xlsx';
const encoder=new TextEncoder();
const xml=value=>String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').slice(0,32767)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const declaration='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const mainNS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationNS='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNS='http://schemas.openxmlformats.org/package/2006/relationships';
const crcTable=Uint32Array.from({length:256},(_,value)=>{
  for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);
  return value>>>0;
});
function crc32(bytes) {let crc=0xffffffff;for(const byte of bytes)crc=(crc>>>8)^crcTable[(crc^byte)&255];return (crc^0xffffffff)>>>0;}
function concat(parts) {
  const result=new Uint8Array(parts.reduce((size,part)=>size+part.length,0));let at=0;
  for(const part of parts){result.set(part,at);at+=part.length;}return result;
}
function header(size,fields) {
  const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);
  for(const [at,value,width] of fields)width===2?view.setUint16(at,value,true):view.setUint32(at,value,true);
  return bytes;
}
// Small, dependency-free ZIP (stored entries). No network, macros or formulas.
function zip(files) {
  const local=[],central=[];let offset=0;
  for(const [path,text] of Object.entries(files)) {
    const name=encoder.encode(path),body=encoder.encode(text),crc=crc32(body);
    const start=header(30,[[0,0x04034b50],[4,20,2],[6,0x800,2],[12,33,2],[14,crc],[18,body.length],[22,body.length],[26,name.length,2]]);
    local.push(start,name,body);
    central.push(header(46,[[0,0x02014b50],[4,20,2],[6,20,2],[8,0x800,2],[14,33,2],[16,crc],[20,body.length],[24,body.length],[28,name.length,2],[42,offset]]),name);
    offset+=start.length+name.length+body.length;
  }
  const directory=concat(central),count=Object.keys(files).length,comment=encoder.encode(WORKBOOK_MARKER);
  return concat([...local,directory,header(22,[[0,0x06054b50],[8,count,2],[10,count,2],[12,directory.length],[16,offset],[20,comment.length,2]]),comment]);
}
function sheet(headers,rows,widths) {
  if(rows.length>1048575)throw new Error('Для одного листа Excel слишком много строк. Сохраните полный текстовый отчёт.');
  const column=index=>String.fromCharCode(65+index),last=`${column(headers.length-1)}${rows.length+1}`,links=[];
  const render=(values,number,isHeader=false)=>{
    const cells=values.map((raw,index)=>{
      const cell=raw && typeof raw==='object'?raw:{value:raw},ref=column(index)+number,style=isHeader?1:cell.style || 0;
      if(cell.link)try {classify(cell.value);links.push({ref,url:cell.value});}catch { /* Plain text for unsupported URLs. */ }
      return typeof cell.value==='number' && Number.isFinite(cell.value)?`<c r="${ref}" s="${style}"><v>${cell.value}</v></c>`:
        `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(cell.value)}</t></is></c>`;
    }).join('');
    const height=isHeader?30:Math.min(90,Math.max(24,...values.map((raw,index)=>Math.ceil(String(raw?.value ?? raw ?? '').length/widths[index])*14)));
    return `<row r="${number}" ht="${height}" customHeight="1">${cells}</row>`;
  };
  const data=render(headers,1,true)+rows.map((row,index)=>render(row,index+2)).join('');
  const hyperlinks=links.length?`<hyperlinks>${links.map((link,index)=>`<hyperlink ref="${link.ref}" r:id="rId${index+1}"/>`).join('')}</hyperlinks>`:'';
  return {
    content:declaration+`<worksheet xmlns="${mainNS}" xmlns:r="${relationNS}"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="24"/><cols>${widths.map((width,index)=>`<col min="${index+1}" max="${index+1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${data}</sheetData><autoFilter ref="A1:${last}"/>${hyperlinks}</worksheet>`,
    relationships:declaration+`<Relationships xmlns="${packageNS}">${links.map((link,index)=>`<Relationship Id="rId${index+1}" Type="${relationNS}/hyperlink" Target="${xml(link.url)}" TargetMode="External"/>`).join('')}</Relationships>`,
  };
}
const styles=declaration+`<styleSheet xmlns="${mainNS}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy hh:mm:ss"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF087F70"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7F6ED"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCEBEC"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">${[{}, {font:1,fill:2}, {format:164}, {fill:3}, {fill:4}].map(s=>`<xf numFmtId="${s.format || 0}" fontId="${s.font || 0}" fillId="${s.fill || 0}" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`).join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
export function reportExcel(state) {
  const zone=timeZone(),zoneAt=at=>at==null?zone:`${zone} (UTC${offsetText(at)})`,date=at=>({value:excelDate(at) ?? '',style:2});
  const platform=url=>{try{return PLATFORMS[classify(url).platform].label;}catch{return '';}};
  const levels={action:'Действие',observation:'Наблюдение',decision:'Решение',wait:'Ожидание',error:'Ошибка'};
  const sheets=[
    sheet(['№','Площадка','Ссылка','Результат','Ошибок','Время на ПК','Часовой пояс','Причина / подробности','ID задачи'],
      linkResults(state).map((row,index)=>[index+1,platform(row.url),{value:row.url,link:true},{value:row.label,style:row.group==='worked'?3:row.group==='errors'?4:0},row.errorCount,date(row.at),zoneAt(row.at),row.reason,row.id]),[6,18,46,34,10,23,34,70,38]),
    sheet(['Время на ПК','Часовой пояс','Тип','Событие','Ссылка','Подробности','ID задачи'],
      state.events.map(e=>[date(e.at),zoneAt(e.at),levels[e.level] || 'Действие',EVENT_LABELS[e.type] || e.type,{value:e.url || '',link:true},e.detail,e.jobId || '']),[23,34,16,36,46,90,38]),
  ];
  const files={
    '[Content_Types].xml':declaration+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels':declaration+`<Relationships xmlns="${packageNS}"><Relationship Id="rId1" Type="${relationNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':declaration+`<workbook xmlns="${mainNS}" xmlns:r="${relationNS}"><sheets><sheet name="Результаты" sheetId="1" r:id="rId1"/><sheet name="События" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':declaration+`<Relationships xmlns="${packageNS}">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${relationNS}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="styles" Type="${relationNS}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml':styles,
  };
  sheets.forEach((s,i)=>{files[`xl/worksheets/sheet${i+1}.xml`]=s.content;files[`xl/worksheets/_rels/sheet${i+1}.xml.rels`]=s.relationships;});
  return zip(files);
}
