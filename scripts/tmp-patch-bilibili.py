from pathlib import Path
import re

p = Path('examples/plugins/bilibili/index.mjs')
s = p.read_text()

# ── 1) interact: host-side gating + idempotent checks + verify ──
start = s.find('  async interact({ action, bvid, mid, undo, count } = {}) {')
end = s.find('  async comment({ bvid, text } = {}) {')
assert start >= 0 and end > start, 'interact block not found'
new_interact = '''  // ── 写操作的当前状态（幂等的依据：已做过就跳过，而不是重复做） ──
  async function likedState(bvid) {
    const data = await httpJson(`${API}/x/web-interface/archive/has/like?bvid=${encodeURIComponent(bvid)}`, { auth: true });
    return Number(data?.data) === 1;
  }
  async function coinState(bvid) {
    const data = await httpJson(`${API}/x/web-interface/archive/coins/info?bvid=${encodeURIComponent(bvid)}`, { auth: true });
    return Number(data?.data?.multiply) || 0;
  }
  async function relationState(mid) {
    const data = await httpJson(`${API}/x/relation?fid=${encodeURIComponent(mid)}`, { auth: true });
    const attribute = Number(data?.data?.attribute) || 0;
    return attribute === 2 || attribute === 3 || attribute === 6;
  }

  /**
   * 写操作由宿主统一把门（开关 → 对象级批准 → 配额，见宿主 plugins/registry.js），
   * 插件这里只负责：执行前查当前状态（幂等）、执行、写后回读核验。
   * 失败直接 throw —— 宿主会把已扣的批准与配额退回去。
   */
  async interact({ action, bvid, mid, undo, count } = {}) {
    const auth = await requireLogin();
    if (!['like', 'coin', 'favorite', 'follow'].includes(action)) throw new Error('action 只能是 like / coin / favorite / follow');

    if (action === 'follow') {
      const target = String(mid || '').trim();
      if (!/^\\d+$/.test(target)) throw new Error('follow 需要 mid（UP 主 UID）');
      const followed = await relationState(target);
      if (!undo && followed) return { ok: true, action, target, skipped: 'already-followed', verified: true };
      if (undo && !followed) return { ok: true, action, target, skipped: 'not-followed', verified: true };
      await httpJson(`${API}/x/relation/modify`, {
        method: 'POST', auth: true,
        form: { fid: target, act: undo ? 2 : 1, re_src: 11, csrf: auth.bili_jct }
      });
      const verified = (await relationState(target)) === !undo;
      return { ok: true, action, target, undo: Boolean(undo), verified };
    }

    const info = await viewOf(bvid);
    if (action === 'like') {
      const liked = await likedState(info.bvid);
      if (!undo && liked) return { ok: true, action, target: info.bvid, skipped: 'already-liked', verified: true };
      if (undo && !liked) return { ok: true, action, target: info.bvid, skipped: 'not-liked', verified: true };
      await httpJson(`${API}/x/web-interface/archive/like`, {
        method: 'POST', auth: true,
        form: { bvid: info.bvid, like: undo ? 2 : 1, csrf: auth.bili_jct }
      });
      const verified = (await likedState(info.bvid)) === !undo;
      return { ok: true, action, target: info.bvid, undo: Boolean(undo), verified };
    }

    if (action === 'coin') {
      // 幂等：按差额补足到目标枚数，而不是盲目再投 N 枚
      const wantedTotal = num(count, 1, 1, 2);
      const given = await coinState(info.bvid);
      const need = wantedTotal - given;
      if (need <= 0) return { ok: true, action, target: info.bvid, skipped: `already-${given}-coins`, verified: true };
      await httpJson(`${API}/x/web-interface/coin/add`, {
        method: 'POST', auth: true,
        form: { bvid: info.bvid, multiply: need, select_like: 0, csrf: auth.bili_jct }
      });
      const verified = (await coinState(info.bvid)) >= wantedTotal;
      return { ok: true, action, target: info.bvid, count: need, total: wantedTotal, verified };
    }

    // favorite：收藏到默认收藏夹（第一个），写后回读确认
    if (!auth.mid) throw new Error('收藏需要 DedeUserID：请在插件设置里补上');
    const folders = await httpJson(`${API}/x/v3/fav/folder/created/list-all?up_mid=${auth.mid}`, { auth: true });
    const folder = (folders?.data?.list || [])[0];
    if (!folder) throw new Error('你的账号还没有收藏夹，先在 B 站网页建一个');
    const inFolder = async () => {
      const list = await httpJson(`${API}/x/v3/fav/resource/list?media_id=${folder.id}&pn=1&ps=20&keyword=${encodeURIComponent(info.bvid)}&platform=web`, { auth: true });
      return (list?.data?.medias || []).some((item) => item.bvid === info.bvid);
    };
    if (!undo && await inFolder()) return { ok: true, action, target: info.bvid, skipped: 'already-favorited', verified: true };
    await httpJson(`${API}/x/v3/fav/resource/deal`, {
      method: 'POST', auth: true,
      form: {
        rid: info.aid, type: 2,
        add_media_ids: undo ? '' : String(folder.id),
        del_media_ids: undo ? String(folder.id) : '',
        csrf: auth.bili_jct
      }
    });
    const verified = (await inFolder()) === !undo;
    return { ok: true, action, target: info.bvid, folder: folder.title, undo: Boolean(undo), verified };
  }

'''
s = s[:start] + new_interact + s[end:]

