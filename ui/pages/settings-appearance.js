// 由 ui/pages/settings.js 拆出（2026-10-08）：外观面板（明暗 / 色板 / 强调色 / 背景 / 排版 /
// 主题微调 / 顶栏 / 交互与无障碍）。拆出来的原因很实际：整块加进 settings.js 之后它越过
// 了 max-lines（1800）上限，而"外观"本身是一件事、控件又多，单独一个文件读起来更清楚。
// 跨文件引用一律走 import；本文件的对外出口只有 renderAppearanceBlock / bindAppearanceControls。
'use strict';

import { currentAppearance, setAppearance } from '../app.js';
import {
  ACCENTS, ACCENT_SCOPES, BACKGROUNDS, DARK_INTENSITIES, DENSITIES, FONTS, GLASS, MODES, RADII, SCHEMES,
  SIDEBAR_STYLES, TWEAK_VARS, radiusTier, resolveAppearance
} from '../core/appearance.js';
import { esc } from '../core/dom.js';
import { $ } from '../core/dom.js';
import { applyIcons } from '../core/icons.js';
import { refreshSeg } from '../core/segment.js';

/**
 * 外观块（2026-10-08 v3）：明暗 / 深色强度 / 色板 / 强调色（含应用范围与侧栏样式）/ 背景 /
 * 排版与界面 / 主题微调 / 顶栏 / 交互与无障碍。
 *
 * 全部"点了就生效"（不用先点保存），保存设置时再持久化到 config.ui（跨设备同步）。
 * 布局与名词对齐参照控制台的外观页：一张卡一件事，控件靠右、说明在左，
 * 换了离散的颜色/明暗就用 View Transitions 从点击处扩散（连续型滑条不开，见 setAppearance）。
 */
