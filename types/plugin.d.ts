// QQ Agent Plus 插件作者类型声明（仅编辑器用；运行时零依赖、不打包 .d.ts）。
//
// 这些类型描述的是 `plugin.json` 与宿主 stdin/stdout 协议的形状，
// 不是可以直接 import 的运行时模块。契约正文见 docs/PLUGINS.md。

export interface PluginManifest {
  id: string;
  apiVersion: 1 | 2;
  name: string;
  version: string;
  description?: string;
  entry: string;
  author?: string;
  capabilities: PluginCapability[];
  httpDomains?: string[];
  httpMaxBytes?: number;
  tools: PluginTool[];
  approvals?: PluginApproval[];
  quotas?: Record<string, number>;
  settings?: { groups: PluginSettingsGroup[] };
  schedule?: PluginSchedule[];
  engines?: { minVersion?: string };
}

export type PluginCapability =
  | 'tools' | 'log' | 'config' | 'http' | 'storage' | 'secrets'
  | 'approval' | 'quota' | 'media' | 'send' | 'observe' | 'schedule';

export interface PluginTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 有 action 的工具是写操作：宿主会走开关 + 对象级批准 + 配额 + 60 秒间隔。 */
  action?: string;
  actionTarget?: string | string[];
  actionPreview?: string;
  timeoutMs?: number;
}

export interface PluginApproval {
  action: string;
  label: string;
  description?: string;
  defaultUses?: number;
}

export interface PluginSettingsGroup {
  key: string;
  title: string;
  description?: string;
  fields: PluginSettingsField[];
}

export interface PluginSettingsField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'secret';
  default?: unknown;
  help?: string;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
}

export interface PluginSchedule {
  name: string;
  everyMs: number;
}

/** 宿主 → 插件的方法。 */
export type HostMethod = 'init' | 'ping' | 'callTool' | 'observe' | 'schedule' | 'probe' | 'shutdown';

/** 插件 → 宿主的能力方法（必须先在 manifest.capabilities 里声明）。 */
export type CapabilityMethod =
  | 'cap.log.write' | 'cap.config.get' | 'cap.storage.get' | 'cap.storage.set'
  | 'cap.http.request' | 'cap.secrets.get' | 'cap.secrets.set'
  | 'cap.approval.check' | 'cap.quota.consume'
  | 'cap.media.download' | 'cap.media.probe' | 'cap.media.merge' | 'cap.media.frames'
  | 'cap.media.describe' | 'cap.asr.transcribe' | 'cap.send.text' | 'cap.send.file';
