// 把扩展用到的模型从 HF 镜像到自己的 ModelScope 命名空间。
// 清单直接读 src/common/ai/*.js 里的预设，避免两处各写一份、日后对不上。
//
//   node scripts/ms-mirror.mjs --list                只打印计划与体积
//   node scripts/ms-mirror.mjs                       搬小件（默认跳过 >300MB 的仓库）
//   node scripts/ms-mirror.mjs --only=face,slimsam   只搬指定条目
//   node scripts/ms-mirror.mjs --all                 全搬（多模态几个 GB，慢慢跑）
//   node scripts/ms-mirror.mjs --all --prune         每个仓库传成功后删掉本地中间产物
//
// 依赖：已登录的 modelscope CLI（建仓库与上传）。下载走 resolve 直链，不需要 hf CLI。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NS = process.env.MS_NS || 'cjc1887415157';
const HF = process.env.HF_ENDPOINT || 'https://hf-mirror.com';
const MS = 'https://www.modelscope.cn';
const WORK = path.join(ROOT, 'ms-mirror');
const argv = process.argv.slice(2);
const LIST = argv.includes('--list');
const ALL = argv.includes('--all');
const PRUNE = argv.includes('--prune');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1]?.split(',').filter(Boolean) || [];
const BIG = 300 * 1048576;         // 默认不动超过这个体积的仓库
const MB = (n) => (n / 1048576).toFixed(1);

const P = (await import('../src/common/ai/vlm.js')).VLM_PRESETS;
const S = (await import('../src/common/ai/sam.js')).SAM_PRESETS;
const R = (await import('../src/common/ai/sr.js')).SR_PRESETS;
const V = await import('../src/common/ai/vision.js');

/**
 * 每个条目：key（--only 用）、repo（HF 源）、dtypes（扩展真会用到的量化档位，只搬这些权重）、
 * target（ModelScope 仓库名）。元数据（config/tokenizer/json，<8MB）全带上，缺一个 transformers.js 就起不来。
 */
const ENTRIES = [
    ...P.map((p) => ({ key: p.id, repo: p.model, dtypes: ['q4', 'q4f16'], kind: 'vlm' })),
    ...S.map((p) => ({ key: p.id, repo: p.model, dtypes: [p.dtype || 'q4'], kind: 'sam' })),
    ...R.filter((p) => p.model).map((p) => ({ key: p.id, repo: p.model, dtypes: ['q4', 'quantized'], kind: 'sr' })),
    ...V.TAG_PRESETS.map((p) => ({ key: p.id, repo: p.model, dtypes: [p.dtype || 'q4'], kind: 'tags' })),
    ...V.DEPTH_PRESETS.map((p) => ({ key: p.id, repo: p.model, dtypes: [p.dtype || 'q4'], kind: 'depth' })),
    { key: 'face', repo: 'WePrompt/buffalo_sc', dtypes: [], kind: 'face', files: ['det_500m.onnx', 'w600k_mbf.onnx'] },
    { key: 'face-10g', repo: 'public-data/insightface', dtypes: [], kind: 'face', files: ['models/buffalo_l/det_10g.onnx'], flat: { 'models/buffalo_l/det_10g.onnx': 'det_10g.onnx' } },
];

function targetOf(e) {
    if (e.kind === 'face') return 'mtb-face';
    return e.repo.split('/').pop();
}

async function hfTree(repo) {
    const r = await fetch(`${HF}/api/models/${repo}/tree/main?recursive=true`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`列 ${repo} 失败 HTTP ${r.status}`);
    const d = await r.json();
    if (!Array.isArray(d)) throw new Error(`列 ${repo} 失败：${JSON.stringify(d).slice(0, 100)}`);
    return d.filter((x) => x.type === 'file').map((x) => ({ path: x.path, size: (x.lfs && x.lfs.size) || x.size || 0 }));
}