function renderAppearanceBlock(c) {
  // 基准取"界面上正在生效的外观"，而不是已保存的 c.ui：外观是"点了就生效、点保存才落盘"的，
  // 若按 c.ui 画，用户改完再切到别的设置分区又切回来，刚做的（明明已经生效的）选择会被面板"忘掉"——
  // 面板亮着「深色」而页面其实是浅色（2026-10-08 审查，真机复现）。启动时 currentAppearance()
  // 就是由服务端 c.ui 算出来的，所以首屏两者一致，不会出现"服务端配置被本地旧值盖住"。
  const cur = { ...resolveAppearance(c.ui || {}), ...currentAppearance() };
  const seg = (id, options, current, label) => `<div class="seg" id="${id}" role="radiogroup" aria-label="${esc(label)}">${
    options.map((o) => `<button type="button" class="seg-item${o.id === current ? ' selected' : ''}" data-v="${esc(o.id)}" aria-checked="${o.id === current}" role="radio">${esc(o.label)}</button>`).join('')
  }</div>`;

  const schemeCards = SCHEMES.map((s) => {
    const on = cur.scheme === s.id;
    return `<button type="button" class="scheme-card${on ? ' on' : ''}" data-scheme="${esc(s.id)}" title="${esc(s.label)} · ${esc(s.hint)}" aria-pressed="${on}">
        <span class="sc-prev" data-prev="${esc(s.id)}"></span>
        <span class="sc-label">${esc(s.label)}</span>
      </button>`;
  }).join('');

  const accentSwatches = ACCENTS.map((a) => {
    const on = !cur.customAccent && cur.accentPreset === a.id;
    return `<button type="button" class="swatch${on ? ' on' : ''}" data-preset="${esc(a.id)}" title="${esc(a.label)} ${esc(a.hex)}"
        style="background:${esc(a.hex)}" aria-pressed="${on}" aria-label="${esc(a.label)}">${on ? '<span class="ico" data-icon="check" data-icon-size="16"></span>' : ''}</button>`;
  }).join('');

  const tweaks = TWEAK_VARS.map((v) => {
    const saved = cur.tweaks[v.key] || '';
    // 这里原来还有一个恒为「默认」两字的装饰性胶囊（不响点击），和右边的色值文字叠在一起
    // 就成了"默认 … 默认"，看不出谁在说什么；真正"恢复配色默认值"的是右边那个 重置 按钮。
    // 去掉之后一行只剩：名称 + 色块（当前生效色）+ 色值（没改过就写"默认"）+ 重置（2026-10-08 审查）。
    return `<div class="tweak-row">
        <div class="tweak-name">${esc(v.label)} <span class="tweak-var">${esc(v.key)}</span></div>
        <label class="tweak-swatch" title="选择 ${esc(v.label)}" style="background:var(${esc(v.key)})">
          <input type="color" data-tweak="${esc(v.key)}"${saved ? ' data-dirty="1"' : ''} value="${esc(saved || '#888888')}" aria-label="${esc(v.label)}颜色" />
        </label>
        <span class="tweak-hex" data-tweak-hex="${esc(v.key)}">${saved ? esc(saved) : '默认'}</span>
        <button type="button" class="tweak-reset" data-tweak-reset="${esc(v.key)}" ${saved ? '' : 'disabled'} title="恢复配色默认值">重置</button>
      </div>`;
  }).join('');

  return `
    <h3 id="settings-appearance">外观</h3>
    <p class="hint" style="margin:-4px 0 12px">所有改动立即生效；点页面底部「保存设置」后写入服务器，换设备也带着走。</p>

    <div class="opt-card">
      <div class="opt-head"><span class="ico" data-icon="palette"></span><h4>主题</h4></div>
      <p class="opt-desc">明暗模式、深色强度与表面色板。色板只换"底 / 卡片 / 边框 / 文字"，强调色在下一张卡里单独调。</p>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">显示模式</div>
          <div class="opt-row-sub">「跟随系统」会随操作系统的亮暗自动切换。</div>
        </div>
        <div class="opt-row-ctrl">${seg('appearance-mode', MODES, cur.mode, '显示模式')}</div>
      </div>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">深色强度</div>
          <div class="opt-row-sub">「纯黑」把深色背景压到接近纯黑，适合 OLED 屏；只在深色模式下看得出差别。</div>
        </div>
        <div class="opt-row-ctrl">${seg('appearance-darkintensity', DARK_INTENSITIES, cur.darkIntensity, '深色强度')}</div>
      </div>
      <div class="opt-row" style="display:block">
        <div class="opt-row-title">配色方案</div>
        <div class="opt-row-sub">每格是它在当前明暗下的样子：外框是页面底色，中间那块是卡片色，圆点是强调色。</div>
        <div class="scheme-row" id="appearance-schemes" style="margin-top:10px">${schemeCards}</div>
      </div>
    </div>

    <div class="opt-card">
      <div class="opt-head"><span class="ico" data-icon="sparkles"></span><h4>强调色</h4></div>
      <p class="opt-desc">按钮、链接、选中态与图表使用的主色。</p>
      <div class="opt-row" style="display:block">
        <div class="opt-row-title">预设色</div>
        <div class="swatch-row" id="appearance-presets" data-current="${esc(cur.accentPreset)}" style="margin-top:10px">
          ${accentSwatches}
          <label class="swatch swatch-custom${cur.customAccent ? ' on' : ''}" title="自定义颜色" style="background:${esc(cur.customAccent ? cur.accent : 'conic-gradient(from .25turn, #f472b6, #f7b955, #2fd07a, #38bdf8, #a78bfa, #f472b6)')}">
            <input type="color" id="cfg-accent-custom" value="${esc(cur.accent)}" aria-label="自定义强调色" />
          </label>
        </div>
        <div class="hint" style="margin:8px 0 0">选预设会清掉自定义色；点最右边那个彩环自己挑一个。</div>
      </div>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">自定义强调色</div>
          <div class="opt-row-sub">填十六进制色值；留空 = 用上面选中的预设。</div>
        </div>
        <div class="opt-row-ctrl">
          <!-- 值必须取「当前生效」的 cur（不是已保存的 c.ui.accent）：面板里其余控件都这么取，
               否则"改了没保存 → 切走再切回"，这个框会被已保存值清空，而 readUI 又从这个框读 ——
               下一次动任何外观轴就把用户的自定义色悄悄丢回预设（2026-10-08 审查）。
               注意：这是 HTML 注释，会被原样插进 DOM，所以不能用 markdown 星号强调（有源码守卫盯着）。 -->
          <input type="text" id="cfg-accent" placeholder="#4c8dff" value="${esc(cur.customAccent ? cur.accent : '')}" style="width:104px" spellcheck="false" />
        </div>
      </div>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">应用范围</div>
          <div class="opt-row-sub">「仅侧栏」时按钮等全局元素保持默认蓝，强调色只染侧栏。</div>
        </div>
        <div class="opt-row-ctrl">${seg('appearance-scope', ACCENT_SCOPES, cur.accentScope, '应用范围')}</div>
      </div>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">侧栏样式</div>
          <div class="opt-row-sub">侧栏底色：跟页面一样、比页面深一档、或者掺一点强调色。</div>
        </div>
        <div class="opt-row-ctrl">${seg('appearance-sidebarstyle', SIDEBAR_STYLES, cur.sidebarStyle, '侧栏样式')}</div>
      </div>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">固定侧栏</div>
          <div class="opt-row-sub">默认（不勾）＝侧栏平时收成图标条，鼠标移上去自动展开、移开再收起（对齐参照控制台）；勾上＝常驻展开。</div>
        </div>
        <div class="opt-row-ctrl"><input type="checkbox" id="cfg-sidebar-pinned" ${cur.sidebarPinned ? 'checked' : ''} /></div>
      </div>
    </div>

    <div class="opt-card">
      <div class="opt-head"><span class="ico" data-icon="droplet"></span><h4>背景</h4></div>
      <p class="opt-desc">整页底色：默认那层淡淡的径向光晕，或者你自己的纯色 / 渐变。</p>
      <div class="opt-row">
        <div class="opt-row-main"><div class="opt-row-title">背景类型</div></div>
        <div class="opt-row-ctrl">${seg('appearance-bg', BACKGROUNDS, cur.background, '背景类型')}</div>
      </div>
      <div class="opt-row" id="appearance-bg-detail" style="display:${cur.background === 'none' ? 'none' : 'flex'}">
        <div class="opt-row-main" id="appearance-bg-solid" style="display:${cur.background === 'solid' ? 'block' : 'none'}">
          <div class="opt-row-title">背景色</div>
          <div class="opt-row-sub">整页铺这个颜色。</div>
        </div>
        <div class="opt-row-main" id="appearance-bg-gradient" style="display:${cur.background === 'gradient' ? 'flex' : 'none'};align-items:center;gap:10px;flex-wrap:wrap">
          <label class="tweak-swatch" title="起始色" style="background:${esc(cur.bgFrom)}"><input type="color" id="cfg-bgfrom" value="${esc(cur.bgFrom)}" aria-label="渐变起始色" /></label>
          <label class="tweak-swatch" title="结束色" style="background:${esc(cur.bgTo)}"><input type="color" id="cfg-bgto" value="${esc(cur.bgTo)}" aria-label="渐变结束色" /></label>
          <span class="range-row"><input type="range" id="cfg-bgangle" min="0" max="360" step="5" value="${cur.bgAngle}" />
            <span class="range-value" id="appearance-bgangle-now">${cur.bgAngle}°</span></span>
        </div>
        <div class="opt-row-ctrl" id="appearance-bg-colorwrap" style="display:${cur.background === 'solid' ? 'flex' : 'none'}">
          <label class="tweak-swatch" title="背景色" style="background:${esc(cur.bgColor)}"><input type="color" id="cfg-bgcolor" value="${esc(cur.bgColor)}" aria-label="背景色" /></label>
        </div>
      </div>
    </div>

    <div class="opt-card">
      <div class="opt-head"><span class="ico" data-icon="layers"></span><h4>材质</h4></div>
      <p class="opt-desc">表面是实心还是「玻璃」的。玻璃会把下层背景模糊后透上来，配合「背景 → 渐变」效果最明显；
        它只改表面怎么呈现，不动色板颜色，所以文字对比度不受影响。</p>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">表面材质</div>
          <div class="opt-row-sub">模糊越重越吃显卡（滑动与滚动时最明显）。「液态玻璃」色彩最浓、厚度感最强；「亚克力」最中性、带一层细颗粒，适合长时间盯着看；「描边」几乎不填色，只靠一条亮边划出边界。</div>
        </div>
        <div class="opt-row-ctrl">${seg('appearance-glass', GLASS, cur.glass, '表面材质')}</div>
      </div>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">边缘折射（实验）</div>
          <div class="opt-row-sub">让背景在卡片边缘被「弯折」（苹果那套 Liquid Glass 的签名动作）。
            它按每个表面的实际尺寸现算一张位移图，所以边缘是准的、中间完全不位移；
            代价是每张卡片多一层滤镜。只有选了玻璃材质才有意义；
            不支持该特性的浏览器（如部分 Firefox / Safari）会自动忽略，玻璃照旧。</div>
        </div>
        <div class="opt-row-ctrl"><input type="checkbox" id="cfg-refract" ${cur.refract ? 'checked' : ''} ${cur.glass === 'off' ? 'disabled' : ''} /></div>
      </div>
      <div class="hint" style="margin:-2px 0 0">浏览器不支持背景模糊时自动退回实心表面（宁可不玻璃，也不让文字糊掉）。</div>
    </div>

    <div class="opt-card">
      <div class="opt-head"><span class="ico" data-icon="type"></span><h4>排版与界面</h4></div>
      <p class="opt-desc">字体、圆角、缩放与密度。</p>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">界面字体</div>
          <div class="opt-row-sub">不引外部字体（内网/离线也一样），只用各系统自带的那几族。</div>
        </div>
        <div class="opt-row-ctrl">${seg('appearance-font', FONTS, cur.font, '界面字体')}</div>
      </div>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">圆角</div>
          <div class="opt-row-sub">卡片、输入框、按钮一起跟着变。</div>
        </div>
        <div class="opt-row-ctrl">${seg('appearance-radius', RADII, radiusTier(cur.radius), '圆角')}</div>
      </div>
      <input type="hidden" id="cfg-radius" value="${cur.radius}" />
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">界面缩放</div>
          <div class="opt-row-sub">整体放大或缩小，适合高分屏或视力需要。</div>
        </div>
        <div class="opt-row-ctrl">
          <span class="range-row"><input type="range" id="cfg-zoom" min="0.8" max="1.3" step="0.05" value="${cur.zoom}" />
            <span class="range-value" id="appearance-zoom-now">${Math.round(cur.zoom * 100)}%</span></span>
        </div>
      </div>
      <div class="opt-row">
        <div class="opt-row-main"><div class="opt-row-title">显示密度</div></div>
        <div class="opt-row-ctrl">${seg('appearance-density', DENSITIES, cur.density, '显示密度')}</div>
      </div>
      <input type="hidden" id="cfg-density" value="${esc(cur.density)}" />
    </div>

    <div class="opt-card">
      <div class="opt-head"><span class="ico" data-icon="undo"></span><h4>主题微调</h4></div>
      <p class="opt-desc">逐个覆盖颜色变量，叠在当前色板之上；没动过的保持色板默认值。「重置」把它还给色板。改动对明暗两套同时生效。</p>
      <div class="tweak-list" id="appearance-tweaks">${tweaks}</div>
    </div>

    <div class="opt-card">
      <div class="opt-head"><span class="ico" data-icon="layout"></span><h4>顶栏</h4></div>
      <p class="opt-desc">控制顶栏右侧显示什么；页面标题、搜索与暂停按钮始终保留。</p>
      <div class="opt-row">
        <div class="opt-row-main"><div class="opt-row-title">连接与用量徽章</div><div class="opt-row-sub">顶栏那几枚状态胶囊。</div></div>
        <div class="opt-row-ctrl"><input type="checkbox" id="cfg-showbadges" ${cur.showBadges ? 'checked' : ''} /></div>
      </div>
      <div class="opt-row">
        <div class="opt-row-main"><div class="opt-row-title">主题切换按钮</div><div class="opt-row-sub">关掉后仍可用设置页里的「显示模式」切换。</div></div>
        <div class="opt-row-ctrl"><input type="checkbox" id="cfg-showtopbartheme" ${cur.showTopbarTheme ? 'checked' : ''} /></div>
      </div>
    </div>

    <div class="opt-card">
      <div class="opt-head"><span class="ico" data-icon="accessibility"></span><h4>交互与无障碍</h4></div>
      <p class="opt-desc">动效强度与对比度。系统若开了"减少动态效果"，我们也会自动跟着降级。</p>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">减弱动效</div>
          <div class="opt-row-sub">弱化页面切换与弹簧动画，保留极轻微的过渡；对低端设备与晕动敏感者更友好。</div>
        </div>
        <div class="opt-row-ctrl"><input type="checkbox" id="cfg-reducemotion" ${cur.reduceMotion ? 'checked' : ''} /></div>
      </div>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">关闭全部动效</div>
          <div class="opt-row-sub">比「减弱动效」更彻底：连入场淡入与状态点呼吸都去掉（转圈提示除外）。</div>
        </div>
        <div class="opt-row-ctrl"><input type="checkbox" id="cfg-nomotion" ${cur.noMotion ? 'checked' : ''} /></div>
      </div>
      <div class="opt-row">
        <div class="opt-row-main">
          <div class="opt-row-title">高对比模式</div>
          <div class="opt-row-sub">加粗边框、提亮次要文字。</div>
        </div>
        <div class="opt-row-ctrl"><input type="checkbox" id="cfg-contrast" ${cur.contrast === 'high' ? 'checked' : ''} /></div>
      </div>
    </div>`;
}

