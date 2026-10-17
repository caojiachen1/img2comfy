// 把内容脚本的 ESM 模块图打包成一个经典脚本（Chrome 的 content_scripts 不支持 ES 模块，
// manifest 里没有 module 键；background.type:module 只作用于 service worker）。
// 用法：node scripts/build-content.mjs   →  产出 src/content/content.bundle.js
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = 'src/content/main.mjs';
const OUT = 'src/content/content.bundle.js';

function toId(absFile) {
    return path.relative(ROOT, absFile).replace(/\\/g, '/');
}

function readModule(id) {
    return fs.readFileSync(path.join(ROOT, id), 'utf8');
}

// 1) 依赖图
const seen = new Set();
const deps = new Map();
function walk(id) {
    if (seen.has(id)) return;
    seen.add(id);
    const src = readModule(id);
    const list = [];
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import[\s\S]{0,400}?)from\s+['"](\.[^'"]+)['"]/g)) {
        list.push(toId(path.resolve(path.join(ROOT, path.dirname(id)), m[1])));
    }
    for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g)) {
        list.push(toId(path.resolve(path.join(ROOT, path.dirname(id)), m[1])));
    }
    deps.set(id, [...new Set(list)]);
    for (const d of deps.get(id)) walk(d);
}
walk(ENTRY);

// 2) 拓扑排序（内容模块图无环；有环直接报错，避免静默产出坏包）
const order = [];
const state = new Map();
function visit(id, chain) {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'busy') throw new Error('检测到循环依赖：' + chain.concat(id).join(' → ') + '\n循环依赖需要改成显式注册，不能在打包里赌顺序');
    state.set(id, 'busy');
    for (const d of deps.get(id) || []) visit(d, chain.concat(id));
    state.set(id, 'done');
    order.push(id);
}
for (const id of deps.keys()) visit(id, []);

// 3) 逐模块改写
function transform(id) {
    const src = readModule(id);
    const exports = new Map();
    const lines = src.split('\n');
    const out = [];
    for (let raw of lines) {
        const line = raw;
        let m;
        // import { a, b as c } from './x.js'
        if ((m = /^(\s*)import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"];?\s*$/.exec(line))) {
            const bindings = m[2].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
                const parts = s.split(/\s+as\s+/);
                return parts.length > 1 ? `${parts[0].trim()}: ${parts[1].trim()}` : parts[0].trim();
            });
            out.push(`${m[1]}const { ${bindings.join(', ')} } = __M[${JSON.stringify(resolveId(id, m[3]))}];`);
            continue;
        }
        // import * as N from './x.js'
        if ((m = /^(\s*)import\s*\*\s*as\s*([A-Za-z0-9_$]+)\s*from\s*['"](\.[^'"]+)['"];?\s*$/.exec(line))) {
            out.push(`${m[1]}const ${m[2]} = __M[${JSON.stringify(resolveId(id, m[3]))}];`);
            continue;
        }
        // import D from './x.js'  （未使用，但遇到就明确失败而不是静默丢）
        if ((m = /^(\s*)import\s+([A-Za-z0-9_$]+)\s*from\s*['"](\.[^'"]+)['"];?\s*$/.exec(line))) {
            throw new Error(`${id}: 不支持默认导入（${m[2]}），改成具名导入`);
        }
        // 裸 import './x.js'（副作用）
        if ((m = /^(\s*)import\s+['"](\.[^'"]+)['"];?\s*$/.exec(line))) {
            out.push(`${m[1]}void __M[${JSON.stringify(resolveId(id, m[2]))}];`);
            continue;
        }
        // export { a, b as c }  （可跨行，这里按整行处理；多行由前一次合并）
        if ((m = /^\s*export\s*\{([^}]*)\};?\s*$/.exec(line))) {
            for (const s of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
                const parts = s.split(/\s+as\s+/);
                exports.set(parts[1] ? parts[1].trim() : parts[0].trim(), parts[0].trim());
            }
            continue;
        }
        // export function/class/const/let/var
        if ((m = /^(\s*)export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z0-9_$]+)/.exec(line))) {
            exports.set(m[3], m[3]);
            out.push(line.replace(/^(\s*)export\s+/, '$1'));
            continue;
        }
        if (/^\s*export\s+default\b/.test(line)) throw new Error(`${id}: 打包器不支持 export default`);
        out.push(raw);
    }
    const body = out.join('\n');
    const names = [...exports.entries()];
    const ret = names.length ? `return { ${names.map(([k, v]) => `${JSON.stringify(k)}: (typeof ${v} === 'undefined' ? undefined : ${v})`).join(', ')} };` : 'return {};';
    return { body, ret, exported: names.map(([k]) => k) };
}

function resolveId(fromId, spec) {
    return toId(path.resolve(path.join(ROOT, path.dirname(fromId)), spec));
}

const parts = [];
parts.push('(function(){\n"use strict";\nvar __M = {};');
const meta = [];
for (const id of order) {
    const t = transform(id);
    meta.push({ id, exported: t.exported });
    parts.push(`__M[${JSON.stringify(id)}] = (function(){\n${t.body}\n${t.ret}\n})();`);
}
// 入口：只取默认行为（main.mjs 顶层自执行）
parts.push(`void __M[${JSON.stringify(ENTRY)}];`);
parts.push('})();');

// 未解析的依赖必须是包内模块，不能是扩展外的东西
for (const { id } of meta) {
    for (const d of deps.get(id) || []) {
        if (!meta.some((x) => x.id === d)) throw new Error(`${id} 依赖了不在图里的模块 ${d}`);
    }
}

const bundle = parts.join('\n');
fs.writeFileSync(path.join(ROOT, OUT), bundle);
const kb = (Buffer.byteLength(bundle) / 1024).toFixed(1);
console.log(`打包 ${meta.length} 个模块 → ${OUT} (${kb} KB)`);
for (const m of meta) console.log(`  ${m.id}  导出 ${m.exported.length} 个`);
