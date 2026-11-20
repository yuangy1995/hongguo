import { t, useLanguage, getLanguage } from '../i18n';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import './DownloadManager.css';
import { AlertCircle, Check, Clock, Download, Trash2, RefreshCw, X, Film, Square, Folder, Zap, CheckSquare, Play, Pause, Layers, ChevronDown } from './icons';

const STATUS_TEXT = {
  pending: '等待中',
  downloading: '下载中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const STATUS_ORDER = {
  downloading: 0,
  pending: 1,
  failed: 2,
  stopped: 3,
  completed: 4,
};

const isWaitingRetry = task => task.status === 'failed' && !!task.retryAt;
const needsManualRetry = task => task.status === 'stopped' || task.status === 'failed' && !isWaitingRetry(task);
const seriesKey = task => task.hongguoInfo?.series_id != null ? `series:${task.hongguoInfo.series_id}` : `task:${task.id}`;
const seriesLabel = task => task.hongguoInfo?.series_title || task.title || task.filename || '';

function sortTasks(list) {
  const key = seriesKey;
  const groups = new Map();
  for (const task of list) {
    const group = groups.get(key(task)) || { rank: 99, time: 0 };
    group.rank = Math.min(group.rank, STATUS_ORDER[task.status] ?? 99);
    group.time = Math.max(group.time, task.startTime || 0);
    groups.set(key(task), group);
  }
  return [...list].sort((a, b) => {
    const ka = key(a), kb = key(b), ga = groups.get(ka), gb = groups.get(kb);
    if (ka !== kb) return ga.rank - gb.rank || gb.time - ga.time || ka.localeCompare(kb, 'zh-CN', { numeric: true });
    return (Number(a.hongguoInfo?.vid_index) || 0) - (Number(b.hongguoInfo?.vid_index) || 0) || (a.startTime || 0) - (b.startTime || 0);
  });
}

function fmtElapsed(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return value < 60 ? `${value} 秒` : value < 3600 ? `${Math.floor(value / 60)} 分 ${value % 60} 秒` : `${Math.floor(value / 3600)} 小时 ${Math.floor(value % 3600 / 60)} 分`;
}

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

const PAGE_SIZE = 100;
const SERIES_PAGE_SIZE = 24;
const STATUS_MODAL_TITLES = {
  active: '进行中任务',
  retry: '等待重试任务',
  done: '已完成任务',
  fail: '失败/停止任务',
};
const EPISODE_STATUS_TEXT = {
  completed: '已下载',
  downloading: '下载中',
  pending: '等待中',
  retrying: '等待重试',
  failed: '失败',
  stopped: '已停止',
  missing: '未下载',
  locked: '未解锁',
};