/**
 * 外观控件的交互：改一个就立刻套上（保存时再持久化）。
 * 读取一律"从当前 DOM 现读"，因为设置页每次渲染都会重建这些节点。
 */
function bindAppearanceControls() {
  const box = $('#appearance-mode');
  if (!box) return;   // 不在这一页

  const el = (id) => document.getElementById(id);
  const segVal = (id, fallback) => el(id)?.querySelector('.seg-item.selected')?.dataset.v || fallback;
  const tweakMap = () => {
    const out = {};
    for (const input of document.querySelectorAll('#appearance-tweaks [data-tweak]')) {
      // 只收"被动过"的那几个：色值框没动过时显示的是占位色 #888888，把它当成用户的选择
      // 会让**每一次**外观变更都把六个变量一起覆盖成中灰（实测：点一下配色方案，
      // --bg/--border 全变成 #888888，界面糊成一片灰，色板怎么换都没反应）。
      if (input.dataset.dirty !== '1') continue;
      const hex = String(input.value || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(hex)) out[input.dataset.tweak] = hex;
    }
    return out;
  };
  // 当前自定义色：只有文本框里有合法色值才算"自定义"，否则交给预设
  const customAccent = () => (/^#?[0-9a-fA-F]{6}$/.test(String(el('cfg-accent')?.value || '').trim())
    ? String(el('cfg-accent').value).trim()
    : '');

  const readUI = () => ({
    mode: segVal('appearance-mode', 'light'),
    darkIntensity: segVal('appearance-darkintensity', 'soft'),
    scheme: document.querySelector('#appearance-schemes .scheme-card.on')?.dataset.scheme || 'default',
    // 预设 id 读容器上的 data-current（"记住的选择"），**不是**视觉上亮着的那一格：
    // 一旦设了自定义色，所有预设的选中态都会被摘掉，此时"用户上次挑的预设"仍然要留着 ——
    // 否则把自定义色清掉之后会莫名其妙跳回默认蓝。原来这里读一个隐藏 input#cfg-preset，
    // 而那个 input 在改版时被漏掉没渲染 → 点预设永远回落到 indigo（选了等于没选）。
    accentPreset: document.getElementById('appearance-presets')?.dataset.current || 'indigo',
    accent: customAccent(),
    accentScope: segVal('appearance-scope', 'global'),
    sidebarStyle: segVal('appearance-sidebarstyle', 'follow'),
    sidebarPinned: el('cfg-sidebar-pinned')?.checked === true,
    background: segVal('appearance-bg', 'none'),
    glass: segVal('appearance-glass', 'liquid'),
    refract: el('cfg-refract')?.checked === true,
    bgColor: el('cfg-bgcolor')?.value || '',
    bgFrom: el('cfg-bgfrom')?.value || '',
    bgTo: el('cfg-bgto')?.value || '',
    bgAngle: Number(el('cfg-bgangle')?.value || 135),
    font: segVal('appearance-font', 'default'),
    radius: Number(el('cfg-radius')?.value || 1),
    zoom: Number(el('cfg-zoom')?.value || 1),
    density: segVal('appearance-density', 'cozy'),
    tweaks: tweakMap(),
    showBadges: el('cfg-showbadges')?.checked !== false,
    showTopbarTheme: el('cfg-showtopbartheme')?.checked !== false,
    reduceMotion: el('cfg-reducemotion')?.checked === true,
    noMotion: el('cfg-nomotion')?.checked === true,
    contrast: el('cfg-contrast')?.checked ? 'high' : 'normal'
  });

  /** 把当前读到的值立刻套到 <html> 上。`reveal` 只给离散的颜色/明暗变更。 */
  const apply = (ev, reveal = false) => {
    const ui = readUI();
    setAppearance(ui, ev, { reveal });
    syncLabels();
    return ui;
  };
  /** 只重画与"当前值"有关的文字/选中态（不重渲染整块，避免刚点开的取色器被关掉）。 */
  function syncLabels() {
    const cur = currentAppearance();
    const zoomNow = el('appearance-zoom-now');
    if (zoomNow) zoomNow.textContent = `${Math.round(cur.zoom * 100)}%`;
    const angleNow = el('appearance-bgangle-now');
    if (angleNow) angleNow.textContent = `${cur.bgAngle}°`;
    // 预设 swatch：选中项加勾；自定义色存在时预设全部取消选中
    for (const b of document.querySelectorAll('#appearance-presets [data-preset]')) {
      const on = !cur.customAccent && b.dataset.preset === cur.accentPreset;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      if (on && !b.querySelector('svg')) b.insertAdjacentHTML('beforeend', '<span class="ico" data-icon="check" data-icon-size="16"></span>');
      if (!on) b.querySelector('.ico')?.remove();
    }
    const presetBox = document.getElementById('appearance-presets');
    if (presetBox && presetBox.dataset.current !== cur.accentPreset) presetBox.dataset.current = cur.accentPreset;
    // 折射开关：材质选「实心」时它没有对象可折，置灰并提示 —— 不置灰的话
    // “勾了没反应”看起来就像坏了（这是审查里抓到的可用性问题）。
    const refract = el('cfg-refract');
    if (refract) {
      const off = cur.glass === 'off';
      refract.disabled = off;
      // 刻意**不**清掉勾选：清了就等于“切到实心再切回来，偏好没了”，
      // 而且用户在实心状态下点保存会把这条偏好写没。置灰 + 让它不生效就够了
      //（模块侧的判据本来就要求 data-glass 在，见 glass-refract.js 的 refractShouldRun）。
      refract.closest('.opt-row')?.setAttribute('data-inert', off ? '1' : '');
    }
    document.querySelector('.swatch-custom')?.classList.toggle('on', cur.customAccent);
    // 主题微调：显示了当前值就把"重置"点亮的条件也对上
    for (const btn of document.querySelectorAll('#appearance-tweaks [data-tweak-reset]')) {
      const key = btn.dataset.tweakReset;
      const saved = Boolean(cur.tweaks[key]);
      btn.disabled = !saved;
      const hex = document.querySelector(`#appearance-tweaks [data-tweak-hex="${key}"]`);
      if (hex) hex.textContent = saved ? cur.tweaks[key] : '默认';
    }
    applyIcons(document.getElementById('appearance-presets') || document);
  }

  // ① 分段控件：点一下换档。有些档（明暗/色板/强调色）值得一条波纹，有些（字体/密度）不值得。
  // 会“整页换个样子”的档位走波纹：明暗、色板、强调色、材质。
  // 字体/密度/圆角这类改了也照样开波纹的话，拖一下滑条就闪一次 —— 它们不在名单里。
  const REVEAL_SEGS = new Set(['appearance-mode', 'appearance-scope', 'appearance-sidebarstyle', 'appearance-darkintensity', 'appearance-glass']);
  for (const segEl of document.querySelectorAll('.opt-card .seg')) {
    segEl.addEventListener('click', (ev) => {
      const item = ev.target.closest('.seg-item');
      if (!item || item.classList.contains('selected')) return;
      segEl.querySelectorAll('.seg-item').forEach((b) => {
        const on = b === item;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', String(on));
      });
      refreshSeg(segEl);
      if (segEl.id === 'appearance-radius') {
        const tier = RADII.find((r) => r.id === item.dataset.v) || RADII[1];
        const hidden = el('cfg-radius');
        if (hidden) hidden.value = String(tier.value);
      }
      if (segEl.id === 'appearance-density') {
        const hidden = el('cfg-density');
        if (hidden) hidden.value = item.dataset.v || 'cozy';
      }
      if (segEl.id === 'appearance-bg') toggleBgDetail(item.dataset.v);
      apply(ev, REVEAL_SEGS.has(segEl.id));
    });
  }

  // ② 色板卡：换配色（离散 → 走波纹）
  const schemes = document.getElementById('appearance-schemes');
  schemes?.addEventListener('click', (ev) => {
    const card = ev.target.closest('.scheme-card');
    if (!card) return;
    schemes.querySelectorAll('.scheme-card').forEach((x) => {
      x.classList.toggle('on', x === card);
      x.setAttribute('aria-pressed', String(x === card));
    });
    apply(ev, true);
  });

  // ③ 强调色预设（离散 → 波纹）。选预设 = 明确放弃自定义色，否则自定义色会一直压着预设
  const presets = document.getElementById('appearance-presets');
  presets?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-preset]');
    if (!btn || btn.classList.contains('swatch-custom')) return;
    // 顺序要紧：先把"记住的选择"写进 data-current，readUI 才读得到新的预设 id
    presets.dataset.current = btn.dataset.preset || 'indigo';
    for (const b of presets.querySelectorAll('[data-preset]')) {
      const on = b === btn;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    // 选预设 = 明确放弃自定义色，否则自定义色会一直压着预设
    const accent = el('cfg-accent');
    if (accent) accent.value = '';
    apply(ev, true);
  });

  // ④ 自定义色：文本框（输入即时生效）与取色器（选完即时生效）
  const accentText = el('cfg-accent');
  const onAccentText = (ev) => {
    // 输入过程中只做"局部预览"：不是合法色值就什么都不做，避免每敲一个字符就闪一下波纹
    const v = String(accentText.value || '').trim();
    if (v && !/^#?[0-9a-fA-F]{6}$/.test(v)) return;
    apply(ev, false);
  };
  accentText?.addEventListener('input', onAccentText);
  accentText?.addEventListener('change', (ev) => apply(ev, false));
  el('cfg-accent-custom')?.addEventListener('input', (ev) => {
    const v = ev.target.value;
    if (accentText) accentText.value = v;
    apply(ev, true);
  });

  // ⑤ 缩放 / 背景角度：连续型滑条，绝不走波纹
  for (const id of ['cfg-zoom', 'cfg-bgangle']) {
    const input = el(id);
    if (!input) continue;
    input.addEventListener('input', (ev) => apply(ev, false));
    input.addEventListener('change', (ev) => apply(ev, false));
  }
  // ⑥ 取色器（背景色 / 渐变两端）：拖动时不重放波纹，选完也不用
  for (const id of ['cfg-bgcolor', 'cfg-bgfrom', 'cfg-bgto']) {
    const input = el(id);
    if (!input) continue;
    input.addEventListener('input', (ev) => {
      const sw = input.closest('.tweak-swatch');
      if (sw) sw.style.background = input.value;
      apply(ev, false);
    });
  }

  // ⑦ 主题微调：改一个颜色就覆盖一个变量；重置把它还给色板
  const tweakBox = document.getElementById('appearance-tweaks');
  tweakBox?.addEventListener('input', (ev) => {
    const input = ev.target.closest('[data-tweak]');
    if (!input) return;
    input.dataset.dirty = '1';   // 用户真的动过它 —— 从这一刻起它才是一个"覆盖"
    const sw = input.closest('.tweak-swatch');
    if (sw) sw.style.background = input.value;
    apply(ev, false);
  });
  tweakBox?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-tweak-reset]');
    if (!btn || btn.disabled) return;
    const key = btn.dataset.tweakReset;
    const input = tweakBox.querySelector(`[data-tweak="${key}"]`);
    const sw = input?.closest('.tweak-swatch');
    // 重置 = 抹掉"动过"的标记并清空色值框 → readUI 不再收它 → 变量值为 null → 内联属性被摘掉，
    // 控制权还给色板（不必再手工 delete 一次 map）
    if (input) { input.value = '#888888'; delete input.dataset.dirty; }
    if (sw) sw.style.background = `var(${key})`;
    apply(ev, false);
  });

  // ⑧ 开关（顶栏 / 无障碍）：开关自己就是 checkbox，直接读值
  for (const id of ['cfg-showbadges', 'cfg-showtopbartheme', 'cfg-reducemotion', 'cfg-nomotion', 'cfg-contrast', 'cfg-sidebar-pinned', 'cfg-refract']) {
    el(id)?.addEventListener('change', (ev) => apply(ev, false));
  }

  /** 背景类型切到"无"时把细节行收起来，别留一行空控件。 */
  function toggleBgDetail(type) {
    const detail = el('appearance-bg-detail');
    if (detail) detail.style.display = type === 'none' ? 'none' : 'flex';
    const solid = el('appearance-bg-solid');
    if (solid) solid.style.display = type === 'solid' ? 'block' : 'none';
    const grad = el('appearance-bg-gradient');
    if (grad) grad.style.display = type === 'gradient' ? 'flex' : 'none';
    const cw = el('appearance-bg-colorwrap');
    if (cw) cw.style.display = type === 'solid' ? 'flex' : 'none';
  }

  // 色板预览卡里的"底色"要按当前明暗画，所以每次绑定时对着当前主题刷一遍内联色
  refreshPanel = () => {
    syncLabels();
    paintSchemePreviews();
    // 侧栏图钉（在侧栏上）与这个开关是同一个轴：从那边改完，面板里的勾要跟着走
    const pin = el('cfg-sidebar-pinned');
    if (pin) pin.checked = currentAppearance().sidebarPinned === true;
  };
  refreshPanel();
  bindAppearanceListener();
}

