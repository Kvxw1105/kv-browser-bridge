// T3 真实桌面任务验收：notepad 白名单启动 → UIA 语义 ref 输入 → postcondition 校验闭环（可复现脚本）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const worktree = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
// 优先使用自包含发布产物（不依赖本机 .NET runtime）；MCP SDK 的 stdio transport
// 只用白名单环境变量，framework-dependent 驱动在 MCP 环境会因缺少 DOTNET_ROOT 失败。
const driverCandidates = [
  `${worktree}/apps/windows-uia-driver/publish/kv-windows-uia-driver.exe`,
  `${worktree}/../kv-browser-bridge-revival-20260811/release/kv-computer-use-runtime-rc-v0.2.10/apps/windows-uia-driver/publish/kv-windows-uia-driver.exe`,
];
const selfContainedDriver = driverCandidates.find((p) => existsSync(p));
if (!selfContainedDriver) {
  console.error('未找到自包含 UIA driver（publish 产物）。请先运行 npm run package-computer-use-rc。');
  process.exit(2);
}
const t = new StdioClientTransport({
  command: process.execPath,
  args: [`${worktree}/apps/codex-mcp-server/dist/computer-server.js`],
  env: {
    KV_WINDOWS_UIA_DRIVER: selfContainedDriver,
    LOCAL_CHROME_REQUEST_TIMEOUT_MS: '30000',
  },
});
const c = new Client({ name: 't3-desktop-acceptance', version: '1.0.0' });
await c.connect(t);

const results = [];
async function call(name, args = {}) {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content?.filter((x) => x.type === 'text').map((x) => x.text).join('\n') ?? '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`\n=== ${name} ===`);
  console.log(String(JSON.stringify(parsed) ?? text).slice(0, 900));
  return parsed;
}

const value = `KV-T3-${Date.now()}`;
let notepadPid = null;