function DownloadManager({ onNavigate, active = true }) {
  const mobile = window.electronAPI?.platform === 'android';
  useLanguage();
  const [tasks, setTasks] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [queue, setQueue] = useState({ active: 0, queued: 0, maxConcurrent: 3 });
  const [seriesList, setSeriesList] = useState([]);
  const [mergeSeriesId, setMergeSeriesId] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState('');
  const [mergeTasks, setMergeTasks] = useState([]);
  const [mergeDeleteSources, setMergeDeleteSources] = useState(false);
  const [confirmAsk, setConfirmAsk] = useState(null); // 删除确认（可勾选删除本地文件）
  const [mergeAsk, setMergeAsk] = useState(false);    // 合并格式选择
  const [page, setPage] = useState(1);
  const [seriesFilter, setSeriesFilter] = useState('');
  const [orderVersion, setOrderVersion] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [statusModal, setStatusModal] = useState(null);
  const [statusModalPage, setStatusModalPage] = useState(1);
  const [seriesModalKey, setSeriesModalKey] = useState(null);
  const [seriesModalFilter, setSeriesModalFilter] = useState('all');
  const [seriesModalPage, setSeriesModalPage] = useState(1);
  const [seriesDetail, setSeriesDetail] = useState(null);
  const [seriesDetailLoading, setSeriesDetailLoading] = useState(false);
  const [downloadingEpisodes, setDownloadingEpisodes] = useState(() => new Set());
  const toastTimerRef = useRef(null);
  const moreActionsRef = useRef(null);
  const usageNoticeRef = useRef(null);
  const mergeRequestRef = useRef(false);
  const mergeDialogGenerationRef = useRef(0);
  const seriesDetailReqRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const requests = useRef({ tasks: 0, queue: 0, series: 0, merges: 0 });
  const taskIndex = useRef(new Map());
  const downloadedSeries = useRef(new Set());

  useEffect(() => {
    if (!active) {
      seriesDetailReqRef.current += 1;
      setStatusModal(null);
      setSeriesModalKey(null);
      setSeriesDetail(null);
      setSeriesDetailLoading(false);
    }
  }, [active]);

  useEffect(() => {
    const menu = moreActionsRef.current;
    if (!mobile) {
      if (!active) {
        menu?.hidePopover?.();
        usageNoticeRef.current?.hidePopover?.();
      }
      return;
    }
    const close = () => { if (menu) menu.open = false; };
    if (!active) { close(); return; }
    const outside = event => { if (!menu?.contains(event.target)) close(); };
    const escape = event => {
      if (event.key !== 'Escape' || !menu?.open) return;
      event.preventDefault(); event.stopPropagation();
      close(); menu.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', close);
    };
  }, [active, mobile]);

  const refresh = useCallback(async () => {
    const request = ++requests.current.tasks;
    try {
      const list = await window.electronAPI.getDownloadTasks();
      if (!activeRef.current || request !== requests.current.tasks) return;
      if (!Array.isArray(list)) throw new Error('下载任务读取失败，请重试');
      for (const task of list) if (task.status === 'completed' && task.hongguoInfo?.series_id) downloadedSeries.current.add(String(task.hongguoInfo.series_id));
      setTasks(list);
      setOrderVersion(value => value + 1);
      const ids = new Set(list.map(task => task.id));
      setSelected(previous => new Set([...previous].filter(id => ids.has(id))));
      setLoadError('');
    } catch (error) {
      if (activeRef.current && request === requests.current.tasks) setLoadError(error.message || '下载任务读取失败，请重试');
    }
  }, []);

  const loadQueue = useCallback(async () => {
    const request = ++requests.current.queue;
    try {
      const q = await window.electronAPI.getQueueStatus();
      if (q && activeRef.current && request === requests.current.queue) setQueue(q);
    } catch (_) {}
  }, []);

  const loadSeriesList = useCallback(async (verifyFiles = true) => {
    const request = ++requests.current.series;
    try {
      let list = (await window.electronAPI.getSeriesList(verifyFiles ? { downloadedOnly: true } : undefined)) || [];
      if (!activeRef.current || request !== requests.current.series) return;
      if (verifyFiles) downloadedSeries.current = new Set(list.map(series => String(series.series_id)));
      else list = list.filter(series => downloadedSeries.current.has(String(series.series_id)));
      setSeriesList(list);
      setMergeSeriesId((prev) => list.some(item => String(item.series_id) === prev) ? prev : (list[0] ? String(list[0].series_id) : ''));
    } catch (_) {}
  }, []);

  // 列表刷新改选另一部剧时，旧确认框不能继续提交。
  useEffect(() => {
    mergeDialogGenerationRef.current += 1;
    setMergeAsk(false);
    setMergeError('');
    setMergeDeleteSources(false);
  }, [mergeSeriesId]);

  const loadMergeTasks = useCallback(async () => {
    const request = ++requests.current.merges;
    try {
      const list = (await window.electronAPI.getMergeTasks()) || [];
      if (activeRef.current && request === requests.current.merges) setMergeTasks(list);
    } catch (_) {}
  }, []);

  const showToast = useCallback((text, type = 'success') => {
    setToast({ text, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    loadQueue();
    loadSeriesList();
    loadMergeTasks();
    const patches = new Map();
    let batchTimer = null, fullRefresh = false, reorder = false, seriesDirty = false, queueDirty = false;
    const schedule = () => {
      if (batchTimer !== null) return;
      batchTimer = setTimeout(() => {
        batchTimer = null;
        if (fullRefresh) refresh();
        else if (patches.size) {
          const updates = new Map(patches);
          setTasks(previous => previous.map(task => updates.has(task.id) ? { ...task, ...updates.get(task.id) } : task));
          if (reorder) setOrderVersion(value => value + 1);
        }
        if (seriesDirty) loadSeriesList(false);
        if (queueDirty) loadQueue();
        patches.clear();
        fullRefresh = reorder = seriesDirty = queueDirty = false;
      }, 200);
    };
    const patchTask = (data, status, affectsOrder = false) => {
      if (!data?.id) return;
      patches.set(data.id, { ...patches.get(data.id), ...data, status });
      reorder ||= affectsOrder || taskIndex.current.get(data.id)?.status !== status;
      schedule();
    };
    const cleanups = [
      window.electronAPI.onDownloadProgress((data) => {
        patchTask(data, 'downloading');
      }),
      window.electronAPI.onDownloadTaskAdded(() => { fullRefresh = seriesDirty = true; schedule(); }),
      window.electronAPI.onDownloadCompleted((data) => {
        const sid = data?.hongguoInfo?.series_id ?? taskIndex.current.get(data?.id)?.hongguoInfo?.series_id;
        if (sid) downloadedSeries.current.add(String(sid));
        seriesDirty = true;
        patchTask({ ...data, progress: 100 }, 'completed', true);
      }),
      window.electronAPI.onDownloadFailed((data) => {
        patchTask(data, 'failed', true);
      }),
      window.electronAPI.onDownloadStopped((data) => {
        patchTask(data, 'stopped', true);
      }),
      window.electronAPI.onDownloadQueueChanged(() => {
        fullRefresh = queueDirty = seriesDirty = true;
        schedule();
      }),
      window.electronAPI.onMergeTaskAdded(() => loadMergeTasks()),
      window.electronAPI.onMergeProgress((data) => {
        setMergeTasks((prev) =>
          prev.map((t) => (t.id === data.id ? { ...t, ...data } : t))
        );
      }),
      window.electronAPI.onMergeCompleted((data) => {
        loadMergeTasks();
        if (data.cleanedCount || data.cleanupWarning) {
          refresh();
          loadSeriesList();
        }
        const name = data.path ? data.path.split(/[\\/]/).pop() : '';
        const warning = [data.cleanupWarning && `分集删除未完全成功：${data.cleanupWarning}`, data.storageWarning]
          .filter(Boolean).join('；');
        if (warning) showToast(`合并完成，但${warning}`, 'error');
        else if (data.cleanedCount) showToast(`合并完成，已删除 ${data.cleanedCount} 个分集文件`, 'success');
        else showToast('合并完成：' + name, 'success');
      }),
      window.electronAPI.onMergeFailed((data) => {
        loadMergeTasks();
        showToast('合并失败：' + (data.error || '未知错误'), 'error');
      }),
    ];
    const timer = setInterval(() => {
      loadQueue();
      refresh();
      loadMergeTasks();
    }, 15000);
    return () => {
      cleanups.forEach(cleanup => cleanup());
      clearInterval(timer);
      clearTimeout(batchTimer);
      for (const key of Object.keys(requests.current)) requests.current[key]++;
    };
  }, [active, refresh, loadQueue, loadSeriesList, loadMergeTasks, showToast]);

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const clearSelection = () => setSelected(new Set());

  const fmtSize = (b) => {
    if (!b || b <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
  };

  /** 弹删除确认：默认只删记录，可勾选同时删除本地文件 */
  const askDelete = (list, label) => {
    const items = (list || []).filter(Boolean);
    if (!items.length) return;
    // 用已下载字节数估算可释放空间（完成任务才有意义）
    const estBytes = items.reduce((s, t) => s + (t.totalBytes || t.receivedBytes || 0), 0);
    const withFile = items.filter((t) => t.status === 'completed').length;
    setConfirmAsk({
      title: label,
      count: items.length,
      withFile,
      estBytes,
      onOk: async (deleteFiles) => {
        try {
          const ids = items.map((t) => t.id);
          const res = await window.electronAPI.deleteTasksWithFiles(ids, deleteFiles);
          await Promise.all([refresh(), loadSeriesList()]);
          if (!res?.success) {
            const progress = Number.isFinite(res?.count) && Number.isFinite(res?.freed)
              ? `已移除 ${res.count} 个任务记录，已释放 ${fmtSize(res.freed)}；` : '';
            throw new Error(progress + (res?.error || '删除失败，请重试'));
          }
          showToast(deleteFiles
            ? `已删除 ${res.count} 个任务，释放 ${fmtSize(res.freed)}`
            : `已删除 ${res.count} 个任务记录（本地文件已保留）`);
        } catch (error) { showToast(error.message || '删除失败，请重试', 'error'); }
      },
    });
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    askDelete(tasks.filter((t) => selected.has(t.id)), '删除选中任务');
  };
  const retrySelected = async () => {
    if (selected.size === 0) return;
    const res = await window.electronAPI.retryTasks(Array.from(selected));
    setSelected(new Set());
    await refresh();
    if (res && res.success) {
      showToast(res.count > 0 ? `已重新加入队列：${res.count} 项` : '选中项中没有可重试的任务');
    } else {
      showToast((res && res.error) || '重试失败', 'error');
    }
  };

  // 一键合并选中的短剧
  const openMergeDialog = () => {
    mergeDialogGenerationRef.current += 1;
    setMergeError('');
    setMergeDeleteSources(false);
    setMergeAsk(true);
  };

  const closeMergeDialog = (force = false) => {
    if (merging && !force) return;
    mergeDialogGenerationRef.current += 1;
    setMergeError('');
    setMergeDeleteSources(false);
    setMergeAsk(false);
  };

  const doMerge = async (compatible, require1080 = false) => {
    if (mergeRequestRef.current) return;
    if (!mergeSeriesId) {
      showToast('请先选择要合并的短剧', 'error');
      return;
    }
    mergeRequestRef.current = true;
    const dialogGeneration = mergeDialogGenerationRef.current;
    setMerging(true);
    setMergeError('');
    try {
      const options = { compatible, ...(require1080 ? { require1080: true } : {}), ...(mergeDeleteSources ? { deleteSources: true } : {}) };
      const res = await window.electronAPI.mergeSeries(mergeSeriesId, '', options);
      if (dialogGeneration !== mergeDialogGenerationRef.current) return;
      if (!res || !res.success) {
        setMergeError((res && res.error) || '合并失败');
        return;
      }
      closeMergeDialog(true);
      await loadMergeTasks();
      const sizeGb = (res.totalBytes / 1073741824).toFixed(2);
      const duration = res.totalDuration > 0 ? ` / ${fmtElapsed(res.totalDuration)}` : ' / 时长待探测';
      showToast((compatible
        ? `开始兼容格式合并 ${res.count} 集（H.264，耗时较长）`
        : require1080
        ? `开始高质量分辨率合并 ${res.count} 集`
        : `开始合并 ${res.count} 集（约 ${sizeGb} GB${duration}）`)
        + (mergeDeleteSources ? '；成功后删除已合并分集' : ''));
      if (res.codecWarning) showToast(res.codecWarning, 'error');
    } catch (e) {
      if (dialogGeneration === mergeDialogGenerationRef.current) setMergeError('合并异常: ' + e.message);
    } finally {
      mergeRequestRef.current = false;
      setMerging(false);
    }
  };

  const cancelMerge = async (id) => {
    try {
      const result = await window.electronAPI.cancelMerge(id);
      if (!result?.success) throw new Error(result?.error || '取消请求失败，请重试');
      showToast('取消请求已发送，正在等待合并停止。');
      await loadMergeTasks();
    } catch (error) { showToast(error.message || '取消请求失败，请重试', 'error'); }
  };

  const openMergedFile = async (path) => {
    if (!path) return;
    try {
      const result = await window.electronAPI.showInFolder(path);
      if (!result?.success) throw new Error(result?.error || '无法打开文件夹');
    } catch (error) { showToast(error.message || '无法打开文件夹', 'error'); }
  };

  const openTaskFolder = async (id) => {
    try {
      const result = await window.electronAPI.openFolder(id);
      if (!result?.success) throw new Error(result?.error || '无法打开文件夹');
    } catch (error) { showToast(error.message || '无法打开文件夹', 'error'); }
  };

  // 一键暂停：取消进行中的 + 清空等待队列
  const pauseAll = async () => {
    try {
      const res = await window.electronAPI.pauseAll();
      await refresh();
      await loadQueue();
      showToast(res?.success ? `已暂停 ${res.count} 个任务` : (res?.error || '暂停失败'), res?.success ? 'success' : 'error');
    } catch (error) { showToast(error.message || '暂停失败', 'error'); }
  };

  // 一键启动：把所有已停止/失败/等待中的任务重新排队开跑
  const resumeAll = async () => {
    try {
      const res = await window.electronAPI.resumeAll();
      await refresh();
      await loadQueue();
      showToast(res?.success ? `已启动 ${res.count} 个任务` : (res?.error || '启动失败'), res?.success ? 'success' : 'error');
    } catch (error) { showToast(error.message || '启动失败', 'error'); }
  };

  // 重试失败/已停止的任务
  const retryAllFailed = async () => {
    const ids = scopedTasks.filter(needsManualRetry).map((t) => t.id);
    if (ids.length === 0) return;
    const res = await window.electronAPI.retryTasks(ids);
    await refresh();
    if (res && res.success) {
      showToast(`已重新加入队列：${res.count} 项`);
    } else {
      showToast((res && res.error) || '重试失败', 'error');
    }
  };

  // 一键选中全部失败/已停止的任务（选中后可再点「重试选中」）
  const selectAllFailed = () => {
    const ids = scopedTasks.filter(needsManualRetry).map((t) => t.id);
    if (ids.length === 0) {
      showToast('没有失败或已停止的任务');
      return;
    }
    setSelected(new Set(ids));
    showToast(`已选中 ${ids.length} 项，可点「重试选中」重新下载`);
  };

  const clearCompleted = async () => {
    const done = scopedTasks.filter((t) => t.status === 'completed');
    if (done.length === 0) return;
    askDelete(done, '清空已完成任务');
  };

  const closeSeriesModal = useCallback(() => {
    seriesDetailReqRef.current += 1;
    setSeriesModalKey(null);
    setSeriesDetail(null);
    setSeriesDetailLoading(false);
  }, []);

  const loadSeriesDetail = useCallback(async (seriesId, key) => {
    if (!seriesId || typeof window.electronAPI?.getSeriesEpisodes !== 'function') {
      setSeriesDetail(null);
      setSeriesDetailLoading(false);
      return;
    }
    const request = ++seriesDetailReqRef.current;
    setSeriesDetailLoading(true);
    try {
      const res = await window.electronAPI.getSeriesEpisodes(seriesId);
      if (!activeRef.current || request !== seriesDetailReqRef.current) return;
      if (res?.success && Array.isArray(res.data?.episodes)) {
        setSeriesDetail({
          key,
          seriesId: String(seriesId),
          cover: res.data.cover || '',
          total: res.data.total || res.data.episodes.length,
          episodes: res.data.episodes,
        });
      } else {
        setSeriesDetail(null);
      }
    } catch {
      if (activeRef.current && request === seriesDetailReqRef.current) setSeriesDetail(null);
    } finally {
      if (activeRef.current && request === seriesDetailReqRef.current) setSeriesDetailLoading(false);
    }
  }, []);

  const openSeriesModal = useCallback((group) => {
    if (!group) return;
    setSeriesModalKey(group.key);
    setSeriesModalFilter('all');
    setSeriesModalPage(1);
    setSeriesDetail(null);
    if (group.seriesId) void loadSeriesDetail(group.seriesId, group.key);
  }, [loadSeriesDetail]);

  const openStatusModal = useCallback((status) => {
    setStatusModal(status);
    setStatusModalPage(1);
  }, []);

  const downloadMissingEpisode = async (seriesId, vidIndex) => {
    if (!seriesId || typeof window.electronAPI?.downloadSingleEpisode !== 'function') return;
    const epKey = `${seriesId}:${vidIndex}`;
    setDownloadingEpisodes(prev => new Set(prev).add(epKey));
    try {
      const res = await window.electronAPI.downloadSingleEpisode(seriesId, vidIndex);
      if (!res?.success) throw new Error(res?.error || '加入下载失败');
      await refresh();
      showToast(res.count > 0 ? `第 ${vidIndex} 集已加入下载队列` : `第 ${vidIndex} 集已在队列中`);
    } catch (error) {
      showToast(error.message || '加入下载失败', 'error');
    } finally {
      setDownloadingEpisodes(prev => {
        const next = new Set(prev);
        next.delete(epKey);
        return next;
      });
    }
  };

  const downloadAllMissing = async (group, missingEpisodes) => {
    if (!group?.seriesId || !missingEpisodes.length) return;
    const batchKey = `${group.seriesId}:all`;
    setDownloadingEpisodes(prev => new Set(prev).add(batchKey));
    try {
      const res = await window.electronAPI.hongguoDownloadBatch({
        seriesId: group.seriesId,
        seriesTitle: group.title,
        episodes: missingEpisodes.map(ep => ({ vid: ep.vid, vid_index: ep.vid_index, title: ep.title })),
      });
      if (!res?.success) throw new Error(res?.error || '提交下载失败');
      await refresh();
      showToast(res.count > 0 ? `已将 ${res.count} 集加入下载队列` : '所选集数已在下载队列中');
    } catch (error) {
      showToast(error.message || '提交下载失败', 'error');
    } finally {
      setDownloadingEpisodes(prev => {
        const next = new Set(prev);
        next.delete(batchKey);
        return next;
      });
    }
  };

  const toggleGroupSelect = (groupTasks) => {
    const ids = groupTasks.map(task => task.id);
    const allGroupSelected = ids.length > 0 && ids.every(id => selected.has(id));
    setSelected(previous => {
      const next = new Set(previous);
      for (const id of ids) {
        if (allGroupSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  // Progress updates change row values, not the established series/episode order.
  const sortedIds = useMemo(() => sortTasks(tasks).map(task => task.id), [orderVersion]);
  const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  taskIndex.current = taskById;
  const seriesOptions = useMemo(() => {
    const groups = new Map();
    for (const task of tasks) {
      const key = seriesKey(task);
      const group = groups.get(key) || { key, label:seriesLabel(task), count:0, waiting:0, failed:0 };
      group.count++;
      if (isWaitingRetry(task)) group.waiting++;
      if (needsManualRetry(task)) group.failed++;
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) =>
      a.label.localeCompare(b.label, 'zh-CN', { numeric:true }));
  }, [tasks]);
  const activeFilter = seriesOptions.some(option => option.key === seriesFilter) ? seriesFilter : '';
  const scopedTasks = useMemo(() => activeFilter
    ? tasks.filter(task => seriesKey(task) === activeFilter) : tasks, [tasks, activeFilter]);
  const scopedIds = useMemo(() => activeFilter
    ? sortedIds.filter(id => seriesKey(taskById.get(id)) === activeFilter) : sortedIds,
  [sortedIds, taskById, activeFilter]);
  const seriesGroups = useMemo(() => {
    const groups = new Map();
    for (const id of scopedIds) {
      const task = taskById.get(id);
      if (!task) continue;
      const key = seriesKey(task);
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          seriesId: task.hongguoInfo?.series_id != null ? String(task.hongguoInfo.series_id) : null,
          title: seriesLabel(task),
          cover: '',
          tasks: [],
          completed: 0,
          downloading: 0,
          pending: 0,
          retrying: 0,
          failed: 0,
          stopped: 0,
          receivedBytes: 0,
          totalBytes: 0,
          activeProgressSum: 0,
          firstCompletedId: null,
        };
        groups.set(key, group);
      }
      group.tasks.push(task);
      if (!group.cover && task.videoInfo?.cover) group.cover = task.videoInfo.cover;
      if (task.status === 'completed') {
        group.completed++;
        if (!group.firstCompletedId) group.firstCompletedId = task.id;
      } else if (task.status === 'downloading') {
        group.downloading++;
        group.activeProgressSum += Number(task.progress) || 0;
      } else if (task.status === 'pending') group.pending++;
      else if (isWaitingRetry(task)) group.retrying++;
      else if (task.status === 'failed') group.failed++;
      else if (task.status === 'stopped') group.stopped++;
      group.receivedBytes += Number(task.receivedBytes) || 0;
      group.totalBytes += Number(task.totalBytes) || 0;
    }
    return [...groups.values()];
  }, [scopedIds, taskById]);
  const allSelected = scopedTasks.length > 0 && scopedTasks.every(task => selected.has(task.id));
  const selectAll = () => setSelected(new Set(scopedTasks.map(task => task.id)));
  const pageCount = Math.max(1, Math.ceil(mobile ? scopedIds.length / PAGE_SIZE : seriesGroups.length / SERIES_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleGroups = seriesGroups.slice((currentPage - 1) * SERIES_PAGE_SIZE, currentPage * SERIES_PAGE_SIZE);

  const activeCount = scopedTasks.filter((t) => t.status === 'downloading' || t.status === 'pending').length;
  const completedCount = scopedTasks.filter((t) => t.status === 'completed').length;
  const retryingCount = scopedTasks.filter(isWaitingRetry).length;
  const failedTasks = useMemo(
    () => scopedTasks.filter(needsManualRetry),
    [scopedTasks]
  );
  const failedCount = failedTasks.length;

  const statusModalTasks = useMemo(() => {
    if (!statusModal) return [];
    const list = scopedIds.map(id => taskById.get(id)).filter(Boolean);
    if (statusModal === 'active') return list.filter(t => t.status === 'downloading' || t.status === 'pending');
    if (statusModal === 'retry') return list.filter(isWaitingRetry);
    if (statusModal === 'done') return list.filter(t => t.status === 'completed');
    if (statusModal === 'fail') return list.filter(needsManualRetry);
    return [];
  }, [statusModal, scopedIds, taskById]);
  const statusModalPageCount = Math.max(1, Math.ceil(statusModalTasks.length / PAGE_SIZE));
  const currentStatusPage = Math.min(statusModalPage, statusModalPageCount);
  const visibleStatusTasks = statusModalTasks.slice((currentStatusPage - 1) * PAGE_SIZE, currentStatusPage * PAGE_SIZE);

  const activeSeriesGroup = useMemo(
    () => (seriesModalKey ? seriesGroups.find(group => group.key === seriesModalKey) || null : null),
    [seriesModalKey, seriesGroups]
  );
  const seriesModalEpisodes = useMemo(() => {
    if (!activeSeriesGroup) return [];
    const taskByIndex = new Map();
    const extraTasks = [];
    for (const task of activeSeriesGroup.tasks) {
      const idx = Number(task.hongguoInfo?.vid_index);
      if (Number.isFinite(idx) && idx > 0 && !taskByIndex.has(idx)) taskByIndex.set(idx, task);
      else extraTasks.push(task);
    }
    const items = [];
    const remoteEpisodes = seriesDetail?.key === activeSeriesGroup.key ? seriesDetail.episodes : null;
    if (Array.isArray(remoteEpisodes) && remoteEpisodes.length > 0) {
      const seenIndices = new Set();
      for (const ep of remoteEpisodes) {
        const idx = Number(ep.vid_index);
        seenIndices.add(idx);
        const liveTask = taskByIndex.get(idx) || null;
        let effectiveStatus = 'missing';
        if (liveTask) {
          effectiveStatus = isWaitingRetry(liveTask) ? 'retrying' : liveTask.status;
        } else if (ep.status === 'completed') {
          effectiveStatus = 'completed';
        } else if (ep.locked) {
          effectiveStatus = 'locked';
        }
        items.push({
          key: liveTask ? liveTask.id : `ep-${idx}`,
          vid_index: idx,
          vid: ep.vid,
          title: ep.title ? `第 ${idx} 集 · ${ep.title}` : `第 ${idx} 集`,
          effectiveStatus,
          task: liveTask,
          locked: ep.locked === true,
          fileSize: liveTask ? (liveTask.totalBytes || liveTask.receivedBytes || 0) : (ep.fileSize || 0),
          progress: liveTask ? (liveTask.progress || 0) : (ep.progress || 0),
          error: liveTask?.error || ep.error || '',
        });
      }
      for (const [idx, task] of taskByIndex.entries()) {
        if (!seenIndices.has(idx)) extraTasks.push(task);
      }
    } else {
      for (const task of activeSeriesGroup.tasks) {
        const idx = Number(task.hongguoInfo?.vid_index) || 0;
        items.push({
          key: task.id,
          vid_index: idx,
          vid: task.hongguoInfo?.vid,
          title: task.title || task.filename || `第 ${idx} 集`,
          effectiveStatus: isWaitingRetry(task) ? 'retrying' : task.status,
          task,
          locked: false,
          fileSize: task.totalBytes || task.receivedBytes || 0,
          progress: task.progress || 0,
          error: task.error || '',
        });
      }
      return items;
    }
    for (const task of extraTasks) {
      items.push({
        key: task.id,
        vid_index: Number(task.hongguoInfo?.vid_index) || 0,
        vid: task.hongguoInfo?.vid,
        title: task.title || task.filename,
        effectiveStatus: isWaitingRetry(task) ? 'retrying' : task.status,
        task,
        locked: false,
        fileSize: task.totalBytes || task.receivedBytes || 0,
        progress: task.progress || 0,
        error: task.error || '',
      });
    }
    return items.sort((a, b) => (a.vid_index || 0) - (b.vid_index || 0));
  }, [activeSeriesGroup, seriesDetail]);

  const seriesModalCounts = useMemo(() => {
    const counts = { all: seriesModalEpisodes.length, completed: 0, downloading: 0, pending: 0, missing: 0, retrying: 0, fail: 0 };
    for (const item of seriesModalEpisodes) {
      if (item.effectiveStatus === 'completed') counts.completed++;
      else if (item.effectiveStatus === 'downloading') counts.downloading++;
      else if (item.effectiveStatus === 'pending') counts.pending++;
      else if (item.effectiveStatus === 'missing') counts.missing++;
      else if (item.effectiveStatus === 'retrying') counts.retrying++;
      else if (item.effectiveStatus === 'failed' || item.effectiveStatus === 'stopped') counts.fail++;
    }
    return counts;
  }, [seriesModalEpisodes]);

  const filteredSeriesEpisodes = useMemo(() => {
    if (seriesModalFilter === 'all') return seriesModalEpisodes;
    if (seriesModalFilter === 'fail') return seriesModalEpisodes.filter(item => item.effectiveStatus === 'failed' || item.effectiveStatus === 'stopped');
    return seriesModalEpisodes.filter(item => item.effectiveStatus === seriesModalFilter);
  }, [seriesModalEpisodes, seriesModalFilter]);
  const seriesModalPageCount = Math.max(1, Math.ceil(filteredSeriesEpisodes.length / PAGE_SIZE));
  const currentSeriesModalPage = Math.min(seriesModalPage, seriesModalPageCount);
  const visibleSeriesEpisodes = filteredSeriesEpisodes.slice((currentSeriesModalPage - 1) * PAGE_SIZE, currentSeriesModalPage * PAGE_SIZE);
  const missingUnlockedEpisodes = useMemo(
    () => seriesModalEpisodes.filter(item => item.effectiveStatus === 'missing' && !item.locked),
    [seriesModalEpisodes]
  );

  // 与主进程 pauseAllTasks 一致；按钮始终控制所有剧，不受当前筛选影响。
  const pausableCount = useMemo(
    () => tasks.filter((t) => ['pending', 'downloading'].includes(t.status) || t.status === 'failed' && t.retryAt).length,
    [tasks]
  );

  // 已选中项里真正可重试的数量
  const retryableSelectedCount = useMemo(
    () =>
      Array.from(selected).filter((id) => {
        const t = taskById.get(id);
        return t && (t.status === 'failed' || t.status === 'stopped');
      }).length,
    [selected, taskById]
  );

  const dialogSelector = confirmAsk ? '[data-dm-dialog="delete"]' : mergeAsk ? '[data-dm-dialog="merge"]'
    : statusModal ? '.dm-status-modal' : '.dm-series-modal';
  useDialogKeyboard(active && !!(confirmAsk || mergeAsk || statusModal || activeSeriesGroup), () => {
    if (confirmAsk) { setConfirmAsk(null); return; }
    if (mergeAsk) { closeMergeDialog(); return; }
    if (statusModal) { setStatusModal(null); return; }
    if (seriesModalKey) closeSeriesModal();
  }, `.dm-container ${dialogSelector}`);

  const renderTaskRow = (task, { showCover = true, selectable = false, episodeTitle = '' } = {}) => {
    const isSel = selected.has(task.id);
    const waitingRetry = isWaitingRetry(task);
    const canStop = task.status === 'downloading' || task.status === 'pending' || waitingRetry;
    const canRetry = task.status === 'failed' || task.status === 'stopped';
    const pct = task.progress || 0;
    const statusKey = waitingRetry ? 'pending' : task.status;
    const statusLabel = waitingRetry ? '等待重试' : (task.status === 'completed' && !showCover ? '已下载' : STATUS_TEXT[task.status] || task.status);
    return (
      <div
        key={task.id}
        className={`dm-task ${isSel ? 'selected' : ''}`}
        onClick={selectable ? () => toggleSelect(task.id) : undefined}
      >
        {selectable && (
          <input
            className="dm-task-select"
            type="checkbox"
            aria-label={t(`选择 ${episodeTitle || task.title || task.filename}`)}
            checked={isSel}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleSelect(task.id)}
          />
        )}
        {showCover && (
          <div className="dm-task-cover">
            {task.videoInfo && task.videoInfo.cover ? (
              <img src={task.videoInfo.cover} alt="" />
            ) : (
              <div className="cover-placeholder"><Film size={18} /></div>
            )}
          </div>
        )}
        <div className="dm-task-body">
          <div className="dm-task-title">{episodeTitle || task.title || task.filename}</div>
          <div className="dm-task-meta">
            <span className={`status-tag status-${statusKey}`}>{t(statusLabel)}</span>
            {waitingRetry && <span className="dm-size">{t("自动重试 ")}{t(task.sourceRetries)}/{t(task.sourceRetryLimit || 3)} · {t(new Date(task.retryAt).toLocaleTimeString(getLanguage(), { hour12: false }))}{t(" 后排队")}</span>}
            {task.status === 'downloading' && task.totalBytes > 0 && (
              <span className="dm-size">{t(fmtBytes(task.receivedBytes))} / {t(fmtBytes(task.totalBytes))}</span>
            )}
            {task.status === 'completed' && (task.totalBytes || task.receivedBytes) > 0 && (
              <span className="dm-size">{t(fmtBytes(task.totalBytes || task.receivedBytes))}</span>
            )}
            {['failed', 'stopped'].includes(task.status) && task.error && <span className="dm-error">{t(task.error)}</span>}
          </div>
          {['downloading', 'completed'].includes(task.status) && task.qualityNotice && <div className="dm-quality-notice">{t(task.qualityNotice)}</div>}
          {task.nasWarning && <div className="dm-error">{t(task.nasWarning)}</div>}
          {task.metadataWarning && <div className="dm-error">{t(task.metadataWarning)}</div>}
          {(task.status === 'downloading' || task.status === 'pending') && (
            <div className="dm-progress">
              <div className="dm-progress-bar">
                <div className="dm-progress-fill" style={{ width: pct + '%' }}></div>
              </div>
              <span className="dm-pct">{t(pct)}%</span>
            </div>
          )}
        </div>
        <div className="dm-task-actions" onClick={(e) => e.stopPropagation()}>
          {canStop && (
            <button className="icon-btn" title={t(waitingRetry ? '停止自动重试' : '停止')} onClick={async () => {
              try {
                const result = await window.electronAPI.stopDownload(task.id);
                if (!result?.success) throw new Error(result?.error || '停止失败');
                await refresh();
              } catch (error) { showToast(error.message || '停止失败', 'error'); }
            }}>
              <Square size={16} />
            </button>
          )}
          {canRetry && (
            <button className="icon-btn" title={t(waitingRetry ? '手动重试（共享冷却可能延后开始）' : '重试')} onClick={async () => {
              try {
                const result = await window.electronAPI.retryTask(task.id);
                if (!result?.success) throw new Error(result?.error || '重试失败');
              } catch (error) { showToast(error.message || '重试失败', 'error'); }
            }}>
              <RefreshCw size={16} />
            </button>
          )}
          <button className="icon-btn" title={t("打开文件夹")} onClick={() => openTaskFolder(task.id)}>
            <Folder size={16} />
          </button>
          <button
            className="icon-btn icon-btn-danger"
            title={t("删除任务（可选是否同时删除本地文件）")}
            onClick={() => {
              askDelete([task], `删除《${task.hongguoInfo && task.hongguoInfo.series_title ? task.hongguoInfo.series_title : ''}》第 ${task.hongguoInfo ? task.hongguoInfo.vid_index : ''} 集任务`);
            }}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    );
  };

  const MoreActions = mobile ? 'details' : 'div';
  const StatusPill = mobile ? 'span' : 'button';
  const statusCounts = [
    ['active', '进行中', activeCount, Download],
    ['done', '已完成', completedCount, Check],
    ['fail', '失败/停止', failedCount, AlertCircle],
  ];
  if (retryingCount > 0) statusCounts.splice(1, 0, ['retry', '等待重试', retryingCount, Clock]);

  return (
    <div className="dm-container">
      <div className="dm-header">
        <div className="dm-title duplicate-page-title">
          <h2>{t("下载管理")}</h2>
        </div>
        <div className="dm-stats">
          {statusCounts.map(([status, label, count, Icon]) =>
            <StatusPill
              type={mobile ? undefined : 'button'}
              className={`dm-stat dm-stat-${status}`}
              data-empty={count === 0}
              key={status}
              onClick={mobile ? undefined : () => openStatusModal(status)}
              title={mobile ? undefined : t(`查看${label}任务列表`)}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{t(label)}{' '}</span><strong>{t(count)}</strong>
            </StatusPill>)}
        </div>
        {!mobile && <button type="button" className="btn btn-outline btn-sm" popovertarget="dm-usage-notice">
          <AlertCircle size={15} />{t("下载说明")}
        </button>}
      </div>

      <div id="dm-usage-notice" className={`dm-usage-notice${mobile ? '' : ' desktop-popover'}`}
        ref={usageNoticeRef} popover={mobile ? undefined : 'auto'} role={mobile ? 'note' : 'dialog'}
        aria-label={t(mobile ? "下载风险与使用倡议" : "下载说明")}>
        {!mobile && <header className="dm-usage-heading">
          <strong>{t("下载说明")}</strong>
          <button type="button" className="icon-btn" popovertarget="dm-usage-notice" popovertargetaction="hide" aria-label={t("关闭")}>
            <X size={16} />
          </button>
        </header>}
        <p><strong>{t("临时故障会自动重试。")}</strong>{t("红果片源下载遇到断网、超时或传输不完整时，普通故障最多追加 3 次重试，分别等待 10、30、60 秒；注册拒绝或空响应最多追加 6 轮重试，分别等待 15、30、60、120、300、600 秒；来源暂不可用时等待 3、8、15 分钟。等待期间可停止或手动重试，但共享冷却可能让手动重试延后开始。权限限制、磁盘错误等需手动处理；重试后仍失败的任务会保留。")}</p>
        <p>{t("本软件用于学习研究，建议体验后 24 小时内自行删除；请勿冒充官方或以虚假授权名义收费。开源权利义务以 GPLv3 为准。上述倡议不代表获得平台或版权方授权，也不构成免责承诺。")}</p>
      </div>

      <div className="dm-toolbar">
        <button
          className="btn btn-primary"
          onClick={resumeAll}
          disabled={!tasks.some(task => ['stopped', 'failed', 'pending'].includes(task.status))}
          title={t("全部开始：把所有剧中等待中 / 已停止 / 失败的任务排队开跑")}
        >
          <Play size={15} />{t("全部开始")}</button>
        <button
          className="btn btn-outline"
          onClick={pauseAll}
          disabled={pausableCount === 0}
          title={t("全部暂停：暂停所有剧中正在下载、等待中及等待自动重试的任务")}
        >
          <Pause size={15} />{t("全部暂停")}</button>
        <button
          className="btn btn-outline"
          onClick={retryAllFailed}
          disabled={failedCount === 0}
          title={t("把所有失败/已停止的任务一次性重新加入下载队列")}
        >
          <Zap size={15} />
          {t(failedCount > 0 ? `重试失败 (${failedCount})` : '重试失败')}
        </button>
        <MoreActions className="dm-more-actions" ref={mobile ? moreActionsRef : undefined}>
          {mobile ? <summary>{t("更多操作")}</summary> : <button type="button" className="btn btn-outline" popovertarget="dm-more-menu">{t("更多操作")}<ChevronDown size={15} /></button>}
          <div className={`dm-more-menu${mobile ? '' : ' desktop-popover'}`} id="dm-more-menu" popover={mobile ? undefined : 'auto'}
            ref={!mobile ? moreActionsRef : undefined} onClick={event => {
              const button = event.target.closest('button');
              if (!button || button.disabled) return;
              if (mobile) moreActionsRef.current.open = false;
              else moreActionsRef.current.hidePopover?.();
            }}>
        <button
          className="btn btn-outline"
          onClick={selectAllFailed}
          disabled={failedCount === 0}
          title={t("一键勾选所有失败/已停止的任务")}
        >
          <CheckSquare size={15} />
          {t(failedCount > 0 ? `选中失败项 (${failedCount})` : '选中失败项')}
        </button>
        <button className="btn btn-outline" onClick={retrySelected} disabled={retryableSelectedCount === 0}>
          <RefreshCw size={15} />{t("重试选中 (")}{t(retryableSelectedCount)})
        </button>
        <button className="btn btn-outline" onClick={clearCompleted} disabled={completedCount === 0}>
          <X size={15} />{t("清空已完成")}</button>
        <button className="btn btn-outline" onClick={clearSelection} disabled={selected.size === 0}>{t("取消选择")}</button>
        <button
          className="btn btn-outline"
          onClick={async () => {
            const r = await window.electronAPI.rescanDownloads();
            await refresh();
            await loadSeriesList();
            showToast(r && r.success
              ? (r.count > 0 ? `已从磁盘补回 ${r.count} 条下载记录` : '没有发现未登记的文件')
              : '扫描失败');
          }}
          title={t("扫描下载目录，把磁盘上已有但列表里没有的文件补登记回来")}
        >
          <RefreshCw size={15} />{t("扫描下载目录")}</button>
        </div></MoreActions>
        {seriesList.length > 0 && (
          <div className="merge-inline">
            <select
              className="input-field merge-select"
              value={mergeSeriesId}
              onFocus={() => loadSeriesList()}
              onChange={(e) => setMergeSeriesId(e.target.value)}
              title={t("选择要合并的短剧")}
            >
              {seriesList.map((s) => (
                <option key={s.series_id} value={String(s.series_id)}>
                  {s.series_title}
                </option>
              ))}
            </select>
            <button className="btn btn-outline" onClick={openMergeDialog} disabled={merging} title={t("把该剧已下载的分集合并成单个 mp4")}>
              <Layers size={15} />
              {t(merging ? '合并中...' : '合并整部剧')}
            </button>
          </div>
        )}
        {onNavigate && (
          <button className="btn btn-primary dm-toolbar-end" onClick={() => onNavigate('download')}>
            <Film size={15} />{t("添加下载")}</button>
        )}
      </div>

      {seriesList.length > 0 && <p className="settings-hint dm-merge-hint">{t("选择剧名后点“合并整部剧”，导出该剧全部已下载分集，无需勾选任务。")}</p>}

      {/* 合并任务 */}
      {mergeTasks.length > 0 && (
        <div className="merge-list">
          {mergeTasks.map((m) => (
            <div key={m.id} className={`merge-card merge-${m.status}`}>
              <Layers size={16} />
              <div className="merge-body">
                <div className="merge-title">{t("合并《")}{m.seriesTitle}》· {m.done || 0}/{t(m.total)}{t(" 集")}</div>
                <div className="merge-sub">
                  {m.status === 'running' && <>{t(m.stageText || '正在合并')}{t(m.method && m.method !== m.stageText ? ` · ${m.method}` : '')}</>}
                  {m.status === 'completed' && (
                    <>{t("已完成 · ")}{m.outputName}
                      {t(m.outputBytes ? ` · ${fmtBytes(m.outputBytes)}` : '')}
                    </>
                  )}
                  {m.status === 'failed' && <>{t("失败：")}{t(m.error)}</>}
                  {m.status === 'stopped' && <>{t(m.error || '已取消')}</>}
                </div>
                <div className="merge-metrics">
                  <span>{t(m.stage === 'checking' ? `已检查 ${m.checked || 0}` : `已处理 ${m.done || 0}`)} / {t(m.total)}{t(" 集")}</span>
                  <span>{t("用时 ")}{t(fmtElapsed(m.status === 'running' ? (Date.now() - m.startTime) / 1000 : m.elapsedSeconds || ((m.endTime || m.startTime) - m.startTime) / 1000))}</span>
                  {m.status === 'running' && m.speed > 0 && <span>{t(m.speed.toFixed(1))}{t(" 倍速")}</span>}
                  {m.status === 'running' && Number.isFinite(m.etaSeconds) && <span>{t("本阶段约剩 ")}{t(fmtElapsed(m.etaSeconds))}</span>}
                </div>
                {(m.codecWarning || m.storageWarning || m.cleanupWarning) && <div className="merge-note">{t(m.storageWarning || m.cleanupWarning || m.codecWarning)}</div>}
                {(m.status === 'running') && (
                  <div className="dm-progress">
                    <div className="dm-progress-bar" role="progressbar" aria-label={t("合并进度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.progress || 0}>
                      <div className="dm-progress-fill" style={{ width: `${m.progress || 0}%` }} />
                    </div>
                    <span className="dm-pct">{m.progress || 0}%</span>
                  </div>
                )}
              </div>
              <div className="merge-actions">
                {m.status === 'running' && (
                  <button className="icon-btn" title={t("取消合并")} onClick={() => cancelMerge(m.id)}>
                    <X size={16} />
                  </button>
                )}
                {m.status === 'completed' && (
                  <button className="icon-btn" title={t("打开所在文件夹")} onClick={() => openMergedFile(m.output)}>
                    <Folder size={16} />
                  </button>
                )}
                {m.status !== 'running' && (
                  <button
                    className="icon-btn icon-btn-danger"
                    title={t("移除记录")}
                    onClick={async () => {
                      try {
                        const result = await window.electronAPI.deleteMergeTask(m.id);
                        if (!result?.success) throw new Error(result?.error || '移除记录失败');
                        await loadMergeTasks();
                      } catch (error) { showToast(error.message || '移除记录失败，请重试', 'error'); }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {queue.active > 0 && (
        <div className="dm-queue-bar">
          <span className="dm-queue-running">
            <span className="dm-queue-pulse" />{t("正在并发下载 ")}<b>{t(queue.active)}</b> / {t(queue.maxConcurrent)}
            {queue.queued > 0 ? <>{t(" · 队列等待 ")}<b>{t(queue.queued)}</b></> : null}
          </span>
          <span className="dm-queue-hint">{t("并发数可在「设置 → 最大并发下载数」调整")}</span>
        </div>
      )}

      {retryableSelectedCount > 0 && (
        <div className="dm-hint">{t("已选中 ")}<b>{t(retryableSelectedCount)}</b>{t(" 个失败项，点")}<b>{t("「重试选中」")}</b>{t(" 即会重新下载（无需重新解析）。")}</div>
      )}

      {loadError && <div className="alert alert-error" role="alert">{t(loadError)}<button className="btn btn-outline btn-sm" onClick={refresh}>{t("重新加载")}</button></div>}
      {seriesOptions.length > 1 && (
        <div className="dm-series-filter">
          <label htmlFor="dm-series-select">{t("按剧集查看")}</label>
          <select id="dm-series-select" className="input-field dm-series-select" value={activeFilter}
            onChange={(event) => {
              setSeriesFilter(event.target.value);
              setSelected(new Set());
              setPage(1);
            }}
            title={t("选择一部剧后，列表、统计和批量重试只作用于该剧；不选则作用于全部")}>
            <option value="">{t("全部剧集（{0} 项）", [tasks.length])}</option>
            {seriesOptions.map(option => (
              <option key={option.key} value={option.key}>
                {option.label} · {option.count}{option.waiting ? ` · ${t('等待重试')} ${option.waiting}` : ''}{option.failed ? ` · ${t('待重试')} ${option.failed}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      {scopedTasks.length > 0 && <div className="dm-pagination">
        <div className="dm-selection-summary">
          <button className="btn btn-outline btn-sm" onClick={allSelected ? clearSelection : selectAll}
            title={activeFilter
              ? t(allSelected ? '取消当前剧的分页选择' : '选中当前剧 {0} 项，包含其他分页', [scopedTasks.length])
              : t(allSelected ? '取消所有分页中的选择' : '选中全部 {0} 项，包含其他分页', [scopedTasks.length])}>
            <CheckSquare size={15} />{t(allSelected ? '取消全选' : '全选')}
          </button>
          <button className="btn btn-outline btn-sm" onClick={deleteSelected} disabled={selected.size === 0}
            title={t("删除所有分页中已选的任务，确认时可选择是否同时删除本地文件")}>
            <Trash2 size={15} />{t("删除已选（")}{t(selected.size)}{t("项）")}</button>
        <span>{mobile ? t("共 {0} 项 · 当前 {1}-{2}", [scopedIds.length, (currentPage - 1) * PAGE_SIZE + 1, Math.min(currentPage * PAGE_SIZE, scopedIds.length)])
          : t("共 {0} 部剧 · {1} 个任务", [seriesGroups.length, scopedIds.length])}{t(selected.size > 0 ? ` · 已选 ${selected.size} 项（跨页保留）` : '')}</span>
        </div>
        {pageCount > 1 && <nav className="pagination-controls" aria-label={t(mobile ? "下载任务分页" : "下载剧集分页")}>
          <button className="btn btn-outline btn-sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{t("上一页")}</button>
          <span className="pager-status" aria-live="polite">{t("第 {0} / {1} 页", [currentPage, pageCount])}</span>
          <button className="btn btn-outline btn-sm" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>{t("下一页")}</button>
        </nav>}
      </div>}

      {scopedTasks.length === 0 ? (
        <div className="dm-empty">
          <Download size={40} />
          <p>{t("暂无下载任务")}</p>
          <p className="dm-empty-sub">{t("搜索剧名或粘贴分享链接，选择想保存的集数。")}</p>
          {onNavigate && <button className="btn btn-primary" onClick={() => onNavigate('download')}>{t("添加第一部短剧")}</button>}
        </div>
      ) : mobile ? (
        <div className="dm-list">
          {scopedIds.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map(id => taskById.get(id)).filter(Boolean)
            .map(task => renderTaskRow(task, { selectable: true }))}
        </div>
      ) : (
        <div className="dm-series-grid">
          {visibleGroups.map((group) => {
            const groupAllSelected = group.tasks.length > 0 && group.tasks.every(task => selected.has(task.id));
            const groupSelectedCount = group.tasks.filter(task => selected.has(task.id)).length;
            const groupPct = group.tasks.length
              ? Math.min(100, Math.round(((group.completed * 100) + group.activeProgressSum) / group.tasks.length))
              : 0;
            const failedInGroup = group.tasks.filter(needsManualRetry);
            const activeInGroup = group.downloading + group.pending + group.retrying;
            return (
              <article
                key={group.key}
                className={`dm-series-card ${groupAllSelected ? 'selected' : ''}`}
                onClick={() => openSeriesModal(group)}
              >
                <div className="dm-series-top">
                  <input
                    className="dm-task-select dm-series-select"
                    type="checkbox"
                    aria-label={t('选择《{0}》', [group.title])}
                    checked={groupAllSelected}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleGroupSelect(group.tasks)}
                  />
                  <div className="dm-series-cover">
                    {group.cover ? (
                      <img src={group.cover} alt="" />
                    ) : (
                      <div className="cover-placeholder"><Film size={22} /></div>
                    )}
                  </div>
                  <div className="dm-series-info">
                    <h3 className="dm-series-title" title={group.title}>{group.title}</h3>
                    <div className="dm-series-sub">
                      <span>{t("共 {0} 集任务", [group.tasks.length])}</span>
                      {group.totalBytes > 0 && <span className="dm-size"> · {t(fmtBytes(group.totalBytes))}</span>}
                      {groupSelectedCount > 0 && !groupAllSelected && <span> · {t("已选 {0}", [groupSelectedCount])}</span>}
                    </div>
                    <div className="dm-series-chips">
                      {group.completed > 0 && <span className="status-tag status-completed">{t("已下载")} {t(group.completed)}</span>}
                      {group.downloading > 0 && <span className="status-tag status-downloading">{t("下载中")} {t(group.downloading)}</span>}
                      {group.pending > 0 && <span className="status-tag status-pending">{t("等待中")} {t(group.pending)}</span>}
                      {group.retrying > 0 && <span className="status-tag status-pending">{t("等待重试")} {t(group.retrying)}</span>}
                      {(group.failed + group.stopped) > 0 && <span className="status-tag status-failed">{t("失败/停止")} {t(group.failed + group.stopped)}</span>}
                    </div>
                  </div>
                </div>
                <div className="dm-series-progress">
                  <div className="dm-progress-bar">
                    <div className="dm-progress-fill" style={{ width: `${groupPct}%` }} />
                  </div>
                  <span className="dm-pct">{t(group.completed)}/{t(group.tasks.length)}</span>
                </div>
                <div className="dm-series-foot" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => openSeriesModal(group)}>
                    {t(activeInGroup > 0 ? '查看进度与分集' : '查看各集状态')}
                  </button>
                  <div className="dm-series-actions">
                    {failedInGroup.length > 0 && (
                      <button
                        type="button"
                        className="icon-btn"
                        title={t("重试本剧失败项")}
                        onClick={async () => {
                          try {
                            const res = await window.electronAPI.retryTasks(failedInGroup.map(item => item.id));
                            await refresh();
                            if (!res?.success) throw new Error(res?.error || '重试失败');
                            showToast(`已重新加入队列：${res.count} 项`);
                          } catch (error) { showToast(error.message || '重试失败', 'error'); }
                        }}
                      >
                        <RefreshCw size={16} />
                      </button>
                    )}
                    {group.firstCompletedId && (
                      <button type="button" className="icon-btn" title={t("打开文件夹")} onClick={() => openTaskFolder(group.firstCompletedId)}>
                        <Folder size={16} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-btn icon-btn-danger"
                      title={t("删除本剧全部任务")}
                      onClick={() => askDelete(group.tasks, `删除《${group.title}》全部任务`)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* 状态任务列表弹窗 */}
      {statusModal && (
        <div className="dm-modal-mask" onClick={() => setStatusModal(null)}>
          <div className="dm-modal dm-status-modal" role="dialog" aria-modal="true" aria-label={t(STATUS_MODAL_TITLES[statusModal] || '任务列表')} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="dm-modal-head">
              <div className="dm-modal-title">
                <h3>{t(STATUS_MODAL_TITLES[statusModal] || '任务列表')}</h3>
                <span className="dm-modal-count">{t(statusModalTasks.length)}</span>
              </div>
              <div className="dm-modal-head-actions">
                {statusModal === 'active' && pausableCount > 0 && (
                  <button type="button" className="btn btn-outline btn-sm" onClick={pauseAll}>
                    <Pause size={14} />{t("全部暂停")}
                  </button>
                )}
                {statusModal === 'fail' && statusModalTasks.length > 0 && (
                  <button type="button" className="btn btn-outline btn-sm" onClick={retryAllFailed}>
                    <Zap size={14} />{t("全部重试")}
                  </button>
                )}
                {statusModal === 'done' && statusModalTasks.length > 0 && (
                  <button type="button" className="btn btn-outline btn-sm" onClick={clearCompleted}>
                    <Trash2 size={14} />{t("清空已完成")}
                  </button>
                )}
                <button type="button" className="icon-btn" aria-label={t("关闭")} onClick={() => setStatusModal(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="dm-modal-body">
              {statusModalTasks.length === 0 ? (
                <div className="dm-modal-empty">{t("当前没有该状态的任务")}</div>
              ) : (
                <>
                  {statusModalPageCount > 1 && (
                    <div className="dm-modal-pager">
                      <span>{t("共 {0} 项 · 当前 {1}-{2}", [statusModalTasks.length, (currentStatusPage - 1) * PAGE_SIZE + 1, Math.min(currentStatusPage * PAGE_SIZE, statusModalTasks.length)])}</span>
                      <nav className="pagination-controls" aria-label={t("状态任务分页")}>
                        <button type="button" className="btn btn-outline btn-sm" disabled={currentStatusPage <= 1} onClick={() => setStatusModalPage(currentStatusPage - 1)}>{t("上一页")}</button>
                        <span className="pager-status">{t("第 {0} / {1} 页", [currentStatusPage, statusModalPageCount])}</span>
                        <button type="button" className="btn btn-outline btn-sm" disabled={currentStatusPage >= statusModalPageCount} onClick={() => setStatusModalPage(currentStatusPage + 1)}>{t("下一页")}</button>
                      </nav>
                    </div>
                  )}
                  <div className="dm-list dm-modal-list">
                    {visibleStatusTasks.map(task => renderTaskRow(task, { showCover: true }))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 剧集分集状态弹窗 */}
      {activeSeriesGroup && (
        <div className="dm-modal-mask" onClick={closeSeriesModal}>
          <div className="dm-modal dm-series-modal" role="dialog" aria-modal="true" aria-label={activeSeriesGroup.title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="dm-modal-head">
              <div className="dm-series-modal-header">
                <div className="dm-series-modal-cover">
                  {(seriesDetail?.key === activeSeriesGroup.key && seriesDetail.cover) || activeSeriesGroup.cover ? (
                    <img src={(seriesDetail?.key === activeSeriesGroup.key && seriesDetail.cover) || activeSeriesGroup.cover} alt="" />
                  ) : (
                    <div className="cover-placeholder"><Film size={20} /></div>
                  )}
                </div>
                <div className="dm-series-modal-meta">
                  <h3>{activeSeriesGroup.title}</h3>
                  <p>
                    {t("共 {0} 集", [seriesModalCounts.all])}
                    {` · ${t("已下载")} ${seriesModalCounts.completed}`}
                    {seriesModalCounts.downloading > 0 ? ` · ${t("下载中")} ${seriesModalCounts.downloading}` : ''}
                    {seriesModalCounts.pending > 0 ? ` · ${t("等待中")} ${seriesModalCounts.pending}` : ''}
                    {seriesModalCounts.missing > 0 ? ` · ${t("未下载")} ${seriesModalCounts.missing}` : ''}
                    {seriesModalCounts.fail > 0 ? ` · ${t("失败/停止")} ${seriesModalCounts.fail}` : ''}
                  </p>
                </div>
              </div>
              <button type="button" className="icon-btn" aria-label={t("关闭")} onClick={closeSeriesModal}>
                <X size={16} />
              </button>
            </div>
            <div className="dm-series-modal-filters" role="tablist" aria-label={t("分集状态筛选")}>
              {[
                ['all', '全部', seriesModalCounts.all],
                ['completed', '已下载', seriesModalCounts.completed],
                ['downloading', '下载中', seriesModalCounts.downloading],
                ['pending', '等待中', seriesModalCounts.pending],
                ['missing', '未下载', seriesModalCounts.missing],
                ...(seriesModalCounts.retrying > 0 ? [['retrying', '等待重试', seriesModalCounts.retrying]] : []),
                ...(seriesModalCounts.fail > 0 ? [['fail', '失败/停止', seriesModalCounts.fail]] : []),
              ].map(([key, label, count]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={seriesModalFilter === key}
                  className={`btn btn-sm ${seriesModalFilter === key ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => { setSeriesModalFilter(key); setSeriesModalPage(1); }}
                >
                  {t(label)} ({t(count)})
                </button>
              ))}
            </div>
            <div className="dm-series-modal-tools">
              {activeSeriesGroup.tasks.length > 0 && (() => {
                const groupAllSel = activeSeriesGroup.tasks.every(task => selected.has(task.id));
                const groupSelTasks = activeSeriesGroup.tasks.filter(task => selected.has(task.id));
                return <>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => toggleGroupSelect(activeSeriesGroup.tasks)}>
                    <CheckSquare size={14} />{t(groupAllSel ? '取消全选' : '全选本剧')}
                  </button>
                  {groupSelTasks.length > 0 && (
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => askDelete(groupSelTasks, `删除《${activeSeriesGroup.title}》选中的 ${groupSelTasks.length} 个任务`)}>
                      <Trash2 size={14} />{t("删除已选（")}{t(groupSelTasks.length)}{t("项）")}
                    </button>
                  )}
                </>;
              })()}
              {missingUnlockedEpisodes.length > 0 && activeSeriesGroup.seriesId && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={downloadingEpisodes.has(`${activeSeriesGroup.seriesId}:all`)}
                  onClick={() => downloadAllMissing(activeSeriesGroup, missingUnlockedEpisodes)}
                >
                  <Download size={14} />{t("下载未下载 ({0})", [missingUnlockedEpisodes.length])}
                </button>
              )}
              {seriesModalCounts.fail > 0 && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={async () => {
                    const ids = activeSeriesGroup.tasks.filter(needsManualRetry).map(task => task.id);
                    if (!ids.length) return;
                    try {
                      const res = await window.electronAPI.retryTasks(ids);
                      await refresh();
                      if (!res?.success) throw new Error(res?.error || '重试失败');
                      showToast(`已重新加入队列：${res.count} 项`);
                    } catch (error) { showToast(error.message || '重试失败', 'error'); }
                  }}
                >
                  <RefreshCw size={14} />{t("重试失败 ({0})", [seriesModalCounts.fail])}
                </button>
              )}
              {seriesDetailLoading && <span className="dm-series-modal-loading">{t("正在读取完整分集…")}</span>}
            </div>
            <div className="dm-modal-body">
              {seriesModalPageCount > 1 && (
                <div className="dm-modal-pager">
                  <span>{t("共 {0} 集 · 当前 {1}-{2}", [filteredSeriesEpisodes.length, (currentSeriesModalPage - 1) * PAGE_SIZE + 1, Math.min(currentSeriesModalPage * PAGE_SIZE, filteredSeriesEpisodes.length)])}</span>
                  <nav className="pagination-controls" aria-label={t("分集分页")}>
                    <button type="button" className="btn btn-outline btn-sm" disabled={currentSeriesModalPage <= 1} onClick={() => setSeriesModalPage(currentSeriesModalPage - 1)}>{t("上一页")}</button>
                    <span className="pager-status">{t("第 {0} / {1} 页", [currentSeriesModalPage, seriesModalPageCount])}</span>
                    <button type="button" className="btn btn-outline btn-sm" disabled={currentSeriesModalPage >= seriesModalPageCount} onClick={() => setSeriesModalPage(currentSeriesModalPage + 1)}>{t("下一页")}</button>
                  </nav>
                </div>
              )}
              {visibleSeriesEpisodes.length === 0 ? (
                <div className="dm-modal-empty">{t("该状态下暂无分集")}</div>
              ) : (
                <div className="dm-list dm-modal-list">
                  {visibleSeriesEpisodes.map((item) => {
                    if (item.task) {
                      return renderTaskRow(item.task, { showCover: false, selectable: true, episodeTitle: item.title });
                    }
                    const epKey = `${activeSeriesGroup.seriesId}:${item.vid_index}`;
                    const submitting = downloadingEpisodes.has(epKey) || downloadingEpisodes.has(`${activeSeriesGroup.seriesId}:all`);
                    return (
                      <div key={item.key} className="dm-task dm-episode-row">
                        <div className="dm-task-body">
                          <div className="dm-task-title">{item.title}</div>
                          <div className="dm-task-meta">
                            <span className={`status-tag status-${item.effectiveStatus === 'completed' ? 'completed' : 'missing'}`}>
                              {t(EPISODE_STATUS_TEXT[item.effectiveStatus] || item.effectiveStatus)}
                            </span>
                            {item.fileSize > 0 && <span className="dm-size">{t(fmtBytes(item.fileSize))}</span>}
                          </div>
                        </div>
                        <div className="dm-task-actions">
                          {item.effectiveStatus === 'missing' && !item.locked && activeSeriesGroup.seriesId && (
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              disabled={submitting}
                              onClick={() => downloadMissingEpisode(activeSeriesGroup.seriesId, item.vid_index)}
                            >
                              <Download size={14} />{t(submitting ? '加入中…' : '下载')}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`dm-toast dm-toast-${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      {/* 合并格式选择 */}
      {mergeAsk && (
        <div className="player-confirm-mask" onClick={() => closeMergeDialog()}>
          <div className="player-confirm" data-dm-dialog="merge" role="dialog" aria-modal="true" aria-label={t("合并导出")} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title" style={{ color: 'var(--accent)' }}>
              <Layers size={17} />{t("合并整部剧")}</div>
            <div className="player-confirm-msg">
              <p>{t("将《")}{(seriesList.find((series) => String(series.series_id) === mergeSeriesId)?.series_title || t('所选短剧'))}{t("》的全部已下载分集合并为一个 mp4。未下载的分集不会自动补齐。")}</p>
              <p><b>{t("高质量分辨率合并")}</b>{t("：逐集检查实际文件，全部达到1080P才能开始；有低清分集请选快速或兼容合并。")}</p>
              <p><b>{t("快速合并")}</b>{t("：优先无损拼接，保留每段原分辨率，部分设备可能不兼容。")}</p>
              <p><b>{t("兼容合并")}</b>{t("：必要时转为H.264/AAC，仍保留每段原分辨率，处理较慢。")}</p>
              <p>{t("三种方式都保留原文件，只合并已下载分集，不自动补齐，也不会把低清变成真高清。")}</p>
              <label className="dm-confirm-check">
                <input type="checkbox" checked={mergeDeleteSources} onChange={event => setMergeDeleteSources(event.target.checked)} />
                <span>{t("合并成功后删除已合并分集")}</span>
              </label>
              <p>{t("开启后会永久删除本次已合并的分集视频和下载记录；合并失败、取消或输出未成功时不会删除。")}</p>
              {mergeError && <p className="alert-error" role="alert">{t(mergeError)}</p>}
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => doMerge(false, true)} disabled={merging}>{t("高质量分辨率合并")}</button>
              <button className="btn btn-outline" onClick={() => closeMergeDialog()} disabled={merging}>{t("取消")}</button>
              <button className="btn btn-outline" onClick={() => doMerge(true)} disabled={merging}>{t("兼容合并（H.264）")}</button>
              <button className="btn btn-primary" onClick={() => doMerge(false)} disabled={merging}>{t("智能快速合并")}</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认（可选是否连本地文件一起删） */}
      {confirmAsk && (
        <div className="player-confirm-mask" onClick={() => setConfirmAsk(null)}>
          <div className="player-confirm" data-dm-dialog="delete" role="dialog" aria-modal="true" aria-label={t(confirmAsk.title)} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title">
              <Trash2 size={17} />
              {t(confirmAsk.title)}
            </div>
            <div className="player-confirm-msg">
              <p>{t("共 ")}{t(confirmAsk.count)}{t(" 个任务，其中 ")}{t(confirmAsk.withFile)}{t(" 个已下载完成")}{t(confirmAsk.estBytes > 0 ? `（约 ${fmtSize(confirmAsk.estBytes)}）` : '')}。</p>
              <label className="dm-confirm-check">
                <input
                  type="checkbox"
                  checked={!!confirmAsk._del}
                  onChange={(e) => setConfirmAsk({ ...confirmAsk, _del: e.target.checked })}
                />
                <span>{t("同时删除本地文件")}{t(confirmAsk.estBytes > 0 ? `（释放约 ${fmtSize(confirmAsk.estBytes)}）` : '')}
                </span>
              </label>
              <p className="dm-confirm-hint">{t("不勾选则只移除任务记录，磁盘上的视频文件会保留（可在文件管理器里自行管理）。")}</p>
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => setConfirmAsk(null)}>{t("取消")}</button>
              <button
                className={`btn ${confirmAsk._del ? 'btn-danger-solid' : 'btn-primary'}`}
                onClick={async () => {
                  const fn = confirmAsk.onOk;
                  const del = !!confirmAsk._del;
                  setConfirmAsk(null);
                  await fn(del);
                }}
              >
                {t(confirmAsk._del ? '删除任务和文件' : '仅删除记录')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DownloadManager;