/**
 * 外观一变就刷新"面板上的当前值"（选中态、缩放百分比、微调行的字面、色板预览的强调色圆点）。
 * 挂在 applyAppearance 广播的 qqa:appearance 上而不是紧跟在 setAppearance 后面：
 * 走波纹时应用是延后执行的，跟在调用点后面刷只会刷到"还没生效"的那份。
 * 只注册一次（模块级标记）：设置页每渲染一次都会调 bindAppearanceControls。
 */
let appearanceListenerBound = false;
/** 当前这一版面板的"刷新自身"动作；每次渲染时由 bindAppearanceControls 替换。 */
let refreshPanel = null;

function bindAppearanceListener() {
  if (appearanceListenerBound) return;
  appearanceListenerBound = true;
  document.addEventListener('qqa:appearance', () => {
    try { refreshPanel?.(); } catch { /* 面板可能已经不在这一页了，忽略 */ }
  });
}

/**
 * 给色板预览卡上色：外框 = 该色板在**当前明暗**下的页面底色，中间那块 = 卡片色，圆点 = 当前强调色。
 * 颜色值写死在 ui/style.css 的 [data-scheme][data-theme] 块里，这里只取预览要用的那两份 ——
 * 用一张表而不是 getComputedStyle 逐个探，是因为预览卡要显示"没选中的那几套"长什么样，
 * 而计算样式只拿得到当前生效的那一套。
 */
