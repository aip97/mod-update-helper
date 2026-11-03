import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readArchive,inspectPackage,fingerprint} from './installer.mjs';
import os from 'node:os';
import path from 'node:path';
import {writeZip} from './zip-tools.mjs';
function archive({name='공용.md',badCRC=false,localName=name,flags=0}={}) {
 const raw=Buffer.from([0xb0,0xf8,0xbf,0xeb,0x2e,0x6d,0x64]),data=Buffer.from('fixture'),crc=fingerprint(data).crc;
 const extra=value=>{
   const utf8=Buffer.from(value),bytes=Buffer.alloc(9+utf8.length);bytes.writeUInt16LE(0x7075,0);bytes.writeUInt16LE(5+utf8.length,2);bytes[4]=1;
   bytes.writeUInt32LE(badCRC?123:fingerprint(raw).crc,5);utf8.copy(bytes,9);return bytes;
 };
 const centralExtra=extra(name),localExtra=extra(localName);
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(raw.length,26);local.writeUInt16LE(localExtra.length,28);
 const content=Buffer.concat([local,raw,localExtra,data]),central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,6);central.writeUInt16LE(flags,8);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(raw.length,28);central.writeUInt16LE(centralExtra.length,30);
 const directory=Buffer.concat([central,raw,centralExtra]),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(content.length,16);
 return Buffer.concat([content,directory,end]);
}
assert.equal((await readArchive(archive()))[0].path,'공용.md');
await assert.rejects(readArchive(archive({badCRC:true})),/Unicode/);
await assert.rejects(readArchive(archive({name:'../공용.md'})),/경로/);
await assert.rejects(readArchive(archive({localName:'다른.md'})),/Unicode/);
await assert.rejects(readArchive(archive({flags:0x800})),/encoded data|UTF-8/);
const temp=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'mod-preamble-')),'mod.zip');
const preamble="// comment with CRCRLF\r\r\ntry { const old = localStorage.getItem('old'); if(old) localStorage.setItem('new',old); const sample='WML.define({id:fake})'; } catch { /* migration */ }\n";
writeZip(temp,[{name:'mod.js',data:Buffer.from(preamble+"WML.define({id:'test-mod',version:'1.2.3',game:'faith',async setup(api){}});")}]);
assert.equal((await inspectPackage(fs.readFileSync(temp),undefined,'test-mod')).version,'1.2.3');
assert.equal(globalThis.localStorage,undefined,'metadata inspection never executes migration code');
writeZip(temp,[{name:'mod.js',data:Buffer.from("const fake='WML.define({id:fake})'; /* no declaration */")}]);
await assert.rejects(inspectPackage(fs.readFileSync(temp),undefined,'test-mod'),/메타데이터/);
const live=new URL('./test-output/tavern-tables-live.zip',import.meta.url);
if(fs.existsSync(live)) {
 const pkg=await inspectPackage(fs.readFileSync(live),undefined,'tavern-tables');
 assert.ok(pkg.files.some(file=>file.path.includes('공용')));
 console.log(`Live versionless ZIP: tavern-tables ${pkg.version}, Unicode file names inspected; no installation.`);
}
console.log('Legacy Windows Unicode ZIP paths: filename CRC, UTF-8 decoding, local/central agreement and traversal rejection passed.');
