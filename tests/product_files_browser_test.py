"""Local product attachment parsing: real ZIP/PDF/image fixtures, no external requests."""
import base64
import functools
import http.server
import io
import os
from pathlib import Path
import struct
import threading
import zipfile
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
checks=0
def passed(name):
    global checks
    checks+=1
    print('PASS '+name,flush=True)
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
    def end_headers(self):
        self.send_header('Content-Security-Policy',"script-src 'self'; object-src 'none'")
        super().end_headers()
def zipped(entries):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,body in entries.items(): archive.writestr(name,body)
    return stream.getvalue()
def make_pdf(objects):
    data=bytearray(b'%PDF-1.4\n'); offsets=[0]
    for i,body in enumerate(objects,1):
        offsets.append(len(data)); data+=f'{i} 0 obj\n'.encode()+body+b'\nendobj\n'
    at=len(data); data+=f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    for offset in offsets[1:]:data+=f'{offset:010} 00000 n \n'.encode()
    data+=f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{at}\n%%EOF\n'.encode()
    return bytes(data)
def stream_pdf(content,extra=b''):
    return b'<< /Length '+str(len(content)).encode()+b' '+extra+b'>>\nstream\n'+content+b'\nendstream'
base_objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>']
pdf_text=make_pdf(base_objects+[b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',stream_pdf(b'BT /F1 16 Tf 20 160 Td (Steel pump; voltage 220 V; quantity 100 units.) Tj ET')])
png_stream=io.BytesIO(); Image.new('RGB',(60,40),(15,110,90)).save(png_stream,format='PNG'); png=png_stream.getvalue()
jpeg_stream=io.BytesIO(); Image.new('RGB',(60,40),(15,110,90)).save(jpeg_stream,format='JPEG');jpeg=jpeg_stream.getvalue()
pdf_scan=make_pdf(base_objects+[b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',stream_pdf(jpeg,b'/Type /XObject /Subtype /Image /Width 60 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode '),stream_pdf(b'q 300 0 0 200 0 0 cm /Im1 Do Q')])
pdf_mixed=make_pdf(base_objects+[b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /XObject << /Im1 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>',stream_pdf(jpeg,b'/Type /XObject /Subtype /Image /Width 60 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode '),stream_pdf(b'q 300 0 0 150 0 0 cm /Im1 Do Q BT /F1 16 Tf 20 180 Td (The diagram below describes the product.) Tj ET'),b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'])
pdf_broken_image=make_pdf(base_objects+[b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',stream_pdf(b'not a valid jpeg',b'/Type /XObject /Subtype /Image /Width 60 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode '),stream_pdf(b'q 300 0 0 200 0 0 cm /Im1 Do Q')])
gif_stream=io.BytesIO();Image.new('RGB',(20,20),'red').save(gif_stream,format='GIF');gif=gif_stream.getvalue()
animated_stream=io.BytesIO();Image.new('RGB',(20,20),'red').save(animated_stream,format='GIF',save_all=True,append_images=[Image.new('RGB',(20,20),'blue')],duration=100,loop=0);animated_gif=animated_stream.getvalue()
xlsx=zipped({
    'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Specifications" sheetId="1" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml':'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Steel pump</t></si></sst>',
    'xl/styles.xml':'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="10"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>100</v></c><c r="C1" s="1"><v>45292</v></c><c r="D1" s="2"><v>0.125</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>220 V</t></is></c><c r="B2"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>'
})
docx=zipped({'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Motor: </w:t></w:r><w:r><w:t>3 kW</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>MOQ 20</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>','word/media/image1.png':png})
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
  with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True)
    context=browser.new_context();external=[];errors=[]
    def local_only(route):
        if route.request.url.startswith('http://127.0.0.1:'):route.continue_()
        else: external.append(route.request.url);route.abort()
    context.route('**/*',local_only);page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(f'http://127.0.0.1:{server.server_port}/tests/fixtures/README.md')
    page.evaluate("async()=>{window.files=await import('/extension/lib/product-files.js');window.parse=async(name,data,type='',options={})=>{const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));return (await files.readProductFiles([new File([bytes],name,{type})],options))[0];};}")
    def parse(name,data,mime='',options=None):return page.evaluate('([name,data,mime,options])=>parse(name,data,mime,options)',[name,base64.b64encode(data).decode(),mime,options or {}])
    row=parse('specs.xlsx',xlsx)
    assert row['status']=='ready',row
    assert all(value in row['text'] for value in ['Steel pump','B1: 100','2024-01-01','12.5%','220 V','B2: 2']),row
    passed('XLSX reads compressed shared/inline strings, numbers, dates, percentages and cached formulas')
    row=parse('requirements.docx',docx)
    assert row['status']=='ready' and 'Motor: 3 kW' in row['text'] and 'MOQ 20' in row['text'] and len(row['images'])==1,row
    image=page.evaluate('key=>files.loadProductImage(key)',row['images'][0]['imageKey'])
    assert image.startswith('data:image/jpeg;base64,') and len(image)>50
    assert page.evaluate('id=>files.readProductOriginal(id).then(blob=>blob.size)',row['id'])==len(docx)
    page.evaluate('id=>files.deleteProductFile(id)',row['id'])
    assert page.evaluate('id=>files.readProductOriginal(id)',row['id']) is None
    missing=page.evaluate('key=>files.loadProductImage(key).then(()=>false,()=>true)',row['images'][0]['imageKey'])
    assert missing
    passed('DOCX text and images persist locally; deletion removes only that file and its images')
    page.evaluate('()=>{delete Map.prototype.getOrInsertComputed;delete Map.prototype.getOrInsert;}')
    row=parse('quote.pdf',pdf_text)
    assert row['status']=='ready' and 'Steel pump; voltage 220 V' in row['text'] and not row['images'],row
    assert page.evaluate('typeof Map.prototype.getOrInsertComputed')=='function'
    passed('bundled legacy PDF.js supplies compatibility helpers and extracts PDF text without external requests')
    row=parse('scan.pdf',pdf_scan)
    assert row['status']=='ready' and len(row['images'])==1 and row['images'][0]['page']==1,row
    assert 'ИИ' in row['note']
    passed('scanned PDF page is rendered locally and stored for explicit AI vision analysis')
    row=parse('text-and-diagram.pdf',pdf_mixed)
    assert row['status']=='ready' and 'diagram below' in row['text'] and len(row['images'])==1,row
    passed('PDF diagrams remain available to vision even when the page also has substantial text')
    row=parse('broken-image.pdf',pdf_broken_image)
    assert row['status'] in ['partial','error'] and ('декодировать' in row['note'] or row['error']),row
    passed('PDF.js silently rejected image decoding is surfaced as incomplete, never a successful blank scan')
    row=parse('picture.png',png)
    assert row['status']=='ready' and row['kind']=='image' and row['images'][0]['width']==60,row
    assert not any('data:' in str(value) for value in row.values())
    passed('image descriptors contain local keys instead of base64 stored in extension state')
    row=parse('static.gif',gif);assert row['status']=='ready' and row['images'][0]['mime']=='image/jpeg',row
    row=parse('animation.gif',animated_gif);assert row['status']=='partial' and 'первый кадр' in row['note'] and row['images'],row
    huge=bytearray(png);struct.pack_into('>I',huge,16,50000);struct.pack_into('>I',huge,20,50000)
    row=parse('huge.png',bytes(huge));assert row['status']=='error' and '40 миллионов' in row['error'],row
    passed('static GIF works, animation is explicitly partial and pixel bombs are rejected before decoding')
    row=parse('catalog.html',b'<html><script>window.documentExecuted=true</script><img src="https://example.invalid/tracker"><p>Power <b>220 V</b></p><iframe src="https://example.invalid/frame"></iframe></html>')
    assert row['text']=='Power 220 V' and row['status']=='partial' and not page.evaluate('Boolean(window.documentExecuted)'),row
    row=parse('html-table.html',b'Visible intro<table><tr><td>Voltage</td><td>220 V</td></tr></table>Visible outro')
    assert all(x in row['text'] for x in ['Visible intro','Voltage\t220 V','Visible outro']) and row['status']=='ready',row
    passed('HTML stays inert, strips executable content and never fetches document URLs')
    row=parse('spec.csv','Наименование;Количество\nНасос;100'.encode('utf-8'))
    assert row['status']=='ready' and 'Насос;100' in row['text'],row
    row=parse('spec.txt','Мощность 3 кВт'.encode('utf-16'))
    assert row['status']=='ready' and row['text']=='Мощность 3 кВт',row
    row=parse('old.txt','Мощность 3 кВт'.encode('cp1251'))
    assert row['status']=='partial' and 'Windows-1251' in row['note'] and 'Мощность' in row['text'],row
    passed('CSV and UTF-16 text preserve values; fallback encoding is explicitly marked for review')
    row=parse('long.txt',b'A'*60000)
    assert row['status']=='partial' and len(row['text'])==50000 and 'частично' in row['note'],row
    row=parse('budget.txt',b'A'*100,options={'textBudget':20})
    assert row['status']=='partial' and len(row['text'])==20,row
    passed('per-file and remaining context bounds report truncation instead of silently dropping text')
    row=parse('scan-budget.pdf',pdf_scan,options={'imageBudget':0})
    assert row['status']=='partial' and not row['images'] and 'не обработан' in row['note'],row
    passed('unread PDF scans remain explicitly partial when the image budget is exhausted')
    row=parse('old.xls',bytes([0xd0,0xcf,0x11,0xe0])+b'legacy')
    assert row['status']=='unsupported' and row['error'] and page.evaluate('id=>files.readProductOriginal(id).then(Boolean)',row['id']),row
    row=parse('broken.pdf',b'not a PDF','application/pdf');assert row['status']=='error' and 'формату' in row['error'],row
    row=parse('bad.json',b'{broken}');assert row['status']=='error' and 'JSON' in row['error'],row
    passed('unsupported legacy Office and corrupt documents retain visible error metadata and local originals')
    row=parse('entity.docx',zipped({'word/document.xml':'<!DOCTYPE x [<!ENTITY ext SYSTEM "https://example.invalid/secret">]><x>&ext;</x>'}))
    assert row['status']=='error' and 'сущностями' in row['error'],row
    passed('Office XML entity expansion and external entities are rejected')
    corrupt=bytearray(docx);position=corrupt.index(b'PK\x01\x02');struct.pack_into('<I',corrupt,position+24,30*1024*1024)
    row=parse('bomb.docx',bytes(corrupt));assert row['status']=='error' and 'предел' in row['error'],row
    corrupt=bytearray(docx);position=corrupt.index(b'PK\x01\x02');struct.pack_into('<I',corrupt,position+16,0)
    row=parse('corrupt.docx',bytes(corrupt));assert row['status']=='error' and 'контрольная сумма' in row['error'],row
    passed('ZIP expansion bounds and CRC validation reject malicious or corrupted Office archives')
    rows=page.evaluate("()=>files.readProductFiles(Array.from({length:9},(_,i)=>new File(['x'],`file${i}.txt`)))")
    assert len(rows)==9 and rows[-1]['status']=='error' and '8' in rows[-1]['error']
    row=page.evaluate("async()=>(await files.readProductFiles([new File([new Uint8Array(20*1024*1024+1)],'large.txt')]))[0]")
    assert row['status']=='error' and '20 МБ' in row['error'] and not row['contentHash']
    passed('file-count and upload-size limits return explicit per-file rejection without reading large files')
    owner='35e3217c-0f41-4fb3-b880-0c97cf99cf13'
    row=parse('owned.txt',b'Known request owner',options={'ownerId':owner})
    assert row['id']==owner and row['status']=='ready',row
    invalid=page.evaluate("()=>files.readProductFiles([new File(['x'],'x.txt')],{ownerId:'not-an-id'}).then(()=>false,()=>true)")
    assert invalid
    passed('a validated caller-owned UUID identifies local assets even before a parser reply arrives')
    page.evaluate("""async data=>{
      window.imageNative=createImageBitmap;window.abortController=new AbortController();window.bitmapStarted=false;
      window.createImageBitmap=blob=>{window.bitmapStarted=true;return new Promise(resolve=>{window.releaseBitmap=async()=>{const bitmap=await imageNative(blob);resolve(bitmap);return bitmap;};});};
      const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
      window.cancelResult=files.readProductFiles([new File([bytes],'slow.png',{type:'image/png'})],{ownerId:'7c005c3a-1977-4be0-a603-1d231a59d374',signal:abortController.signal}).then(()=>({ok:true}),error=>({name:error.name}));
    }""",base64.b64encode(png).decode())
    page.wait_for_function('() => window.bitmapStarted === true')
    assert page.evaluate("()=>files.readProductOriginal('7c005c3a-1977-4be0-a603-1d231a59d374').then(Boolean)")
    result=page.evaluate('async()=>{abortController.abort();return await cancelResult;}')
    assert result['name']=='AbortError',result
    assert page.evaluate("()=>files.readProductOriginal('7c005c3a-1977-4be0-a603-1d231a59d374')") is None
    assert page.evaluate('async()=>{window.createImageBitmap=imageNative;const bitmap=await releaseBitmap();await Promise.resolve();return bitmap.width;}')==0
    passed('disconnect-style cancellation removes a saved original and closes a late decoded bitmap')
    page.evaluate("""data=>{
      window.workerNative=Worker;window.pdfHeld=false;window.terminatedWorkers=0;window.workerURLs=[];window.pdfAbort=new AbortController();
      window.Worker=class extends workerNative {
        constructor(url,options){super(url,options);workerURLs.push({url:String(url),type:options.type});}
        postMessage(){window.pdfHeld=true;}
        terminate(){terminatedWorkers++;super.terminate();}
      };
      const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
      window.pdfCancelResult=files.readProductFiles([new File([bytes],'cancel.pdf',{type:'application/pdf'})],{ownerId:'8a315cd3-bbab-451a-babf-1ba79276f37f',signal:pdfAbort.signal}).then(()=>({ok:true}),error=>({name:error.name}));
    }""",base64.b64encode(pdf_text).decode())
    assert page.evaluate('async()=>{for(let i=0;i<100;i++){if(pdfHeld)return true;await new Promise(resolve=>setTimeout(resolve,10));}return false;}')
    result=page.evaluate('async()=>{pdfAbort.abort();const result=await Promise.race([pdfCancelResult,new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),2000))]);window.Worker=workerNative;return {result,terminatedWorkers,workerURLs};}')
    assert result['result'].get('name')=='AbortError' and result['terminatedWorkers']>=1,result
    assert len(result['workerURLs'])==1 and result['workerURLs'][0]['url'].endswith('/vendor/pdfjs/build/pdf.worker.min.mjs') and result['workerURLs'][0]['type']=='module',result
    assert page.evaluate("()=>files.readProductOriginal('8a315cd3-bbab-451a-babf-1ba79276f37f')") is None
    passed('PDF uses a direct local worker and cancellation terminates even a stalled initialization without waiting for its reply')
    page.evaluate("""()=>{
      window.dbAction=async fn=>{const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('openlinksProductFiles');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});return new Promise((resolve,reject)=>{const tx=db.transaction('attachments','readwrite');let result;fn(tx.objectStore('attachments'),value=>result=value);tx.oncomplete=()=>{db.close();resolve(result);};tx.onerror=()=>reject(tx.error);});};
      window.allAssets=()=>dbAction((store,done)=>{const req=store.getAll();req.onsuccess=()=>done(req.result);});
    }""")
    result=page.evaluate("""async()=>{
      const before=await allAssets(),now=Date.now(),old=now-3*24*60*60*1000;
      await dbAction(store=>{for(const [owner,createdAt,suffix] of [['old-orphan',old,'original'],['old-orphan',old,'image'],['old-kept',old,'original'],['fresh-unsaved',now,'original'],['mixed-owner',old,'original'],['mixed-owner',now,'image']])store.put({key:`test:${owner}:${suffix}`,owner,createdAt,blob:new Blob(['data'])});});
      const result=await files.pruneProductFiles([...new Set(before.map(r=>r.owner)),'old-kept']);
      const after=await allAssets();return {result,owners:[...new Set(after.map(r=>r.owner))],timestamps:before.every(r=>Number.isFinite(r.createdAt))};
    }""")
    assert result['result']['deleted']==2 and result['timestamps'],result
    assert 'old-orphan' not in result['owners'] and all(x in result['owners'] for x in ['old-kept','fresh-unsaved','mixed-owner']),result
    passed('garbage collection preserves referenced owners, fresh imports and old owners with any fresh asset')
    result=page.evaluate("""async()=>{
      await dbAction(store=>store.put({key:'test:quota',owner:'quota',createdAt:Date.now(),blob:{size:files.PRODUCT_FILE_LIMITS.storageBytes}}));
      const [record]=await files.readProductFiles([new File(['new data'],'quota.txt')]);
      const exists=Boolean(await files.readProductOriginal(record.id));await dbAction(store=>store.delete('test:quota'));return {record,exists};
    }""")
    assert result['record']['status']=='error' and '256 МБ' in result['record']['error'] and not result['exists'],result
    passed('the transactional storage budget rejects new data explicitly without leaving partial originals')
    assert not external,external
    assert not errors,errors
    passed('all parsing and PDF resources remain local; no external requests or page errors')
    browser.close()
finally:server.shutdown();server.server_close()
print(f'{checks} product file browser checks passed',flush=True)
