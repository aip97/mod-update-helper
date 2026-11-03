import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

export const publicKeyOf = key => {
  const jwk=crypto.createPublicKey(key).export({format:'jwk'});
  return {modulus:Buffer.from(jwk.n,'base64url').toString('base64'),exponent:Buffer.from(jwk.e,'base64url').toString('base64')};
};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function signRelease(zipFile,config,privateKey) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(config.repository) || JSON.stringify(publicKeyOf(privateKey)) !== JSON.stringify(config.publicKey)) throw new Error('Repository or signing key does not match the public release configuration.');
  const bytes=fs.readFileSync(zipFile), files=[]; let offset=0,manifest;
  while (offset+30<bytes.length && bytes.readUInt32LE(offset)===0x04034b50) {
    const method=bytes.readUInt16LE(offset+8), packed=bytes.readUInt32LE(offset+18), size=bytes.readUInt32LE(offset+22);
    const length=bytes.readUInt16LE(offset+26), extra=bytes.readUInt16LE(offset+28), start=offset+30+length+extra;
    if (bytes.readUInt16LE(offset+6)!==0x800 || extra || ![0,8].includes(method) || size>16777216 || start+packed>bytes.length) throw new Error('Use a ZIP created by package.mjs.');
    const name=bytes.subarray(offset+30,offset+30+length).toString('utf8');
    const source=bytes.subarray(start,start+packed), data=method===8 ? zlib.inflateRawSync(source,{maxOutputLength:16777216}) : source;
    if (data.length!==size || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) throw new Error('Invalid packaged file.');
    if (name==='manifest.json') manifest=JSON.parse(data);
    files.push({path:name,size,sha256:sha(data)}); offset=start+packed;
  }
  if (!manifest || files.length<10 || bytes.readUInt32LE(offset)!==0x02014b50) throw new Error('Incomplete extension package.');
  const extensionId=sha(Buffer.from(manifest.key,'base64')).slice(0,32).replace(/./g,c=>String.fromCharCode(97+parseInt(c,16)));
  const asset=`Mod-Update-Helper-User-${manifest.version}.zip`;
  if (path.basename(zipFile)!==asset) throw new Error('Version and ZIP filename differ.');
  const payload=Buffer.from(JSON.stringify({schema:1,repository:config.repository,extensionId,version:manifest.version,asset,size:bytes.length,sha256:sha(bytes),files}));
  return {payload:payload.toString('base64'),signature:crypto.sign('sha256',payload,privateKey).toString('base64')};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const dir=path.dirname(fileURLToPath(import.meta.url)), [command,value]=process.argv.slice(2);
  const keyFile=path.join(dir,'.release-signing/private-key.pem'), configFile=path.join(dir,'self-update-config.json');
  if (command==='init') {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value || '')) throw new Error('Usage: node release.mjs init owner/repository');
    fs.mkdirSync(path.dirname(keyFile),{recursive:true});
    if (!fs.existsSync(keyFile)) {
      const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
      fs.writeFileSync(keyFile,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
    }
    const key=fs.readFileSync(keyFile);
    fs.writeFileSync(configFile,JSON.stringify({schema:1,repository:value,publicKey:publicKeyOf(key)},null,2)+'\n');
    console.log('Public release configuration saved. The private key stays in .release-signing/.');
  } else if (command==='sign') {
    const config=JSON.parse(fs.readFileSync(configFile)), version=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'))).version;
    const output=path.resolve(value || dir), zipFile=path.join(output,`Mod-Update-Helper-User-${version}.zip`);
    const envelope=signRelease(zipFile,config,fs.readFileSync(keyFile));
    fs.writeFileSync(path.join(output,'wml-updater-release.json'),JSON.stringify(envelope)+'\n',{flag:'wx'});
    console.log('Signed release metadata created.');
  } else throw new Error('Usage: node release.mjs init owner/repository | sign [output-directory]');
}
