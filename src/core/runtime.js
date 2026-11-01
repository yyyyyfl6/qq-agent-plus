// 运行环境识别：容器里没有 systemd、没有宿主 docker 套接字，也没有 deploy.sh 的部署基线。
// 这些能力相关的分支集中在这里判断，避免每个模块各自 `fs.existsSync('/.dockerenv')`。
//
// 优先级：显式环境变量 > 容器标记文件。显式值让测试与特殊部署（K8s、Podman）可控；
// 标记文件覆盖 docker/podman 的常见路径。不做缓存：一次启动只判几次，缓存反而让测试
// 需要额外重置，且运行期环境变量理论上是常量。
import fs from 'node:fs';

const CONTAINER_VALUES = new Set(['1', 'true', 'yes', 'on', 'docker', 'container', 'podman']);
const HOST_VALUES = new Set(['0', 'false', 'no', 'off', 'host', 'systemd', 'bare']);

/** 当前进程是否跑在容器里（Docker / Podman / K8s 常见标记）。 */
export function isContainerRuntime() {
  const forced = String(process.env.QQ_AGENT_RUNTIME || '').trim().toLowerCase();
  if (CONTAINER_VALUES.has(forced)) return true;
  if (HOST_VALUES.has(forced)) return false;
  try {
    if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) return true;
  } catch { /* 读不到标记按宿主机处理 */ }
  // K8s 会注入这个变量，但没有 systemd；按容器处理能让更新/协议端分支给出正确提示。
  return Boolean(String(process.env.KUBERNETES_SERVICE_HOST || '').trim());
}

/** 'docker' | 'systemd'：只用于展示与控制台文案。 */
export function runtimeKind() {
  return isContainerRuntime() ? 'docker' : 'systemd';
}

/** 容器模式下所有"更新"类操作的统一说明（控制台、ops、异常信息共用）。 */
export function containerUpdateHint() {
  return '当前以容器运行：应用由镜像管理。升级时先把 compose 里的 QQ_AGENT_IMAGE（或其他镜像引用）改成目标版本，再 docker compose pull && docker compose up -d；协议端镜像同理。';
}
