(function () {
var GO_CSS = `
#go-agent-panel * { box-sizing: border-box; }
#go-agent-panel {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  font-family: "Segoe UI Variable Display", "Aptos", "Microsoft YaHei UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
#go-launcher {
  position: relative; width: 46px; height: 46px; margin-left: auto;
  border: 0; border-radius: 15px; cursor: pointer; padding: 0;
  background: linear-gradient(145deg, #1b2a4a 0%, #0d1526 55%, #101b33 100%);
  box-shadow: 0 8px 24px rgba(2, 8, 20, .55), inset 0 1px 0 rgba(255,255,255,.12), inset 0 -1px 0 rgba(0,0,0,.4);
  transition: transform .18s cubic-bezier(.2,.8,.2,1), box-shadow .18s ease;
}
#go-launcher:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 12px 30px rgba(2,8,20,.6), 0 0 0 1px rgba(120,200,255,.28), inset 0 1px 0 rgba(255,255,255,.14); }
#go-launcher:active { transform: scale(.96); }
#go-launcher svg { display: block; width: 100%; height: 100%; }
#go-launcher .pulse {
  position: absolute; inset: -4px; border-radius: 19px; pointer-events: none;
  opacity: 0; border: 1.5px solid rgba(90, 200, 255, .75);
}
#go-launcher.running { background: linear-gradient(145deg, #0e3b4d 0%, #0a2233 55%, #0c2c42 100%); }
#go-launcher.running .pulse { opacity: 1; animation: go-pulse 1.8s ease-out infinite; }
#go-launcher.error { background: linear-gradient(145deg, #4a1717 0%, #2a0d0d 55%, #3a1212 100%); box-shadow: 0 8px 24px rgba(0,0,0,.55), 0 0 0 1px rgba(255,93,93,.4); }
#go-launcher #go-dot { transition: fill .3s ease; fill: #8b98ad; }
#go-launcher.running #go-dot { fill: #43e2a4; }
#go-launcher.error #go-dot { fill: #ff5d5d; }
@keyframes go-pulse { 0% { transform: scale(.9); opacity: .9; } 100% { transform: scale(1.35); opacity: 0; } }

#go-card {
  position: absolute; right: 0; bottom: 54px; width: 300px;
  display: none; flex-direction: column;
  background: rgba(11, 17, 30, .86);
  backdrop-filter: blur(20px) saturate(150%);
  -webkit-backdrop-filter: blur(20px) saturate(150%);
  border: 1px solid rgba(255,255,255,.09);
  border-radius: 18px;
  box-shadow: 0 24px 60px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.06);
  color: #e8eef7; overflow: hidden;
  transform: translateY(14px) scale(.97); opacity: 0;
  transform-origin: bottom right;
  transition: transform .26s cubic-bezier(.2,.8,.2,1), opacity .22s ease;
  pointer-events: none;
}
#go-card.open { display: flex; transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }

#go-head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid rgba(255,255,255,.07);
}
#go-head .mark { width: 26px; height: 26px; flex: none; }
#go-head .title { font-size: 13px; font-weight: 700; letter-spacing: .02em; line-height: 1.2; }
#go-head .sub { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #7f8ca3; margin-top: 2px; }
#go-status-pill {
  margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-family: ui-monospace, "Cascadia Mono", "SF Mono", monospace;
  color: #9fb0c8; padding: 4px 9px; border-radius: 999px;
  background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08);
  white-space: nowrap;
}
#go-status-pill .led { width: 7px; height: 7px; border-radius: 50%; background: #5b6b84; transition: background .2s; }
#go-status-pill.running .led { background: #43e2a4; animation: go-led 1.4s ease-in-out infinite; }
#go-status-pill.warn .led { background: #ffb35c; }
#go-status-pill.error .led { background: #ff5d5d; animation: go-led-red 1s ease-in-out infinite; }
@keyframes go-led { 0%,100% { box-shadow: 0 0 0 0 rgba(67,226,164,.5); } 50% { box-shadow: 0 0 0 4px rgba(67,226,164,0); } }
@keyframes go-led-red { 0%,100% { box-shadow: 0 0 0 0 rgba(255,93,93,.5); } 50% { box-shadow: 0 0 0 4px rgba(255,93,93,0); } }

#go-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
.go-label {
  display: block; font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
  color: #7f8ca3; margin-bottom: 5px; font-weight: 600;
}
.go-field, .go-area, .go-select {
  width: 100%; color: #dbe6f5;
  background: rgba(255,255,255,.045);
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 10px; padding: 7px 9px;
  font-size: 12.5px; outline: none;
  transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
}
.go-field:focus, .go-area:focus, .go-select:focus {
  border-color: rgba(96, 200, 255, .55);
  box-shadow: 0 0 0 3px rgba(96, 200, 255, .14);
  background: rgba(255,255,255,.07);
}
.go-area { resize: vertical; min-height: 74px; line-height: 1.55; font-family: ui-monospace, "Cascadia Mono", "SF Mono", monospace; font-size: 11.5px; }
.go-select { appearance: none; cursor: pointer; background-image: linear-gradient(45deg, transparent 50%, #7f8ca3 50%), linear-gradient(135deg, #7f8ca3 50%, transparent 50%); background-position: calc(100% - 15px) 55%, calc(100% - 10px) 55%; background-size: 5px 5px; background-repeat: no-repeat; }

.go-switch {
  display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; color: #c7d2e3;
  user-select: none;
}
.go-switch input { display: none; }
.go-switch .track {
  width: 32px; height: 18px; border-radius: 999px; flex: none;
  background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.14);
  position: relative; transition: background .2s ease;
}
.go-switch .track::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
  border-radius: 50%; background: #cdd8ea;
  transition: transform .2s cubic-bezier(.2,.8,.2,1), background .2s;
}
.go-switch input:checked + .track { background: rgba(67, 226, 164, .3); border-color: rgba(67,226,164,.5); }
.go-switch input:checked + .track::after { transform: translateX(14px); background: #43e2a4; }

.go-btn {
  width: 100%; padding: 9px; border: 0; border-radius: 11px; cursor: pointer;
  font-size: 13px; font-weight: 700; letter-spacing: .04em;
  color: #04121f; background: linear-gradient(135deg, #4cc9f0, #38b6e8 60%, #2f9fd8);
  box-shadow: 0 6px 18px rgba(56, 182, 232, .32), inset 0 1px 0 rgba(255,255,255,.4);
  transition: transform .14s ease, box-shadow .18s ease, filter .18s ease;
}
.go-btn:hover { filter: brightness(1.06); box-shadow: 0 8px 22px rgba(56,182,232,.42), inset 0 1px 0 rgba(255,255,255,.45); }
.go-btn:active { transform: scale(.97); }
.go-btn.stop { background: linear-gradient(135deg, #ffb35c, #f59a3c 60%, #e8862a); box-shadow: 0 6px 18px rgba(245,154,60,.3), inset 0 1px 0 rgba(255,255,255,.4); color: #241203; }

.go-details { border-top: 1px dashed rgba(255,255,255,.1); padding-top: 10px; }
.go-details summary {
  cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px;
  font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: #8fa0b8; font-weight: 600;
}
.go-details summary::-webkit-details-marker { display: none; }
.go-details summary .chev { transition: transform .22s ease; }
.go-details[open] summary .chev { transform: rotate(90deg); }
.go-details .inner { display: flex; flex-direction: column; gap: 8px; margin-top: 9px; animation: go-reveal .22s ease; }
@keyframes go-reveal { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.go-hint { font-size: 10.5px; color: #6f7f99; line-height: 1.5; }
.go-save {
  width: 100%; padding: 6px; border: 1px solid rgba(255,255,255,.12); border-radius: 9px; cursor: pointer;
  background: rgba(255,255,255,.05); color: #b9c7dc; font-size: 12px; font-weight: 600;
  transition: background .16s, border-color .16s;
}
.go-save:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.22); }
.go-flash { animation: go-flash 1s ease; }
@keyframes go-flash { 0% { box-shadow: 0 0 0 3px rgba(76,201,240,.35); } 100% { box-shadow: 0 0 0 0 rgba(76,201,240,0); } }
`;

var GO_CSS_OVERRIDE = `
#go-agent-panel { user-select: none; }
#go-launcher {
  background: linear-gradient(145deg, #1c2130 0%, #0e111a 55%, #131724 100%);
  border: 1px solid rgba(216, 255, 69, .30);
  cursor: grab;
  box-shadow: 0 10px 26px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.10);
}
#go-launcher:active { cursor: grabbing; }
#go-launcher:hover { border-color: rgba(216,255,69,.65); box-shadow: 0 12px 30px rgba(0,0,0,.6), 0 0 18px rgba(216,255,69,.18); }
#go-launcher.running { background: linear-gradient(145deg, #1e2b16, #0f1a0d 55%, #16210f); border-color: rgba(216,255,69,.7); }
#go-launcher.error { background: linear-gradient(145deg, #2a1414, #170a0a 55%, #201010); border-color: rgba(255,115,115,.75); }
#go-launcher .pulse { border-color: rgba(216,255,69,.8); }
#go-launcher #go-dot { fill: #8b98ad; }
#go-launcher.running #go-dot { fill: #d8ff45; }
#go-launcher.error #go-dot { fill: #ff7373; }
#go-card {
  background: rgba(10, 14, 22, .92);
  border: 1px solid rgba(216, 255, 69, .20);
  border-radius: 16px;
  box-shadow: 0 26px 70px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.05);
}
#go-head { border-bottom: 1px solid rgba(255,255,255,.08); }
#go-head .sub { color: #8fa0b8; }
#go-status-pill { border-color: rgba(216,255,69,.25); color: #c7d2e3; }
#go-status-pill .led { background: #5b6b84; }
#go-status-pill.running .led { background: #d8ff45; animation: go-led 1.4s ease-in-out infinite; }
#go-status-pill.warn .led { background: #ffb35c; }
#go-status-pill.error .led { background: #ff7373; animation: go-led-red 1s ease-in-out infinite; }
.go-label { color: #8fa0b8; }
.go-field, .go-area, .go-select { border-color: rgba(255,255,255,.12); background: rgba(255,255,255,.045); color: #dbe6f5; }
.go-field:focus, .go-area:focus, .go-select:focus { border-color: rgba(216,255,69,.55); box-shadow: 0 0 0 3px rgba(216,255,69,.14); }
.go-switch .track { border-color: rgba(255,255,255,.16); background: rgba(255,255,255,.12); }
.go-switch input:checked + .track { background: rgba(216,255,69,.28); border-color: rgba(216,255,69,.6); }
.go-switch input:checked + .track::after { background: #d8ff45; }
.go-btn { background: linear-gradient(135deg, #e6ff7a, #d8ff45 55%, #c2e83a); color: #162000; box-shadow: 0 8px 22px rgba(216,255,69,.28), inset 0 1px 0 rgba(255,255,255,.45); }
.go-btn:hover { filter: brightness(1.05); box-shadow: 0 10px 26px rgba(216,255,69,.4); }
.go-btn.stop { background: linear-gradient(135deg, #ffb35c, #f59a3c 60%, #e8862a); color: #241203; box-shadow: 0 6px 18px rgba(245,154,60,.3); }
.go-details { border-top-color: rgba(255,255,255,.1); }
.go-details summary { color: #8fa0b8; }
.go-hint { color: #6f7f99; }
.go-save { border-color: rgba(216,255,69,.25); color: #b9c7dc; }
.go-save:hover { border-color: rgba(216,255,69,.45); background: rgba(216,255,69,.08); }
`;

var TEMPLATES: Record<string, string> = {
  engineering: [
    '请继续推进当前任务，不要停下来。',
    '接着完成剩余部分，保持当前质量水平。',
    '请继续按你的思路把下一步做完。',
    '任务尚未完成，请继续往下推进。',
    '请把当前方案补充完整，覆盖关键细节。',
    '请继续完善实现，包括边界情况和异常处理。',
    '请补全缺失的部分，并保持前后逻辑一致。',
    '请检查刚才的产出，找出错误或遗漏并修正。',
    '请对已完成部分做一次自检：逻辑是否严谨、结论是否有依据。',
    '请回顾任务目标，确认没有遗漏的需求。',
    '请把当前成果整理成清晰的交付格式，方便我验收。',
    '请总结当前进度，并说明下一步计划。',
    '请给出阶段性结论：已完成什么、还缺什么、下一步做什么。',
    '请主动审视任务中的风险、边界和潜在问题，并继续处理。',
    '如果信息不足或遇到阻碍，请说明并给出替代方案，然后继续。',
    '请站在验收者视角检查产出是否达标，不达标就继续修正。',
    '请继续直到任务可交付，最后给出完整的最终结果。',
  ].join('\n'),
  casual: ['继续', '接着推进', '别停，继续往下', '然后呢？', '好，继续', '继续完成剩余部分', '继续下一步', '不要停，接着做'].join('\n'),
};

var LAUNCHER_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true">
  <defs>
    <linearGradient id="goGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e6ff7a"/>
      <stop offset=".55" stop-color="#d8ff45"/>
      <stop offset="1" stop-color="#a9cf2e"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="44" height="44" rx="14" fill="none" stroke="url(#goGrad)" stroke-width="1.6" opacity=".9"/>
  <circle cx="24" cy="24" r="12.5" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.22)" stroke-width="1"/>
  <path d="M20.5 16.5v15l12-7.5z" fill="url(#goGrad)"/>
  <circle id="go-dot" cx="36.5" cy="12.5" r="2.4" fill="#ffd166"/>
  <path d="M38.6 24.5l2 2-2 2M41 24.5l-2 2 2 2" stroke="#7f8ca3" stroke-width="1.2" stroke-linecap="round" opacity=".6"/>
</svg>`;

var HEAD_SVG = `<svg class="mark" viewBox="0 0 26 26" aria-hidden="true">
  <defs>
    <linearGradient id="goHeadGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6fd8ff"/><stop offset="1" stop-color="#2f9fd8"/>
    </linearGradient>
  </defs>
  <rect x="1.5" y="1.5" width="23" height="23" rx="7" fill="rgba(255,255,255,.04)" stroke="url(#goHeadGrad)" stroke-width="1.2"/>
  <path d="M10.5 8.5v9l7-4.5z" fill="url(#goHeadGrad)"/>
</svg>`;
var pollTimer: ReturnType<typeof setInterval> | null = null;

function send(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(response);
      });
    } catch {
      resolve({ ok: false, error: 'background unreachable' });
    }
  });
}

function mountPanel(): void {
  const host = location.hostname;
  if (!host.includes('chatgpt.com') && !host.includes('chat.deepseek.com')) return;
  if (document.getElementById('go-agent-panel')) return;

  const platform = host.includes('chatgpt.com') ? 'ChatGPT' : 'DeepSeek';
  if (document.getElementById('go-agent-style')) return;
  const style = document.createElement('style');
  style.id = 'go-agent-style';
  style.textContent = GO_CSS + GO_CSS_OVERRIDE;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.id = 'go-agent-panel';
  wrap.innerHTML = `
    <button id="go-launcher" title="GO Agent">${LAUNCHER_SVG}<span class="pulse"></span></button>
    <div id="go-card">
      <div id="go-head">
        ${HEAD_SVG}
        <div>
          <div class="title">GO Agent</div>
          <div class="sub">${platform} · CDP 真事件</div>
        </div>
        <span id="go-status-pill"><span class="led"></span><span id="go-status-text">空闲</span></span>
      </div>
      <div id="go-body">
        <div id="go-decision-line" class="go-hint">决策引擎：未配置（模板池）</div>
        <div>
          <label class="go-label" for="go-template">推进语模板</label>
          <select id="go-template" class="go-select">
            <option value="engineering">内置 · 工程推进（推荐）</option>
            <option value="casual">内置 · 简洁口语</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        <div>
          <label class="go-label" for="go-pool">推进语池（每行一句，可编辑）</label>
          <textarea id="go-pool" class="go-area" spellcheck="false"></textarea>
        </div>
        <div>
          <label class="go-label" for="go-keyword">节点关键词（留空=默认完成词）</label>
          <input id="go-keyword" class="go-field" type="text" placeholder="如：验收点 或 方案完成">
        </div>
        <div>
          <label class="go-label" for="go-maxrounds">最大推进轮数</label>
          <input id="go-maxrounds" class="go-field" type="number" min="1" max="50" value="10">
        </div>
        <label class="go-switch"><input id="go-protocol" type="checkbox" checked><span class="track"></span>启动时注入工作协议</label>
        <details class="go-details">
          <summary><span class="chev">▶</span>LLM 决策引擎（可选）</summary>
          <div class="inner">
            <div>
              <label class="go-label" for="go-preset">厂商预设</label>
              <select id="go-preset" class="go-select">
                <option value="deepseek">DeepSeek</option>
                <option value="openai">OpenAI</option>
                <option value="moonshot">Moonshot</option>
                <option value="qwen">通义千问</option>
                <option value="zhipu">智谱</option>
                <option value="siliconflow">硅基流动</option>
                <option value="ollama">Ollama（本地）</option>
                <option value="custom">自定义</option>
              </select>
            </div>
            <input id="go-model" class="go-field" type="text" placeholder="Model（留空=预设默认）">
            <input id="go-baseurl" class="go-field" type="text" placeholder="Base URL（自定义时填）">
            <input id="go-apikey" class="go-field" type="password" placeholder="API Key">
            <button id="go-save-decision" class="go-save">保存决策配置</button>
            <div class="go-hint">决策模型可调用 go_status / go_stop / go_continue；失败自动回退模板池。</div>
          </div>
        </details>
        <button id="go-toggle" class="go-btn">开始推进</button>
      </div>
    </div>`;
  (document.body || document.documentElement).appendChild(wrap);
  wrap.style.left = Math.max(12, window.innerWidth - 64) + 'px';
  wrap.style.top = Math.max(12, window.innerHeight - 64) + 'px';
  wrap.style.right = 'auto';
  wrap.style.bottom = 'auto';

  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id.replace(/^#/, '')) as T;
  const card = $('#go-card') as HTMLElement;
  const launcher = $('#go-launcher') as HTMLButtonElement;
  const statusPill = $('#go-status-pill') as HTMLElement;
  const statusText = $('#go-status-text') as HTMLElement;
  const decisionLine = $('#go-decision-line') as HTMLElement;
  const templateSel = $('#go-template') as HTMLSelectElement;
  const poolArea = $('#go-pool') as HTMLTextAreaElement;
  const keywordInput = $('#go-keyword') as HTMLInputElement;
  const roundsInput = $('#go-maxrounds') as HTMLInputElement;
  const protocolCheck = $('#go-protocol') as HTMLInputElement;
  const toggleBtn = $('#go-toggle') as HTMLButtonElement;
  const saveDecisionBtn = $('#go-save-decision') as HTMLButtonElement;
  let running = false;

  templateSel.addEventListener('change', () => {
    const t = TEMPLATES[templateSel.value];
    if (t) {
      poolArea.value = t;
      poolArea.classList.remove('go-flash');
      void poolArea.offsetWidth;
      poolArea.classList.add('go-flash');
    }
  });

  const setStatus = (text: string, mode: 'idle' | 'running' | 'warn' | 'error' = 'idle'): void => {
    statusText.textContent = text;
    statusPill.classList.toggle('running', mode === 'running');
    statusPill.classList.toggle('warn', mode === 'warn');
    statusPill.classList.toggle('error', mode === 'error');
    launcher.classList.toggle('running', mode === 'running');
    launcher.classList.toggle('error', mode === 'error');
    toggleBtn.classList.toggle('stop', mode === 'running');
    toggleBtn.textContent = running ? '停止推进' : '开始推进';
  };

  const refreshStatus = async (): Promise<void> => {
    const result = (await send({ type: 'go:status' })) as
      | {
          ok?: boolean;
          running?: boolean;
          maxRounds?: number;
          decision?: { preset?: string; model?: string } | null;
          state?: {
            round?: number;
            phase?: string;
            nextActionAt?: number;
            lastStopReason?: string;
          };
        }
      | undefined;
    if (result && result.ok) {
      running = result.running === true;
      const round = result.state?.round ?? 0;
      const maxRounds = result.maxRounds ?? 10;
      if (result.decision) {
        decisionLine.textContent = '决策引擎：已配置 · ' + (result.decision.preset || 'custom') + (result.decision.model ? ' / ' + result.decision.model : '');
      } else {
        decisionLine.textContent = '决策引擎：未配置（模板池）';
      }
      if (running) {
        const s = result.state ?? {};
        const secs = s.nextActionAt ? Math.max(0, Math.ceil((s.nextActionAt - Date.now()) / 1000)) : 0;
        let text = '运行中 · R' + round + '/' + maxRounds;
        if (s.phase === 'generating') text = '模型生成中…';
        else if (s.phase === 'waiting') text = '等待模型回复';
        else if (s.phase === 'cooldown') text = secs + 's 后推进 · R' + round + '/' + maxRounds;
        setStatus(text, 'running');
      } else {
        const reason = result.state?.lastStopReason || '';
        if (reason.includes('风控') || reason.includes('失败')) setStatus('⚠ ' + reason, 'error');
        else if (reason.includes('节点')) setStatus('已到节点，请验收（R' + round + '）', 'idle');
        else if (reason.includes('停止')) setStatus('已停止', 'idle');
        else setStatus('空闲', 'idle');
      }
    }
  };

  let dragState: { x: number; y: number; left: number; top: number } | null = null;
  let dragMoved = false;
  launcher.addEventListener('pointerdown', (event) => {
    dragState = { x: event.clientX, y: event.clientY, left: wrap.offsetLeft, top: wrap.offsetTop };
    dragMoved = false;
    try { launcher.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  });
  launcher.addEventListener('pointermove', (event) => {
    if (!dragState) return;
    const dx = event.clientX - dragState.x;
    const dy = event.clientY - dragState.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) dragMoved = true;
    if (!dragMoved) return;
    const w = wrap.offsetWidth;
    const h = wrap.offsetHeight;
    wrap.style.left = Math.min(Math.max(0, dragState.left + dx), window.innerWidth - w) + 'px';
    wrap.style.top = Math.min(Math.max(0, dragState.top + dy), window.innerHeight - h) + 'px';
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
  });
  const endDrag = () => { dragState = null; };
  launcher.addEventListener('pointerup', endDrag);
  launcher.addEventListener('pointercancel', endDrag);
  launcher.addEventListener('click', () => {
    if (dragMoved) { dragMoved = false; return; }
    card.classList.toggle('open');
    void refreshStatus();
  });

  toggleBtn.addEventListener('click', async () => {
    if (running) {
      await send({ type: 'go:stop' });
      running = false;
      setStatus('已停止', 'warn');
      return;
    }
    const pool = poolArea.value.trim();
    const result = (await send({
      type: 'go:start',
      goal: '',
      keyword: keywordInput.value || '',
      maxRounds: parseInt(roundsInput.value || '10', 10) || 10,
      nudgePool: pool ? pool.split('\n').map((s) => s.trim()).filter(Boolean) : undefined,
      injectProtocol: protocolCheck.checked !== false,
      panelPrefs: {
        template: templateSel.value,
        keyword: keywordInput.value,
        maxRounds: roundsInput.value,
        nudgePool: poolArea.value,
        injectProtocol: protocolCheck.checked,
      },
    })) as { ok?: boolean; error?: string } | undefined;
    if (result && result.ok === false) {
      setStatus('启动失败', 'warn');
      return;
    }
    running = true;
    setStatus('运行中 · R0', 'running');
  });

  saveDecisionBtn.addEventListener('click', async () => {
    const presetSel = $('#go-preset') as HTMLSelectElement;
    const result = (await send({
      type: 'go:saveDecision',
      preset: presetSel.value || 'custom',
      baseUrl: ($('#go-baseurl') as HTMLInputElement).value || undefined,
      model: ($('#go-model') as HTMLInputElement).value || undefined,
      apiKey: ($('#go-apikey') as HTMLInputElement).value || undefined,
    })) as { ok?: boolean; error?: string } | undefined;
    setStatus(result && result.ok ? '决策配置已保存' : '保存失败', result && result.ok ? 'idle' : 'warn');
  });

  const applyPrefs = (prefs: {
    template?: string;
    keyword?: string;
    maxRounds?: string | number;
    nudgePool?: string;
    injectProtocol?: boolean;
  }): void => {
    if (prefs.template && TEMPLATES[prefs.template]) {
      templateSel.value = prefs.template;
      poolArea.value = TEMPLATES[prefs.template];
    } else {
      templateSel.value = 'engineering';
      poolArea.value = TEMPLATES.engineering;
    }
    if (prefs.nudgePool) poolArea.value = prefs.nudgePool;
    if (prefs.keyword !== undefined) keywordInput.value = prefs.keyword;
    if (prefs.maxRounds !== undefined) roundsInput.value = String(prefs.maxRounds);
    if (prefs.injectProtocol !== undefined) protocolCheck.checked = prefs.injectProtocol;
  };

  void send({ type: 'go:loadPrefs' }).then((prefs) => {
    if (prefs && typeof prefs === 'object') applyPrefs(prefs as Parameters<typeof applyPrefs>[0]);
  });
  pollTimer = setInterval(() => void refreshStatus(), 1000);
}

function unmountPanel(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  document.getElementById('go-agent-panel')?.remove();
  document.getElementById('go-agent-style')?.remove();
}

function init(): void {
  const host = location.hostname;
  if (!host.includes('chatgpt.com') && !host.includes('chat.deepseek.com')) return;
  chrome.storage.local.get('goFeatureEnabled', (stored) => {
    if (stored.goFeatureEnabled !== false) mountPanel();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.goFeatureEnabled) return;
    if (changes.goFeatureEnabled.newValue === false) {
      unmountPanel();
    } else if (!document.getElementById('go-agent-panel')) {
      mountPanel();
    }
  });
}

console.info('[go-agent] panel v0.3.7 ready');
init();
})();