# ── 2) comment: remove gating, add read-back verify ──
start = s.find('  async comment({ bvid, text } = {}) {')
end = s.find('  async danmaku({ bvid, text, progressMs } = {}) {')
assert start >= 0 and end > start, 'comment block not found'
new_comment = '''  async comment({ bvid, text } = {}) {
    const auth = await requireLogin();
    const body = String(text || '').trim();
    if (!body) throw new Error('评论内容不能为空');
    if (body.length > 500) throw new Error('评论最多 500 字');
    const info = await viewOf(bvid);
    const data = await httpJson(`${API}/x/v2/reply/add`, {
      method: 'POST', auth: true,
      form: { oid: info.aid, type: 1, message: body, csrf: auth.bili_jct }
    });
    const rpid = Number(data?.data?.rpid) || 0;
    // 回读核验：按 rpid 拉这条评论，拉不到不算 verified（可能被秒删/进审核）
    let verified = false;
    if (rpid) {
      try {
        const back = await httpJson(`${API}/x/v2/reply/view?type=1&oid=${info.aid}&root=${rpid}`, { auth: true });
        verified = Number(back?.data?.root?.rpid) === rpid || Number(back?.data?.replies?.[0]?.rpid) === rpid;
      } catch { verified = false; }
    }
    return { ok: true, bvid: info.bvid, rpid, verified, url: bvLink(info.bvid) };
  }

'''
s = s[:start] + new_comment + s[end:]

# ── 3) danmaku: read-only + new danmaku_send ──
start = s.find('  async danmaku({ bvid, text, progressMs } = {}) {')
assert start >= 0, 'danmaku block not found'
tail = s[start:]
end_marker = tail.find('\n};')
assert end_marker > 0, 'tools object end not found'
new_dm = '''  async danmaku({ bvid } = {}) {
    const info = await viewOf(bvid);
    const raw = await httpJson(`${API}/x/v1/dm/list.so?oid=${info.cid}`, { asText: true, decompress: true });
    const rows = [];
    const re = /<d p="([^"]*)">([^<]*)<\\/d>/g;
    let match;
    while ((match = re.exec(raw)) && rows.length < num(setting('danmakuCount', 30), 30, 10, 100)) {
      const parts = match[1].split(',');
      rows.push({ atMs: Math.round((Number(parts[0]) || 0) * 1000), mode: Number(parts[1]) || 1, text: match[2] });
    }
    if (!rows.length) {
      throw new Error('没有读到弹幕（接口可能返回了压缩数据，或这个视频关了弹幕）');
    }
    return { bvid: info.bvid, count: rows.length, results: rows };
  },

  async danmaku_send({ bvid, text, progressMs } = {}) {
    const auth = await requireLogin();
    const want = String(text || '').trim();
    if (!want) throw new Error('弹幕内容不能为空');
    if (want.length > 100) throw new Error('弹幕最多 100 字');
    const info = await viewOf(bvid);
    const sendOnce = (endpoint) => httpJson(`${API}${endpoint}`, {
      method: 'POST', auth: true,
      form: {
        oid: info.cid, type: 1, msg: want,
        progress: num(progressMs, 5000, 0, Math.max(1000, info.duration * 1000)),
        bvid: info.bvid, csrf: auth.bili_jct
      }
    });
    try {
      await sendOnce('/x/v1/dm/post');
    } catch (error) {
      // 老接口被关时退回 v2（两个接口的参数一致）
      if (!/HTTP 404|-404/.test(String(error?.message || error))) throw error;
      await sendOnce('/x/v2/dm/post');
    }
    // 弹幕没有可靠的按条回读接口：不标 verified，宿主按发送接口 200 记成功
    return { ok: true, bvid: info.bvid, text: want, url: bvLink(info.bvid) };
  }
};
'''
s = s[:start] + new_dm + tail[end_marker + 3:]

p.write_text(s)
print('plugin patched')
