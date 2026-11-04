import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const modulePath=process.env.WML_TEST_PUPPETEER_CORE || fileURLToPath(new URL('./test-output/browser-deps/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js',import.meta.url));
if(!fs.existsSync(modulePath)) throw new Error('브라우저 테스트용 puppeteer-core가 없습니다. RELEASING.md의 테스트 준비 방법을 확인하세요.');
const {default:puppeteer}=await import(pathToFileURL(path.resolve(modulePath)).href);
const candidates=process.platform==='win32' ? ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'] : ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'];
export const testChrome=process.env.WML_TEST_CHROME || process.env.AIP_TEST_CHROME || candidates.find(name=>fs.existsSync(name));
if(!testChrome || !fs.existsSync(testChrome)) throw new Error('브라우저 실행 파일이 없습니다. WML_TEST_CHROME에 Chrome 경로를 지정하세요.');
export default puppeteer;
