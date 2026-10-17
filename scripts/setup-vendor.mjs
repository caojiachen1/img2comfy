// 拉取 AI 运行时到 vendor/：transformers.js 浏览器包 + onnxruntime-web 的 wasm 与 ESM bundle。
// 关键点：transformers.web.min.mjs 里有两个裸说明符（onnxruntime-common、onnxruntime-web/webgpu），
// 浏览器不解析裸说明符，所以必须本地化成相对路径并让它们指向同一份 ORT bundle，
// 否则会出现两份 ORT 实例、Tensor 的 instanceof 判断直接失效。
// 用法：node scripts/setup-vendor.mjs [--version 4.3.1]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor');
const TMP = path.join(ROOT, '.vendor-tmp');
const argv = process.argv.slice(2);
const VERSION = argv.includes('--version') ? argv[argv.indexOf('--version') + 1] : '4.3.1';
const log = console.log;

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(VENDOR, { recursive: true });

log(`1/5 安装 @huggingface/transformers@${VERSION}（仅取文件，不装 sharp 的原生构建）…`);
execFileSync('npm', ['install', `@huggingface/transformers@${VERSION}`, '--no-save', '--no-audit', '--ignore-scripts', '--prefix', TMP], { stdio: 'inherit', shell: process.platform === 'win32' });

const tfDist = path.join(TMP, 'node_modules', '@huggingface', 'transformers', 'dist');
const ortDist = path.join(TMP, 'node_modules', 'onnxruntime-web', 'dist');
if (!fs.existsSync(tfDist) || !fs.existsSync(ortDist)) throw new Error('npm 安装后没找到 dist 目录');

const pick = (dir, names) => {
    const have = fs.readdirSync(dir);
    for (const n of names) if (have.includes(n)) return n;
    return null;
};

// ORT 的 webgpu bundle 自带 onnxruntime-common，两个说明符都指向它，保证单实例
const ortBundle = pick(ortDist, ['ort.webgpu.bundle.min.mjs', 'ort.webgpu.min.mjs', 'ort.all.bundle.min.mjs', 'ort.bundle.min.mjs', 'ort.all.min.mjs', 'ort.min.mjs']);
if (!ortBundle) throw new Error('onnxruntime-web/dist 里没找到可用的 ESM bundle');
fs.copyFileSync(path.join(ortDist, ortBundle), path.join(VENDOR, ortBundle));
log(`   + ${ortBundle} (${(fs.statSync(path.join(VENDOR, ortBundle)).size / 1048576).toFixed(2)}MB)`);

// ---- 用户脚本引擎：QuickJS 编译成 wasm ------------------------------------
// 走这条路是为了彻底不用 manifest 的 sandbox 页、也不需要 'unsafe-eval'
// （MV3 的 extension_pages 明确禁止 unsafe-eval，只放行 wasm-unsafe-eval）。
// index.global.js 是自带全局 QJS 的 IIFE（实测零裸导入），变体包的 glue 用相对路径
// 取同目录 wasm，所以整包拷进 vendor/quickjs/ 就能在宿主页直接 import。
log('1b/5 安装 quickjs-emscripten（用户脚本引擎）…');
execFileSync('npm', ['install', 'quickjs-emscripten@0.32.0', '@jitl/quickjs-wasmfile-release-asyncify@0.32.0',
    '--no-save', '--no-audit', '--ignore-scripts', '--prefix', TMP], { stdio: 'inherit', shell: process.platform === 'win32' });
