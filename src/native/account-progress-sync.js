const exactId = value => typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value);

function chooseAccountProgress(local, cloud, { allowNew = false } = {}) {
  if (!local || !exactId(local.series_id) || !exactId(local.episode_id)
    || !Number.isSafeInteger(local.vid_index) || local.vid_index < 1
    || !Number.isFinite(local.currentTime) || local.currentTime < 0
    || !Number.isSafeInteger(local.updatedAt) || local.updatedAt <= 0) {
    throw new Error('没有可同步的本机播放进度，请先观看一集。');
  }
  if (!cloud && allowNew) return 'upload';
  if (!cloud || cloud.series_id !== local.series_id || !exactId(cloud.episode_id)
    || !Number.isSafeInteger(cloud.updatedAt) || cloud.updatedAt <= 0
    || !Number.isFinite(cloud.currentTime) || cloud.currentTime < 0) {
    throw new Error(allowNew ? '这部剧的云端进度暂时无法确认，请稍后刷新。' : '未能核实这部剧的云端进度。请先在手机上观看这部剧，再测试同步。');
  }
  if (isSameAccountProgress(local, cloud)) return 'unchanged';
  if (local.updatedAt === cloud.updatedAt) throw new Error('两端更新时间相同但进度不同，请重新播放后再试。');
  return local.updatedAt > cloud.updatedAt ? 'upload' : 'download';
}

function isSameAccountProgress(left, right) {
  return !!left && !!right && left.series_id === right.series_id && left.episode_id === right.episode_id
    && Math.abs(left.currentTime - right.currentTime) <= 1;
}

function accountProgressBodies(position) {
  const stamp = position.updatedAt;
  const milliseconds = Math.round(position.currentTime * 1000);
  const duration = Math.round((position.duration || 0) * 1000);
  if (!exactId(position.series_id) || !exactId(position.episode_id)
      || !Number.isSafeInteger(milliseconds) || milliseconds < 0
      || !Number.isSafeInteger(duration) || duration <= 0 || milliseconds > duration + 1000) {
    throw new Error('本机播放位置或分集时长无效，请重新播放后再试。');
  }
  return {
    history: { update_datas: [{
      book_id: JSON.rawJSON(position.series_id),
      book_type: 2,
      vid: JSON.rawJSON(position.episode_id),
      vid_index: position.vid_index,
      current_play_position: milliseconds,
      read_timestamp_ms: stamp,
      update_timestamp_ms: stamp,
      duration,
      episode_cnt: position.total,
      is_delete: false,
    }] },
    progress: { books: [{
      book_id: position.series_id,
      book_type: 2,
      item_id: position.episode_id,
      vid_index: position.vid_index,
      current_play_time: milliseconds,
      read_timestamp_ms: stamp,
      progress_type: 0,
      check_timestamp: true,
      is_listen_mode: false,
    }] },
  };
}

function verifyAccountProgressWrite(payload) {
  const success = payload?.code === 0 || payload?.code === '0';
  const failures = [payload?.error_code, payload?.data?.error_code];
  if (!success || payload.success === false || failures.some(value => value !== undefined && value !== 0 && value !== '0')) {
    throw new Error('红果服务器未确认写入这条进度。请刷新云端记录后核对。');
  }
}

function mergeAccountWatchHistory(localRows, cloudRows, playback, accountId) {
  const rows = new Map(localRows.map(row => [String(row.series_id), row]));
  if (!accountId) return localRows;
  for (const cloud of cloudRows) {
    const id = String(cloud.series_id);
    const local = rows.get(id);
    if (!exactId(id) || !Number.isFinite(cloud.updatedAt) || cloud.updatedAt <= 0
      || Number(playback[id]?.accountHidden?.[accountId]) >= cloud.updatedAt) continue;
    const total = Math.max(local?.total || 0, cloud.total || 0);
    const localCompleted = local?.completed === true && local.total === total;
    if (local && local.updatedAt >= cloud.updatedAt) {
      if (total > local.total) rows.set(id, { ...local, total, completed: false });
      continue;
    }
    rows.set(id, {
      ...local,
      ...cloud,
      cover: cloud.cover || local?.cover || '',
      account: true,
      hasLocal: !!local,
      total,
      completed: localCompleted || (total > 0 && cloud.vid_index === total
        && cloud.duration > 0 && cloud.currentTime > 0
        && cloud.currentTime >= cloud.duration - Math.min(1, cloud.duration * 0.01)
        && cloud.currentTime <= cloud.duration + 1),
    });
  }
  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

module.exports = { chooseAccountProgress, isSameAccountProgress, accountProgressBodies, verifyAccountProgressWrite, mergeAccountWatchHistory };
