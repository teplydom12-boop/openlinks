import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {inspectZip,inspectImage,detectFormat,PRODUCT_FILE_LIMITS} from '../extension/lib/product-files.js';

function archive({name='word/document.xml',text='<document/>',declared,method=8,flags=0,duplicate=false}={}) {
  const filename=Buffer.from(name),body=Buffer.from(text),compressed=method===0?body:deflateRawSync(body),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(declared??body.length,22);local.writeUInt16LE(filename.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(flags,8);central.writeUInt16LE(method,10);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(declared??body.length,24);central.writeUInt16LE(filename.length,28);
  const entries=duplicate?[central,filename,central,filename]:[central,filename],offset=local.length+filename.length+compressed.length,centralBytes=entries.reduce((n,x)=>n+x.length,0);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(duplicate?2:1,8);end.writeUInt16LE(duplicate?2:1,10);end.writeUInt32LE(centralBytes,12);end.writeUInt32LE(offset,16);
  return new Uint8Array(Buffer.concat([local,filename,compressed,...entries,end]));
}
test('attachment limits are finite and shared with product context bounds',()=>{
  assert.equal(PRODUCT_FILE_LIMITS.files,8);assert.equal(PRODUCT_FILE_LIMITS.textPerFile,50000);assert.equal(PRODUCT_FILE_LIMITS.textTotal,150000);assert.equal(PRODUCT_FILE_LIMITS.images,8);
});
test('format detection uses binary signatures instead of trusting renamed files',()=>{
  assert.equal(detectFormat(new TextEncoder().encode('%PDF-1.7\n'),'fake.txt'),'pdf');
  assert.equal(detectFormat(new Uint8Array([0x89,0x50,0x4e,0x47,13,10,26,10]),'image.bin'),'image/png');
  assert.throws(()=>detectFormat(new TextEncoder().encode('<script>evil()</script>'),'image.png','image/png'),/не соответствует/);
  assert.equal(detectFormat(new Uint8Array([0xd0,0xcf,0x11,0xe0]),'old.xls'),'unsupported');
  assert.equal(detectFormat(new TextEncoder().encode('a,b\n1,2'),'table.csv'),'text');
});
test('ZIP inspection accepts valid bounded deflate entries without decompressing them',()=>{
  const result=inspectZip(archive());assert.equal(result.length,1);assert.equal(result[0].name,'word/document.xml');assert.equal(result[0].expanded,11);assert.equal(result[0].method,8);
});
test('ZIP rejects expansion bombs and oversized entries before inflate',()=>{
  assert.throws(()=>inspectZip(archive({declared:PRODUCT_FILE_LIMITS.zipEntryBytes+1})),/предел/);
  assert.throws(()=>inspectZip(archive({declared:5*1024*1024})),/предел/);
});
test('ZIP rejects path traversal, duplicate names, encryption and unsupported codecs',()=>{
  for(const name of ['../word/document.xml','/word/document.xml','word\\document.xml'])assert.throws(()=>inspectZip(archive({name})),/имена/);
  assert.throws(()=>inspectZip(archive({duplicate:true})),/повторяющиеся/);
  assert.throws(()=>inspectZip(archive({flags:1})),/паролем/);
  assert.throws(()=>inspectZip(archive({method:99})),/сжатие/);
});
test('ZIP rejects truncated data, central-directory mismatches and multi-disk files',()=>{
  const bytes=archive();assert.throws(()=>inspectZip(bytes.slice(0,-3)),/повреждён/);
  const badLocal=bytes.slice();badLocal[30]=0x71;assert.throws(()=>inspectZip(badLocal),/заголовки/);
  const badDisk=bytes.slice();new DataView(badDisk.buffer).setUint16(badDisk.length-18,1,true);assert.throws(()=>inspectZip(badDisk),/составные/);
});
test('image header preflight rejects enormous decoded pixel allocations',()=>{
  const bytes=new Uint8Array(24),view=new DataView(bytes.buffer);view.setUint32(16,50000);view.setUint32(20,50000);
  assert.throws(()=>inspectImage(bytes,'image/png'),/предел/);
  view.setUint32(16,600);view.setUint32(20,400);assert.deepEqual(inspectImage(bytes,'image/png'),{width:600,height:400,animated:false});
  assert.throws(()=>inspectImage(new Uint8Array([1,2,3]),'image/jpeg'),/заголовок/);
});
