import { useCallback, useEffect, useRef, useState } from 'react';
import { readLocalLibrary, saveLocalSeries } from '../localLibrary';

export const EMPTY_ACCOUNT_LIST = { items: [], loaded: false, busy: false, error: '' };
const REFRESH_INTERVAL = 30000;
const newSession = id => ({ id, requests: new Map(), writes: new Set(), updatedAt: new Map() });

export default function useAccountLibrary() {
  const api = window.electronAPI;
  const supported = !!(api.getAccountLibrary && api.changeAccountLibrary);
  const current = useRef(newSession(''));
  const [account, setAccount] = useState({ signedIn: false, ready: !supported, statusError: '' });
  const [lists, setLists] = useState({});

  useEffect(() => {
    if (!supported) return;
    let revision = 0;
    const clear = () => {
      current.current = newSession('');
      setLists({});
    };
    const readStatus = async () => {
      const checking = ++revision;
      try {
        const result = await api.getAccountStatus();
        if (checking !== revision) return;
        if (!result?.success || result.error) throw new Error(result?.error || '暂时无法读取红果账号状态');
        const id = result.signedIn ? result.librarySession : '';
        if (result.signedIn && !id) throw new Error('暂时无法读取红果账号状态');
        if (id !== current.current.id) {
          current.current = newSession(id);
          setLists({});
        }
        setAccount({ signedIn: !!id, sessionId: id, ready: true, statusError: '' });
      } catch (error) {
        if (checking !== revision) return;
        clear();
        setAccount({ signedIn: false, ready: false, statusError: error.message || '暂时无法读取红果账号状态' });
      }
    };
    const unsubscribe = api.onAccountUpdated?.(result => {
      if (result?.signedIn === undefined) return;
      revision++;
      clear();
      setAccount({ signedIn: false, ready: !result.signedIn, statusError: '' });
      if (result.signedIn) void readStatus();
    });
    window.addEventListener('focus', readStatus);
    void readStatus();
    return () => {
      revision++;
      current.current = newSession('');
      unsubscribe?.();
      window.removeEventListener('focus', readStatus);
    };
  }, [api, supported]);

  const updateList = useCallback((kind, change) => {
    setLists(previous => ({ ...previous, [kind]: { ...(previous[kind] || EMPTY_ACCOUNT_LIST), ...change } }));
  }, []);

  const refresh = useCallback(async (kind, force = true) => {
    const session = current.current;
    const writeKind = kind === 'pendingReservations' ? 'reservation' : kind;
    if (!session.id || session.writes.has(writeKind) || session.requests.has(kind)) return;
    if (!force && Date.now() - (session.updatedAt.get(kind) || 0) < REFRESH_INTERVAL) return;
    const request = {};
    session.requests.set(kind, request);
    const valid = () => session === current.current && session.requests.get(kind) === request;
    updateList(kind, { busy: true, error: '' });
    try {
      const result = await api.getAccountLibrary(session.id, kind);
      if (!valid()) return;
      if (!result?.success || !Array.isArray(result.items)) throw new Error(result?.error || '云端列表读取失败，请重试');
      session.updatedAt.set(kind, Date.now());
      updateList(kind, { items: result.items, loaded: true, busy: false });
    } catch (error) {
      if (valid()) updateList(kind, { busy: false, error: error.message || '云端列表读取失败，请重试' });
    } finally {
      if (valid()) session.requests.delete(kind);
    }
  }, [api, updateList]);

  useEffect(() => {
    if (!account.sessionId) return;
    for (const kind of ['favorite', 'like', 'reservation']) void refresh(kind, false);
  }, [account.sessionId, refresh]);

  const watch = useCallback(kind => {
    void refresh(kind, false);
    const refreshIfVisible = () => { if (!document.hidden) void refresh(kind, false); };
    const refreshOnFocus = () => { if (!document.hidden) void refresh(kind); };
    const timer = setInterval(refreshIfVisible, REFRESH_INTERVAL);
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [refresh]);

  const change = useCallback(async ({ kind, item, value, move = false }) => {
    const session = current.current;
    if (!session.id || session.writes.has(kind)) return { cancelled: true };
    const updatesPending = kind === 'reservation' && item.online !== true;
    session.writes.add(kind);
    session.requests.delete(kind);
    if (updatesPending) session.requests.delete('pendingReservations');
    updateList(kind, { busy: true, error: '' });
    try {
      const result = await api.changeAccountLibrary(session.id, {
        kind, value, seriesId: item.id, episodeId: item.episodeId, reservationId: item.reservationId,
        ...(kind === 'reservation' ? { online: item.online === true, reservationSeries: item.reservationSeries === true } : {}),
      });
      if (session !== current.current) return { cancelled: true };
      if (!result?.success || (value ? !result.entry : result.entry !== null)) throw new Error(result?.error || '红果云端尚未确认该操作，请刷新后重试');
      const matches = row => kind === 'like' ? row.episodeId === item.episodeId
        : kind === 'reservation' ? row.online === (item.online === true)
          && ((row.reservationId || row.id) === (item.reservationId || item.id)
            || (item.reservationSeries === true && (row.id === item.id || row.reservationId === item.id))) : row.id === item.id;
      setLists(previous => {
        const list = previous[kind] || EMPTY_ACCOUNT_LIST;
        const snapshot = Array.isArray(result.items);
        const updateRows = items => {
          const rows = items.filter(row => !matches(row));
          if (value) rows.unshift({ ...item, ...result.entry, title: result.entry.title || item.title, cover: result.entry.cover || item.cover });
          return rows;
        };
        if (updatesPending) {
          const pending = previous.pendingReservations || EMPTY_ACCOUNT_LIST;
          const received = Array.isArray(result.pendingItems);
          const pendingRows = updateRows(received ? result.pendingItems
            : pending.loaded ? pending.items : list.items.filter(row => !row.online));
          return {
            ...previous,
            reservation: { ...list, items: [...pendingRows, ...list.items.filter(row => row.online)], busy: false },
            pendingReservations: { ...pending, items: pendingRows, loaded: received || pending.loaded, busy: false, error: '' },
          };
        }
        const rows = updateRows(snapshot ? result.items : list.items);
        return { ...previous, [kind]: { ...list, items: rows, loaded: snapshot || list.loaded, busy: false } };
      });
      if (Array.isArray(result.items)) session.updatedAt.set(kind, Date.now());
      if (updatesPending && Array.isArray(result.pendingItems)) session.updatedAt.set('pendingReservations', Date.now());
      if (move) {
        const local = readLocalLibrary();
        const favorite = local.items.find(row => row.id === item.id && row.favorite);
        const error = local.error || (favorite ? saveLocalSeries({ ...favorite, favorite: false }).error : '');
        if (error) return { success: false, error: '云端已收藏，本机记录移除失败，原记录已保留。' };
      }
      return { success: true };
    } catch (error) {
      if (session !== current.current) return { cancelled: true };
      const message = error.message || '红果账号操作失败，请稍后重试';
      updateList(kind, { busy: false, error: message });
      if (updatesPending) updateList('pendingReservations', { busy: false });
      return { success: false, error: message };
    } finally {
      session.writes.delete(kind);
    }
  }, [api, updateList]);

  return { ...account, lists, watch, refresh, change };
}
