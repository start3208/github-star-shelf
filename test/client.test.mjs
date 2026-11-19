// 页面（miniapp/client）的静态检查。前端没有测试框架，也没法在这里真的打开浏览器；
// 但写错一个括号、改了函数名忘了改调用的地方，整个页面就是白屏或者点了没反应，这些靠静态检查就能抓到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { REPO_ROOT } from './helpers/sandbox.mjs';

const run = promisify(execFile);
const CLIENT = join(REPO_ROOT, 'miniapp', 'client');
const files = (await readdir(CLIENT)).sort();
const scripts = files.filter((f) => f.endsWith('.js'));
const read = (f) => readFile(join(CLIENT, f), 'utf8');
const sources = Object.fromEntries(await Promise.all(scripts.map(async (f) => [f, await read(f)])));

const EXPORT_DECL = /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s*\{([^}]*)\}/gm;
const IMPORT = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const BARE_IMPORT = /^import\s+['"]([^'"]+)['"]/gm; // import './x.js'：只为运行它，不导入名字

function exportsOf(source) {
  const names = new Set();
  for (const m of source.matchAll(EXPORT_DECL)) names.add(m[1]);
  for (const m of source.matchAll(EXPORT_LIST)) for (const part of m[1].split(',')) names.add(part.trim().split(/\s+as\s+/).pop());
  names.delete('');
  return names;
}
const exportTable = Object.fromEntries(Object.entries(sources).map(([f, s]) => [f, exportsOf(s)]));

test('前端每个脚本的语法都对', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'client check '));
  try {
    for (const f of scripts) {
      const copy = join(dir, f.replace(/\.js$/, '.mjs')); // 浏览器按模块加载它们，所以按模块检查
      await copyFile(join(CLIENT, f), copy);
      await run(process.execPath, ['--check', copy]).catch((error) => {
        throw new Error(f + ' 语法错误：' + String(error.stderr).split('\n').slice(0, 6).join(' | '));
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('每个 import 的文件都在，导入的名字目标文件里都有导出；import * as X 之后用到的 X.名字 也都存在', () => {
  const problems = [];
  let imports = 0;
  for (const [file, source] of Object.entries(sources)) {
    for (const m of source.matchAll(IMPORT)) {
      imports += 1;
      const [, spec, from] = m;
      if (!from.startsWith('./')) {
        problems.push(file + ' 引用了页面以外的东西：' + from);
        continue;
      }
      const target = from.slice(2);
      if (!exportTable[target]) {
        problems.push(file + ' 引用了不存在的文件：' + from);
        continue;
      }
      const star = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(spec.trim());
      if (star) {
        const ns = star[1];
        for (const use of new Set([...source.matchAll(new RegExp('\\b' + ns + '\\.([A-Za-z_$][\\w$]*)', 'g'))].map((x) => x[1]))) {
          if (!exportTable[target].has(use)) problems.push(file + ' 用了 ' + ns + '.' + use + '，但 ' + target + ' 没有导出它');
        }
        continue;
      }
      const named = /\{([^}]*)\}/.exec(spec);
      for (const part of (named ? named[1] : '').split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name && !exportTable[target].has(name)) problems.push(file + ' 导入了 ' + name + '，但 ' + target + ' 没有导出它');
      }
    }
  }
  assert.ok(imports >= 15, '只找到 ' + imports + ' 条 import，检查本身可能坏了');
  assert.deepEqual(problems, []);
});

test('没有循环引用（循环引用会在页面里变成「还没初始化」的报错）', () => {
  const edges = (s) => [...[...s.matchAll(IMPORT)].map((m) => m[2]), ...[...s.matchAll(BARE_IMPORT)].map((m) => m[1])];
  const graph = Object.fromEntries(Object.entries(sources).map(([f, s]) => [f, edges(s).map((to) => to.replace('./', '')).filter((to) => exportTable[to])]));
  assert.ok(Object.values(graph).flat().length >= 15, '引用图是空的，检查本身可能坏了');
  const state = {};
  const stack = [];
  const cycles = [];
  const visit = (node) => {
    if (state[node] === 2) return;
    if (state[node] === 1) {
      cycles.push([...stack.slice(stack.indexOf(node)), node].join(' → '));
      return;
    }
    state[node] = 1;
    stack.push(node);
    for (const next of graph[node]) visit(next);
    stack.pop();
    state[node] = 2;
  };
  for (const f of Object.keys(graph)) visit(f);
  assert.deepEqual(cycles, []);
});

test('页面带着很严的安全策略（script-src self）：不能有内联脚本、内联事件、eval；引用的文件都在', async () => {
  const html = await read('index.html');
  assert.deepEqual([...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>/gi)].map((m) => m[0]), [], '内联脚本会被拦掉');
  assert.deepEqual([...html.matchAll(/\son[a-z]+\s*=/gi)].map((m) => m[0]), [], '内联事件会被拦掉');
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1].slice(1));
  assert.ok(refs.includes('app.js') && refs.includes('style.css'), '找不到页面入口：' + refs.join());
  for (const ref of refs) assert.ok(files.includes(ref), 'index.html 引用了不存在的文件：' + ref);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  for (const [file, source] of Object.entries(sources)) {
    assert.ok(!/\beval\s*\(|new\s+Function\s*\(/.test(source), file + ' 用了 eval / new Function，会被安全策略拦掉');
    assert.ok(!/\b(?:import|require)\s*\(\s*['"]https?:/.test(source), file + ' 不能动态加载外部脚本');
  }
});

test('设置面板：保存了路径、检测完了，面板要自己刷新；对话框关闭时要取消订阅（真实宿主里出过「保存后面板不变」）', async () => {
  const source = sources['view-dialogs.js'];
  const start = source.indexOf('export function openSettings()');
  const body = source.slice(start, source.indexOf('// ---------- AI 整理 ----------', start));
  assert.ok(start > 0 && body.length > 1000);
  assert.match(body, /on\('state',/, '要订阅后台状态的变化');
  assert.match(body, /onClose:\s*\(\)\s*=>\s*stopWatching\(\)/, '关闭对话框时要取消订阅，否则会一直泄漏');
  for (const id of ['statusDl', 'toolsDl', 'promptsBox']) assert.ok(new RegExp('fill\\(body,[\\s\\S]*\\b' + id + '\\b').test(body) && new RegExp('fill\\(' + id + ',').test(body), id + ' 要放进面板，并且能单独刷新');
  assert.ok(!/state'[^\n]*querySelector\([^)]*:focus/.test(body), '不能因为输入框有焦点就不刷新：在路径框里按回车后焦点还在框里');
});