const SCHEME_PREVIEW = {
  dark: {
    // 默认色板＝ style.css 的基础主题块。这条表与 CSS 的一致性由
    // test/appearance-schemes.test.mjs 盯着，改了一边不改另一边会直接红。
    default: { bg: '#0b1220', card: '#111b2d' },
    slate: { bg: '#191d24', card: '#20252e' },
    rose: { bg: '#241f38', card: '#2b2645' },
    forest: { bg: '#1b2a23', card: '#22332b' },
    nord: { bg: '#2e3440', card: '#3b4252' }
  },
  light: {
    default: { bg: '#f4f7fc', card: '#ffffff' },
    slate: { bg: '#ededed', card: '#f8f8f8' },
    rose: { bg: '#fceef4', card: '#fff4f8' },
    forest: { bg: '#f6f1e3', card: '#fdf6e3' },
    nord: { bg: '#e5e9f0', card: '#eceff4' }
  }
};

function paintSchemePreviews(app = currentAppearance()) {
  const mode = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const table = SCHEME_PREVIEW[mode];
  // 强调色的圆点直接用传进来的生效值：不必 getComputedStyle 去问渲染后的 CSS
  // （少一次强制样式计算；而且那一下在 happy-dom 里会踩到变量解析的栈溢出，
  //   表现是整段绑定静默中断 —— 后面 bindSettingsEvents 不再执行、保存按钮点了没反应）
  const accent = app.accent;
  for (const prev of document.querySelectorAll('#appearance-schemes [data-prev]')) {
    const p = table[prev.dataset.prev];
    if (!p) continue;
    prev.style.background = p.bg;
    prev.innerHTML = `<span class="sc-dots" style="background:${esc(p.card)}">
        <i style="background:${esc(accent)}"></i>
        <i style="background:${esc(p.bg)}"></i>
        <i style="background:var(--muted)"></i>
      </span>`;
  }
}
export { bindAppearanceControls, bindAppearanceListener, paintSchemePreviews, renderAppearanceBlock };
