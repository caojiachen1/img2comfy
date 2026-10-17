// 静态检查：相对导入文件存在 + 语法可解析 + 具名导入在目标模块里真的有导出。
// 用法：node scripts/check-imports.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'vendor', '.vendor-tmp', 'out']);
const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
    }
})(ROOT);

const cache = new Map();
function exportsOf(file) {
    if (cache.has(file)) return cache.get(file);
    const set = new Set();
    if (!fs.existsSync(file)) { cache.set(file, set); return set; }
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm)) set.add(m[1]);
    for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop().trim();
            if (name && name !== 'default') set.add(name);
        }
    }
    if (/^export\s+default\b/m.test(src)) set.add('default');
    // export * from './x.js' 需要把 x 的导出并进来
    for (const m of src.matchAll(/^export\s+\*\s+from\s+['"](\.[^'"]+)['"]/gm)) {
        const target = path.resolve(path.dirname(file), m[1]);
        for (const n of exportsOf(target)) set.add(n);
    }
    cache.set(file, set);
    return set;
}

let bad = 0;
for (const f of files) {
    const rawSrc = fs.readFileSync(f, 'utf8');
    // 只去掉整行注释：行尾注释会连正则里的 //（如 /^https?:/i）一起切掉，制造假错
    const src = rawSrc.split(String.fromCharCode(10)).filter((l) => !/^\s*\/\//.test(l)).join(String.fromCharCode(10));
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const isModule = /\.mjs$/.test(f) || /^\s*import[\s\S]*\bfrom\s+['"]/m.test(src) || /\bexport\s/.test(src);
    try {
        if (isModule) new vm.SourceTextModule(src, { identifier: rel });
        else new vm.Script(src, { filename: rel });
    } catch (e) {
        if (/SourceTextModule is not a constructor/.test(String(e))) continue;
        console.log(`SYNTAX   ${rel}: ${e.message}`);
        bad++;
        continue;
    }
    for (const m of src.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(f), m[2]);
        if (!fs.existsSync(target)) { console.log(`MISSING  ${rel} -> ${m[2]}`); bad++; continue; }
        const have = exportsOf(target);
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0].trim();
            if (!name) continue;
            if (!have.has(name)) { console.log(`NO EXPORT  ${rel}: 「${name}」不在 ${m[2]} 的导出里`); bad++; }
        }
    }
    for (const m of src.matchAll(/import\s+(['"]\.[^'"]+['"])/g)) {
        const target = path.resolve(path.dirname(f), m[1].slice(1, -1));
        if (!fs.existsSync(target)) { console.log(`MISSING  ${rel} -> ${m[1]}`); bad++; }
    }
    for (const m of src.matchAll(/import\(\s*['"](\.[^'"$]*)['"]/g)) {
        const target = path.resolve(path.dirname(f), m[1]);
        if (!fs.existsSync(target)) { console.log(`MISSING(dynamic)  ${rel} -> ${m[1]}`); bad++; }
    }
}
console.log(bad ? `\n${bad} 处问题` : `\n通过：${files.length} 个文件的语法、路径与具名导出都对得上`);
process.exit(bad ? 1 : 0);
