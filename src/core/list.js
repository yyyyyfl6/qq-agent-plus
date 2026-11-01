// 名单字段（allow/deny 的 groups/private）的唯一边界：config.json 可以手改，
// `POST /api/config` 也会照单全收。形状不对时按"空名单"处理，绝不让一个字符串
// 变成 `.map` 抛错、把整条入站链路或配置保存打挂。
export function idList(value) {
  return Array.isArray(value) ? value.map(String) : [];
}
