'use strict';

// 设置页右侧的页头（2026-11 用户反馈"设置右侧有点违和"）：
//   · 原来正文顶部让出 88px 给浮动顶栏，但那一块什么都没有 —— 一大片空白、也看不出"现在在哪一节"；
//   · 现在在这块位置放「设置 / 分组 / 分区」面包屑 + 分区标题 + 一句说明，正文卡片紧接其后。
// 分组与分区名直接从左栏菜单的 DOM 读（pages/settings.js 是唯一真相源），说明文字按分区 id 查表。
// 走 QARegistry.onAfter('renderSettings')：设置页每次整页重画后装回去（幂等）。

import { esc } from './core/dom.js';
import { QARegistry } from './core/registry.js';
import { state } from './core/state.js';

(function settingsPolish() {
  const DESCRIPTIONS = {
    persona: '机器人的名字、角色卡正文与附加规则；可以试聊草稿卡、让 AI 起草新卡。按会话切换多套人格请到侧栏「人格」。',
    chat: '回复节奏、触发方式、分条与引用等聊天行为。',
    messageTypes: '哪些消息类型（合并转发、卡片、语音、视频…）要展开交给模型。',
    allow: '机器人在哪些群和私聊里工作；不在名单里的会话一律不响应。',
    memory: '人物记忆的可见范围、整理节奏与上下文共享。',
    api: '聊天用的模型服务、Key 与模型；支持 OpenAI 兼容服务与 Google Vertex（服务账号 JSON）。',
    search: '联网搜索用哪家：谷歌、Edge（必应国际版）、国内各家搜索 API 或聚合。',
    asr: '语音转文字、语音合成与图片生成的服务与额度。',
    'token-saver': '控制单轮工具轮数与 token 上限，省钱档位。',
    moments: '每日 QQ 空间动态与群日报。',
    'qzone-interactions': '好友动态的点赞、评论与回复。',
    reminders: '「X 点提醒我 Y」的持久化提醒。',
    'life-feed': '见闻：机器人主动分享的内容来源与频率。',
    groupGame: '由系统主持的多人群游戏（谁是卧底、狼人杀…）。',
    'time-control': '机器人的作息：哪些时段工作、哪些时段只记录。',
    experiments: '实验功能的启用与固化（只放开关，功能本身在各自页面）。',
    platform: '协议端能力（群管、戳一戳、表情回应…）按群开关。',
    onebot: '外部 OneBot v11 协议端的连接地址与令牌。',
    mcp: '接入 MCP 服务器，给模型更多工具。',
    knowledge: '本地知识库目录与检索参数。',
    memes: '梗库：群里的梗与黑话。',
    moderation: '群管理动作（禁言、踢人、撤回）的授权与限制。',
    appearance: '明暗、配色、强调色、材质、字体与圆角。',
    desktop: '管理员 QQ、控制台令牌与界面刷新等系统项。'
  };

  function locate() {
    const active = document.querySelector('#settings-sidebar .settings-menu-item.active');
    let group = '';
    for (let node = active?.previousElementSibling; node; node = node.previousElementSibling) {
      if (node.classList.contains('settings-menu-group')) { group = node.textContent.trim(); break; }
    }
    return { label: active?.textContent.trim() || '', group };
  }

  function mount() {
    const form = document.getElementById('settings-form');
    if (!form || form.querySelector(':scope > .settings-head')) return;
    const query = String(state.settingsQuery || '').trim();
    const { label, group } = locate();
    const section = state.settingsSection || 'api';
    const title = query ? `搜索：${query}` : (label || '设置');
    const desc = query ? '下面列出匹配的设置项；清空左侧搜索框回到分区浏览。' : (DESCRIPTIONS[section] || '');
    const head = document.createElement('header');
    head.className = 'settings-head';
    head.innerHTML = `
      <div class="settings-crumb">设置${group && !query ? ` <span aria-hidden="true">/</span> ${esc(group)}` : ''}</div>
      <h2>${esc(title)}</h2>
      ${desc ? `<p>${esc(desc)}</p>` : ''}`;
    form.prepend(head);
  }

  QARegistry.onAfter('renderSettings', mount);
})();