const qjsGlobal = path.join(TMP, 'node_modules', 'quickjs-emscripten', 'dist', 'index.global.js');
const variantDir = path.join(TMP, 'node_modules', '@jitl', 'quickjs-wasmfile-release-asyncify', 'dist');
if (!fs.existsSync(qjsGlobal) || !fs.existsSync(variantDir)) throw new Error('quickjs 包没装到位');
const QJS_DIR = path.join(VENDOR, 'quickjs');
fs.mkdirSync(QJS_DIR, { recursive: true });
fs.copyFileSync(qjsGlobal, path.join(QJS_DIR, 'quickjs-emscripten.global.js'));
log(`   + quickjs/quickjs-emscripten.global.js (${(fs.statSync(path.join(QJS_DIR, 'quickjs-emscripten.global.js')).size / 1024).toFixed(0)}KB)`);
for (const f of fs.readdirSync(variantDir)) {
    if (/\.(mjs|wasm)$/.test(f)) {
        let text = fs.readFileSync(path.join(variantDir, f), 'utf8');
        // 变体入口用的是裸说明符（靠打包器的 browser condition 解析），浏览器不认，
        // 指到同目录的 browser glue（它用 import.meta.url + locateFile 取 wasm）
        if (f === 'index.mjs') {
            text = text.replace(/import\(\s*["']@jitl\/quickjs-wasmfile-release-asyncify\/emscripten-module["']\s*\)/g,
                'import("./emscripten-module.browser.mjs")');
        }
        if (f === 'ffi.mjs') {
            // 只引入类型包里的断言工具（本文件其实没用到），换成恒等函数
            text = text.replace(/import\s*\{[^}]*\}\s*from\s*["']@jitl\/quickjs-ffi-types["'];?/g, 'const assertSync = ((v) => v);');  // 压缩单行文件里不能投行注释，用表达式替换
        }
        fs.writeFileSync(path.join(QJS_DIR, f), text);
        if (f.endsWith('.wasm')) log(`   + quickjs/${f} (${(fs.statSync(path.join(QJS_DIR, f)).size / 1048576).toFixed(2)}MB)`);
    }
}

// wasm 与它的 glue（glue 用相对路径找 wasm，所以必须同目录）
// 扩展页不是 crossOriginIsolated，没有 SharedArrayBuffer，ORT 会选 asyncify 版；
// WebGPU 走 jsep，普通 CPU 走 simd-threaded。三套 glue+wasm 都要带上，缺一个就
// "no available backend found"。jspgl 版只有显式开 JSP 时才用，不带。
const glueAndWasm = [
    'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm',
];
for (const f of glueAndWasm) {
    const src = path.join(ortDist, f);
    if (!fs.existsSync(src)) { log('   跳过（不存在）', f); continue; }
    fs.copyFileSync(src, path.join(VENDOR, f));
    log(`   + ${f} (${(fs.statSync(src).size / 1048576).toFixed(2)}MB)`);
}

log('2/5 生成说明符垫片…');
const commonShim = 'onnxruntime-common.mjs';
const webgpuShim = 'onnxruntime-web-webgpu.mjs';
fs.writeFileSync(path.join(VENDOR, commonShim), `// 自动生成：把裸说明符 onnxruntime-common 指向本地 ORT bundle（同一实例）\nexport * from './${ortBundle}';\n`);
fs.writeFileSync(path.join(VENDOR, webgpuShim), `// 自动生成：把裸说明符 onnxruntime-web/webgpu 指向本地 ORT bundle（同一实例）\nexport * from './${ortBundle}';\n`);
log(`   + ${commonShim}, ${webgpuShim}`);

log('3/5 本地化 transformers 浏览器包…');
const src = fs.readFileSync(path.join(tfDist, 'transformers.web.min.js'), 'utf8');
const patched = src
    .replace(/from\s*["']onnxruntime-web\/webgpu["']/g, `from "./${webgpuShim}"`)
    .replace(/from\s*["']onnxruntime-common["']/g, `from "./${commonShim}"`)
    .replace(/import\s*\(\s*["']onnxruntime-web\/webgpu["']\s*\)/g, `import("./${webgpuShim}")`)
    .replace(/import\s*\(\s*["']onnxruntime-common["']\s*\)/g, `import("./${commonShim}")`);
const left = (patched.match(/from["'](?!["'.])|from ["'](?!["'.])/g) || []).length;
for (const name of ['transformers.web.min.js', 'transformers.web.min.mjs']) fs.writeFileSync(path.join(VENDOR, name), patched);
log(`   + transformers.web.min.js / .mjs (${(Buffer.byteLength(patched) / 1024).toFixed(0)}KB)，残留裸说明符 ${left} 处`);
if (left > 0) {
    const m = patched.match(/from\s*["']([^'".][^"']*)["']/g) || [];
    log('     需要再加垫片的说明符：', [...new Set(m)].join(' , '));
}

log('4/5 校验 ORT bundle 自身没有裸说明符…');
const ortSrc = fs.readFileSync(path.join(VENDOR, ortBundle), 'utf8');
const ortBare = [...new Set((ortSrc.match(/from\s*["']([^'".\/][^"']*)["']/g) || []))];
log(ortBare.length ? `     ⚠ ORT bundle 里还有裸说明符：${ortBare.join(', ')}` : '     干净');

log('5/5 清理临时目录…');
fs.rmSync(TMP, { recursive: true, force: true });

const all = fs.readdirSync(VENDOR).map((f) => ({ f, s: fs.statSync(path.join(VENDOR, f)).size }));
log('\nvendor/ 内容：');
for (const e of all.sort((a, b) => b.s - a.s)) log('  ' + (e.s / 1048576).toFixed(2).padStart(8) + ' MB  ' + e.f);
log('  合计 ' + (all.reduce((a, b) => a + b.s, 0) / 1048576).toFixed(1) + ' MB');
log('\n接着 node scripts/build-content.mjs，然后 node test/run_browser.mjs --ai 验证真实推理。');