async function msTree(repoId) {
    const r = await fetch(`${MS}/api/v1/models/${repoId}/repo/files?Revision=master&Recursive=true`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const list = (d?.Data?.Files || []).filter((f) => f.Type !== 'tree');
    if (!list.length) throw new Error('空仓库');
    return list.map((f) => ({ path: f.Path, size: f.Size || 0 }));
}

async function msFiles(repoId) {
    try { return new Map((await msTree(repoId)).map((f) => [f.path, f.size])); } catch (e) { return null; }
}

const IS_WEIGHT = (p) => /\.onnx$/.test(p) || /\.onnx_data(_\d+)?$/.test(p);
// 一律不搬的：pytorch/原生权重、ONNX Runtime 的 genai 专用导出（transformers.js 用不到）
const IS_JUNK = (p) => /\.(safetensors|pth|bin|h5|ckpt|gguf|tflite|meta)$/.test(p) || p.startsWith('onnxruntime/') || p.startsWith('_original_');

function pick(files, e) {
    if (e.files) return files.filter((f) => e.files.includes(f.path));
    const onnx = files.filter((f) => IS_WEIGHT(f.path));
    // 元数据不设体积上限：tokenizer.json 常常 10MB+，卡 8MB 会把多模态仓库的 tokenizer 整个漏掉，
    // 结果就是「模型下好了但 pipeline 起不来」
    const meta = files.filter((f) => !IS_WEIGHT(f.path) && !IS_JUNK(f.path));
    const tokens = e.dtypes.filter(Boolean);
    let weights = tokens.length ? onnx.filter((f) => tokens.some((t) => new RegExp(`_${t}(\\.onnx|\\.onnx_data)$`).test(f.path))) : [];
    const total = files.reduce((a, f) => a + f.size, 0);
    if (!weights.length || total < 90 * 1048576) weights = onnx;      // 小仓库整搬，省得漏文件
    return [...meta, ...weights];
}

function sh(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args, { shell: false, ...opts });
        let err = '';
        p.stderr?.on('data', (b) => { err += b.toString(); if (opts.quiet) return; process.stderr.write(b.toString().slice(-400)); });
        p.stdout?.on('data', (b) => { if (!opts.quiet) process.stdout.write(b.toString().slice(-400)); });
        p.on('close', (code) => resolve({ code, err: err.slice(-600) }));
        p.on('error', (e) => resolve({ code: -1, err: String(e.message || e) }));
    });
}

// 自己按 resolve 直链下：hf CLI 1.x 走 xet 通道，在部分网络下连不上；
// 更要紧的是中途断流时 fetch 不报错、只给半截文件，所以这里带字节数校验与 Range 续传。
async function downloadUrl(url, dest, expect, { tries = 5 } = {}) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    for (let attempt = 1; attempt <= tries; attempt++) {
        let have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        if (expect && have === expect) return true;
        const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, cache: 'no-store' }).catch((e) => { console.log(`   取 ${path.basename(dest)} 失败：${e.message}`); return null; });
        if (!res) continue;
        if (res.status === 404) { console.log(`   404：${url}`); return false; }
        if (have && res.status !== 206) { have = 0; }        // 服务端不肯续传，从头再来
        const out = fs.createWriteStream(dest, have && res.status === 206 ? { flags: 'a' } : {});
        try {
            // Node 的 fetch 给的是 web 流，没有 .on；直接异步迭代写盘
            for await (const chunk of res.body) out.write(chunk);
            await new Promise((resolve, reject) => { out.end(() => resolve()); out.on('error', reject); });
        } catch (e) { console.log(`   写到一半断了（第 ${attempt} 次）：${String(e.message || e).slice(0, 80)}`); }
        const now = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        if (!expect || now === expect) return true;
        console.log(`   字节不符（${now}/${expect}），重试 ${attempt}/${tries}`);
    }
    return false;
}