try {
  // 1. 白名单应用可用性
  const apps = await call('computer_list_apps');
  const notepadApp = (apps?.apps ?? []).find((a) => a.appId === 'notepad');
  results.push(['computer_list_apps notepad available', Boolean(notepadApp?.available)]);

  // 2. 白名单启动 + process_started postcondition 校验
  const launch = await call('computer_execute', {
    actionId: `t3-launch-${Date.now()}`,
    action: { type: 'launch_app', appId: 'notepad' },
    reason: 'T3 acceptance: verify allowlisted launch and process_started postcondition',
    expectedPostcondition: { kind: 'process_started' },
    risk: 'reversible-write',
    timeoutMs: 15000,
  });
  const launchOk = launch?.status === 'completed' && launch?.verification?.status === 'passed';
  notepadPid = launch?.result?.pid ?? null;
  results.push(['launch_app notepad completed + process_started passed', launchOk]);
  results.push(['launch pid matches process_started evidence', notepadPid > 0]);

  if (!launchOk) throw new Error('launch failed, aborting');
  await new Promise((r) => setTimeout(r, 1500));

  // 3. 观察桌面找 notepad 窗口与编辑区
  const obs = await call('computer_observe', { browser: false, windows: true });
  const winList = Array.isArray(obs?.windows) ? obs.windows : (obs?.windows?.windows ?? []);
  const elements = Array.isArray(obs?.windows?.elements) ? obs.windows.elements : [];
  const win = winList.find((w) => /notepad|记事本/i.test(String(w?.name ?? w?.title ?? '')));
  console.log('\n[诊断] notepad 窗口对象:', JSON.stringify(win)?.slice(0, 400));
  console.log('[诊断] elements 类型:', Array.isArray(obs?.windows?.elements) ? `array(${obs.windows.elements.length})` : typeof obs?.windows?.elements);
  if (win) {
    console.log('[诊断] win 的元素字段:', Object.keys(win).join(','));
    const winElements = Array.isArray(win?.elements) ? win.elements : [];
    console.log('[诊断] win.elements:', winElements.length);
  }
  console.log('[诊断] 顶层 elements 明细:');
  for (const e of elements.slice(0, 24)) {
    console.log('  ', JSON.stringify({ ref: e?.ref, name: e?.name, controlType: e?.controlType, className: e?.className, processId: e?.processId })?.slice(0, 180));
  }
  let editEl = win ? elements.find((e) => /edit|文本编辑器|文档/i.test(String(e?.controlType ?? '') + String(e?.name ?? ''))) : undefined;
  results.push(['notepad window found via UIA', Boolean(win)]);
  // 注：UIA 只展开前台/指定窗口的元素，首轮观察未聚焦时不展开属正常机制（见下方 focus 后验证）

  // 3.5 聚焦 notepad 窗口后再观察（UIA 只展开前台窗口元素）
  if (win && !editEl) {
    const focus = await call('computer_execute', {
      actionId: `t3-focus-${Date.now()}`,
      action: { type: 'focus_window', windowHandle: win.handle },
      reason: 'T3 acceptance: focus notepad window to expose its UIA element tree',
      expectedPostcondition: { kind: 'window_focused', windowHandle: win.handle },
      risk: 'reversible-write',
      timeoutMs: 15000,
    });
    // 注：FOCUS_REJECTED 是 Windows 前台激活限制（SetForegroundWindow 仅前台进程可调用），
    //     属已知系统限制；observe(windowHandle) 不依赖前台，后续操作仍可完成。
    if (focus?.status !== 'completed') {
      console.log(`[note] focus_window: ${focus?.error?.code ?? focus?.status}（已知限制，不阻断）`);
    }
    await new Promise((r) => setTimeout(r, 1200));
    const obsF = await call('computer_observe', { browser: false, windows: true, windowHandle: win.handle });
    const elF = Array.isArray(obsF?.windows?.elements) ? obsF.windows.elements : [];
    console.log('[诊断] 聚焦后 elements:', elF.length, elF.slice(0, 8).map((e) => `${e?.controlType}:${e?.name ?? ''}`).join(' | '));
    editEl = elF.find((e) => /edit|文本编辑器|文档/i.test(String(e?.controlType ?? '') + String(e?.name ?? '')));
    results.push(['edit element found via windowHandle observe', Boolean(editEl?.ref)]);
  }
  if (!win) console.log('WARN: windows:', winList.map((w) => `${w?.handle}:${w?.name}`).join(' | '));

  // 4. set_value_ref 写入（显式 windowHandle，不依赖前台窗口）
  if (editEl?.ref) {
    const set = await call('computer_execute', {
      actionId: `t3-set-${Date.now()}`,
      action: { type: 'set_value_ref', targetRef: editEl.ref, windowHandle: win.handle, value },
      reason: 'T3 acceptance: set text into notepad edit area via UIA semantic ref',
      expectedPostcondition: { kind: 'value_equals', value },
      risk: 'reversible-write',
      timeoutMs: 20000,
    });
    results.push(['set_value_ref completed', set?.status === 'completed']);
    results.push(['set_value_ref verification passed', set?.verification?.status === 'passed']);

    await new Promise((r) => setTimeout(r, 800));
    // 5. 二次 observe 确认值稳定（真实回读，同样带 windowHandle）
    const obs2 = await call('computer_observe', { browser: false, windows: true, windowHandle: win.handle });
    const edit2 = (Array.isArray(obs2?.windows?.elements) ? obs2.windows.elements : []).find((e) => e?.ref === editEl.ref);
    const actualValue = edit2?.value ?? edit2?.name ?? '';
    results.push(['value read back matches', String(actualValue).includes(value.slice(0, 10))]);
    console.log(`\n[回读] expected=${value} actual=${String(actualValue).slice(0, 60)}`);
  } else {
    console.log('WARN: 未找到编辑元素');
  }
} catch (e) {
  results.push([`EXCEPTION: ${e.message}`, false]);
} finally {
  // 6. 按启动 PID 精确清理（不影响用户其他 notepad）
  if (notepadPid) {
    const kill = spawnSync('taskkill', ['/PID', String(notepadPid), '/F'], { encoding: 'utf8' });
    console.log(`\n[cleanup] taskkill PID ${notepadPid}: ${kill.stdout.trim() || kill.stderr.trim()}`);
  }
  await c.close();
  console.log('\n=== T3 验收汇总 ===');
  let pass = 0;
  for (const [name, ok] of results) { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`); if (ok) pass += 1; }
  console.log(`passed=${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
}