fs.mkdirSync(WORK, { recursive: true });
const plan = [];
for (const e of ENTRIES) {
    if (ONLY.length && !ONLY.includes(e.key)) continue;
    // ModelScope 上多半已有同名同步仓（逐字节同源，实测 sha256 一致），从它拉比 HF 快 5~10 倍
    let files = null, src = null;
    try { files = await msTree(e.repo); src = { kind: 'ms', repo: e.repo }; } catch (err) {
        try { files = await hfTree(e.repo); src = { kind: 'hf', repo: e.repo }; } catch (err2) { console.log(`跳过 ${e.key}（${e.repo}）：${err2.message}`); continue; }
    }
    const chosen = pick(files, e);
    const size = chosen.reduce((a, f) => a + f.size, 0);
    const have = await msFiles(`${NS}/${targetOf(e)}`);
    const todo = chosen.filter((f) => !have || have.get(f.path.replace(/^models\/buffalo_l\//, '')) !== f.size);
    plan.push({ e, src, chosen, size, todo: todo.map((f) => f.path), todoSize: todo.reduce((a, f) => a + f.size, 0) });
}

const bigOnes = plan.filter((p) => p.size > BIG);
const smallOnes = plan.filter((p) => p.size <= BIG);
const work = ALL ? plan : smallOnes;
console.log(`命名空间 ${NS}`);
for (const p of plan) {
    const tag = p.size > BIG ? (ALL ? '大件' : '大件·默认跳过') : '小件';
    console.log(`  ${tag}  ${p.e.key.padEnd(18)} ${p.e.repo.padEnd(46)} → ${targetOf(p.e).padEnd(42)} ${MB(p.size)} MB  待传 ${p.todo.length} 个 / ${MB(p.todoSize)} MB`);
}
const totalTodo = work.reduce((a, p) => a + p.todoSize, 0);
console.log(`\n本轮要传：${work.length} 个仓库 / ${MB(totalTodo)} MB${ALL ? '' : `（另有 ${bigOnes.length} 个大件 ${(bigOnes.reduce((a, p) => a + p.todoSize, 0) / 1073741824).toFixed(2)} GB，加 --all 再搬）`}`);
if (LIST) process.exit(0);
if (!totalTodo) { console.log('全都传过了，收工。'); process.exit(0); }

for (const p of work) {
    if (!p.todo.length) { console.log(`== ${p.e.key} 已是最新，跳过`); continue; }
    const dir = path.join(WORK, targetOf(p.e));
    fs.mkdirSync(dir, { recursive: true });
    const sizes = new Map(p.chosen.map((f) => [f.path, f.size]));
    const base = p.src.kind === 'ms' ? `${MS}/models/${p.src.repo}/resolve/master` : `${HF}/${p.src.repo}/resolve/main`;
    console.log(`\n== ${p.e.key}  ${p.src.kind === 'ms' ? 'ModelScope' : 'HF'}/${p.src.repo} → ${NS}/${targetOf(p.e)}  下载 ${p.todo.length} 个文件 / ${MB(p.todoSize)} MB`);
    let failed = 0;
    for (const rel of p.todo) {
        if (!(await downloadUrl(`${base}/${rel}`, path.join(dir, rel), sizes.get(rel)))) failed++;
    }
    if (failed) { console.log(`   ${failed} 个文件没取全，跳过上传`); continue; }
    for (const [from, to] of Object.entries(p.e.flat || {})) {
        const src = path.join(dir, from);
        if (fs.existsSync(src)) { fs.renameSync(src, path.join(dir, to)); }
    }
    for (const junk of ['.msc', '.mv', '.ms_upload_cache', '.cache', '.git']) {
        fs.rmSync(path.join(dir, junk), { recursive: true, force: true });
    }
    for (const from of Object.keys(p.e.flat || {})) {
        fs.rmSync(path.join(dir, from.split('/')[0]), { recursive: true, force: true });   // 展平后剩下的嵌套空壳
    }
    // 半截文件传上去就是「protobuf parsing failed」，这里按源仓库声明的字节数逐个卡。
    // 只卡本轮真的下载过的那些：其余是服务器上已存在的（待传就是按服务端清单算的），本地没有属正常。
    const bad = [];
    for (const rel of p.todo) {
        const key = rel.replace(/^models\/buffalo_l\//, '');
        const f = path.join(dir, key);
        const want = sizes.get(rel);
        if (!fs.existsSync(f)) { bad.push(key + ' 缺失'); continue; }
        if (fs.statSync(f).size !== want) bad.push(`${key} 字节不符 ${fs.statSync(f).size}≠${want}`);
    }
    if (bad.length) { console.log(`   字节校验没过，跳过上传：${bad.slice(0, 4).join(' ; ')}`); continue; }
    await sh('modelscope', ['create', `${NS}/${targetOf(p.e)}`, '--repo_type', 'model', '--visibility', 'public', '--exist_ok'], { quiet: true });
    const up = await sh('modelscope', ['upload', `${NS}/${targetOf(p.e)}`, dir, '--commit-message', `mirror ${p.e.repo}`], { quiet: true });
    if (up.code !== 0) { console.log(`   上传失败（exit ${up.code}）：${up.err.slice(-400)}`); continue; }
    console.log(`   已上传 ${MB(p.todoSize)} MB → ${MS}/models/${NS}/${targetOf(p.e)}`);
    if (PRUNE) {
        // 仓库里已经有了（--list 是按服务端清单算待传的），本地留十几个 GB 没意义
        fs.rmSync(dir, { recursive: true, force: true });
        console.log('   已清理本地中间产物');
    }
}
