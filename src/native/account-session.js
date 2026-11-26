const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { signedAccountRequest, requestJson } = require('./app-source');
const { getPlaybackDevice } = require('./playback-device');
const { writeJsonAtomic } = require('./atomic-json');
const { chooseAccountProgress, isSameAccountProgress, accountProgressBodies, verifyAccountProgressWrite } = require('./account-progress-sync');
const { createAccountLibrary, ID_FIELDS } = require('./account-library');

const WEB_BASE = 'https://hongguoduanju.com';
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WEB_QUERY = {
  aid: '513755', passport_jssdk_version: '3.4.10', passport_jssdk_type: 'normal',
  account_sdk_source: 'web', is_from_ttaccountsdk: '1', language: 'zh',
};

function safeMessage(error, fallback = '账号操作失败，请稍后重试') {
  return String(error?.message || fallback)
    .replace(/https?:\/\/\S+/gi, '[地址]')
    .replace(/(?:sessionid|sid_tt|passport_csrf_token)=[^;\s]+/gi, '$1=[已隐藏]')
    .slice(0, 160);
}

function withTimeout(promise, timeout, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); }),
  ]).finally(() => clearTimeout(timer));
}

function isExpiredSession(error) {
  return error?.status === 401 || /会话(?:已)?过期|登录(?:状态|态)?(?:已)?(?:失效|过期)|登录态未通过|账号编号无效|未登录|请(?:先|重新)登录|HTTP\s*401|(?:not logged in|session expired)/i.test(String(error?.message || ''));
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function cleanCover(value) {
  const text = String(value || '').trim();
  const url = text.startsWith('//') ? `https:${text}` : text;
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const parsed = new URL(url);
    if (/\.heic$/i.test(parsed.pathname) && /-reading-sign\.fqnovelpic\.com$/i.test(parsed.hostname)) {
      const source = parsed.pathname.split('~tplv-', 1)[0];
      return `https://p3-novel.byteimg.com${source}~tplv-shrink:320:0.webp`;
    }
    return /\.heic$/i.test(parsed.pathname) ? '' : url;
  } catch { return ''; }
}

function responseData(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('红果账号接口返回格式异常');
  if (payload.message && String(payload.message).trim().toLowerCase() !== 'success') {
    const description = payload.data?.description || payload.message;
    throw new Error(cleanText(description) || '红果账号操作未完成');
  }
  if (payload.code !== undefined && Number(payload.code) !== 0) {
    throw new Error(cleanText(payload.message || payload.msg) || `红果账号接口返回错误（${payload.code}）`);
  }
  if (!payload.data || typeof payload.data !== 'object') throw new Error('红果账号接口返回内容为空');
  return payload.data;
}

function parseQr(payload) {
  const data = responseData(payload);
  const token = String(data.token || '').trim();
  const source = String(data.qrcode || '').trim();
  if (!token || !source) throw new Error('红果登录二维码格式已变化');
  const image = /^data:image\//i.test(source) ? source : `data:image/png;base64,${source.split('base64,').pop()}`;
  const rawExpiry = Number(data.expire_time);
  const expiresIn = rawExpiry > 1_000_000_000
    ? Math.max(0, Math.min(600, rawExpiry - Math.floor(Date.now() / 1000)))
    : Math.max(0, Math.min(600, rawExpiry || 180));
  return { token, image, expiresIn: Math.round(expiresIn) };
}

function parsePassportProfile(payload) {
  const data = responseData(payload);
  const id = String(data.user_id_str || data.user_id || '').trim();
  if (!id) throw new Error('登录态未通过红果账号验证，请重新扫码');
  if (!/^\d{1,30}$/.test(id) || !/[1-9]/.test(id)) throw new Error('红果账号编号无效，请重新扫码');
  return { id, nickname: cleanText(data.name || data.screen_name || data.username) || '红果用户' };
}

function parseStoredProfile(value) {
  const id = String(value?.id || '').trim();
  if (!/^\d{1,30}$/.test(id) || !/[1-9]/.test(id)) return null;
  return { id, nickname: cleanText(value?.nickname) || '红果用户' };
}

function parseHistory(payload) {
  const data = responseData(payload);
  const rows = data.data_list;
  if (!Array.isArray(rows)) throw new Error('APP 观看记录格式已变化');
  const seen = new Set();
  return rows.map(row => {
    if (row?.is_delete) return null;
    const seriesId = String(row?.book_id_str || row?.book_id || row?.series_id || '').trim();
    const episodeId = String(row?.vid || row?.item_id || '').trim();
    if (!/^\d{1,30}$/.test(seriesId) || !/^\d{1,30}$/.test(episodeId)) return null;
    const index = Number(row?.vid_index);
    const seconds = value => Math.max(0, (Number(value) || 0) / 1000);
    const rawTime = Number(row?.read_timestamp_ms || row?.last_watch_time) || 0;
    return {
      series_id: seriesId,
      series_title: cleanText(row?.series_title || row?.book_name),
      cover: cleanCover(row?.series_cover_url || row?.thumb_url || row?.cover),
      episode_id: episodeId,
      vid_index: Number.isSafeInteger(index) && index > 0 ? index : 0,
      currentTime: seconds(row?.current_play_position ?? row?.current_play_time),
      duration: seconds(row?.duration ?? row?.current_total_time),
      updatedAt: rawTime > 0 && rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime,
      total: Math.max(0, Number(row?.episode_cnt || row?.episode_count) || 0),
      account: true,
    };
  }).filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter(row => {
      if (seen.has(row.series_id)) return false;
      seen.add(row.series_id);
      return true;
    });
}

class CookieJar {
  constructor(header = '') {
    this.values = new Map();
    for (const pair of String(header).split(';')) {
      const at = pair.indexOf('=');
      if (at > 0) this.values.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }
  absorb(headers) {
    const raw = headers?.['set-cookie'];
    const lines = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const line of lines) {
      const pair = String(line).split(';', 1)[0];
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      this.values.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }
  header() {
    return [...this.values].filter(([name, value]) => name && value).map(([name, value]) => `${name}=${value}`).join('; ');
  }
  hasSession() {
    return this.values.has('sessionid') || this.values.has('sessionid_ss');
  }
}

async function defaultWebRequest(url, options) {
  const axios = require('axios');
  const response = await axios({
    url, method: options.method || 'GET', headers: options.headers || {}, timeout: 12000,
    maxRedirects: 0, responseType: 'text', transformResponse: [data => data],
    maxContentLength: 2 * 1024 * 1024, maxBodyLength: 1024 * 1024, validateStatus: () => true,
  });
  return { status: response.status, headers: response.headers || {}, data: response.data || '' };
}

function checkedWebResponse(response) {
  if (!response || response.status !== 200) throw new Error(`红果网页登录请求失败（HTTP ${response?.status || '未知'}）`);
  const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
  if (!raw.trim() || raw.length > 2 * 1024 * 1024) throw new Error('红果网页登录响应异常');
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('红果网页登录响应格式异常'); }
  return payload;
}

function secureSessionStore({ filePath, safeStorage }) {
  const encryptionAvailable = () => {
    try {
      return safeStorage?.isEncryptionAvailable?.() === true
        && safeStorage?.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  };
  return {
    save(credentials) {
      if (!encryptionAvailable()) throw new Error('系统安全存储不可用，本次登录只保留到应用退出');
      const encrypted = safeStorage.encryptString(JSON.stringify(credentials));
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      try {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temporary, filePath);
        try { fs.chmodSync(filePath, 0o600); } catch {}
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch {}
        throw error;
      }
    },
    load() {
      if (!fs.existsSync(filePath)) return null;
      if (!encryptionAvailable()) throw new Error('系统安全存储不可用，无法读取上次登录');
      const text = safeStorage.decryptString(fs.readFileSync(filePath));
      const value = JSON.parse(text);
      if (value?.expired === true) return value;
      if (!value || typeof value.cookie !== 'string' || !value.cookie.trim()) throw new Error('登录态文件无效，请重新扫码');
      return value;
    },
    clear() {
      try { fs.unlinkSync(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}

function localSessionStore(filePath) {
  return {
    save(credentials) {
      try { writeJsonAtomic(filePath, credentials); }
      catch { throw new Error('无法保存本机登录信息，下次启动需重新登录。'); }
    },
    load() {
      let text;
      try { text = fs.readFileSync(filePath, 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('无法读取本机登录信息，请检查资料目录权限后重试。');
      }
      let value;
      try { value = JSON.parse(text); } catch {}
      if (value?.expired === true) return value;
      if (typeof value?.cookie !== 'string' || !value.cookie.trim()) {
        throw new Error('本机登录信息无效，请重新登录。');
      }
      return value;
    },
    clear() {
      try { fs.unlinkSync(filePath); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error('无法清除本机登录信息，请检查资料目录权限后重试。');
      }
    },
  };
}

function createAccountService({
  filePath, safeStorage, local = false, webRequest = defaultWebRequest, identityRequest = getPlaybackDevice,
  accountRequest = requestJson, now = Date.now, onAccountExpired = () => {}, historyFilePath,
}) {
  const sessionStore = local ? localSessionStore(filePath) : secureSessionStore({ filePath, safeStorage });
  let credentials = null;
  let profile = null;
  let expired = false;
  let history = [];
  let historyLoaded = false;
  let historyRefresh = null;
  let restorePromise = null;
  let generation = 0;
  let verifiedAt = 0;
  let sessionVerification = null;
  let login = null;
  let loginGeneration = 0;
  let librarySession = null;

  function resetLibrarySession(current = null) {
    librarySession?.controller.abort();
    librarySession = null;
    if (!current) return;
    const controller = new AbortController();
    librarySession = {
      id: randomUUID(), controller,
      library: createAccountLibrary({
        cleanText, cleanCover, now, signal: controller.signal,
        request: (apiPath, params, payload) => accountJson(current, apiPath, params, payload, undefined, controller.signal),
      }),
    };
  }

  async function libraryAction(id, run) {
    const current = librarySession;
    const checkSession = () => {
      if (!current || current !== librarySession || current.id !== id) throw new Error('红果账号已变更，请重新登录。');
    };
    checkSession();
    try {
      const result = await run(current.library);
      checkSession();
      return result;
    } catch (error) {
      checkSession();
      if (isExpiredSession(error)) expireAccount();
      throw error;
    }
  }

  const publicAccount = extra => ({
    success: true, signedIn: !!profile, ...(expired ? { expired: true } : {}), account: profile ? { ...profile } : null, ...extra,
  });

  let savedHistory;
  const historyMaxBytes = 24 * 1024 * 1024;
  function localHistory() {
    if (savedHistory === undefined && historyFilePath) {
      try {
        if (fs.statSync(historyFilePath).size <= historyMaxBytes) {
          const stored = JSON.parse(fs.readFileSync(historyFilePath, 'utf8'));
          if (typeof stored?.accountId === 'string' && Array.isArray(stored.rows)) {
            savedHistory = { accountId: stored.accountId, rows: stored.rows.filter(row => typeof row?.series_title === 'string' && typeof row?.episode_id === 'string') };
          }
        }
      } catch {}
    }
    savedHistory ??= null;
    return savedHistory;
  }

  function cacheLocalHistory(accountId, rows) {
    if (!historyFilePath) return;
    const previous = localHistory();
    if (previous?.accountId === accountId && JSON.stringify(previous.rows) === JSON.stringify(rows)) return;
    const next = { accountId, rows };
    try { writeJsonAtomic(historyFilePath, next, { maxBytes: historyMaxBytes }); }
    catch { throw new Error('无法保存云端观看记录，请检查本机存储后重试。'); }
    savedHistory = next;
  }

  function expireAccount() {
    generation++;
    resetLibrarySession();
    credentials = null;
    profile = null;
    expired = true;
    history = [];
    historyLoaded = false;
    restorePromise = Promise.resolve(publicAccount());
    try { sessionStore.save({ expired: true }); } catch { try { sessionStore.clear(); } catch {} }
    onAccountExpired();
  }

  async function accountJson(targetCredentials, apiPath, params = {}, payload, beforeWrite, librarySignal) {
    librarySignal?.throwIfAborted();
    // Website authentication does not depend on anonymous App device availability.
    const identity = targetCredentials.deviceId && targetCredentials.installId && targetCredentials.cdid ? {
      device_id: targetCredentials.deviceId, iid: targetCredentials.installId, cdid: targetCredentials.cdid,
    } : await withTimeout(identityRequest(accountRequest), 10000, '账号设备初始化超时，请重试');
    if (targetCredentials !== credentials) throw new Error('账号已退出，请重新登录');
    librarySignal?.throwIfAborted();
    beforeWrite?.();
    const signed = signedAccountRequest(apiPath, params, identity, payload);
    const deadline = Date.now() + 12000;
    const timeout = AbortSignal.timeout(12000);
    return accountRequest(signed.url, {
      method: signed.body ? 'POST' : 'GET',
      ...(signed.body ? { data: signed.body } : {}),
      headers: { ...signed.headers, Cookie: targetCredentials.cookie },
      preserveLargeIntegerFields: librarySignal ? ID_FIELDS : ['vid', 'video_id', 'item_id'],
    }, deadline, librarySignal ? AbortSignal.any([timeout, librarySignal]) : timeout);
  }

  async function verify(targetCredentials) {
    return parsePassportProfile(await webJson('/passport/account/info/v2/', {}, new CookieJar(targetCredentials.cookie)));
  }

  function verifySession(current, token) {
    if (sessionVerification?.token === token) return sessionVerification.promise;
    const validation = { token };
    sessionVerification = validation;
    validation.promise = withTimeout(verify(current), 12000, '登录态验证超时').then(nextProfile => {
      if (token !== generation) return false;
      if (profile?.id !== nextProfile.id) { expireAccount(); return false; }
      profile = nextProfile;
      verifiedAt = now();
      return true;
    }).catch(error => {
      if (token === generation && isExpiredSession(error)) expireAccount();
      return false;
    }).finally(() => { if (sessionVerification === validation) sessionVerification = null; });
    return validation.promise;
  }

  async function restore() {
    try {
      const saved = sessionStore.load();
      if (!saved) return publicAccount();
      if (saved.expired === true) { expired = true; return publicAccount(); }
      const token = generation;
      const cachedProfile = parseStoredProfile(saved.profile);
      if (cachedProfile) {
        credentials = saved;
        profile = cachedProfile;
        resetLibrarySession(saved);
        void verifySession(saved, token);
        return publicAccount();
      }
      const nextProfile = await withTimeout(verify(saved), 12000, '登录态验证超时，请稍后重试').catch(error => {
        if (token === generation && isExpiredSession(error)) expireAccount();
        throw error;
      });
      if (token !== generation) return publicAccount();
      credentials = saved;
      profile = nextProfile;
      resetLibrarySession(saved);
      verifiedAt = now();
      try { sessionStore.save({ ...saved, profile: nextProfile }); } catch {}
      return publicAccount();
    } catch (error) {
      return expired ? publicAccount() : { ...publicAccount(), error: safeMessage(error, '上次登录暂时无法恢复') };
    }
  }

  async function ensureRestored() {
    if (!restorePromise) restorePromise = restore();
    return restorePromise;
  }

  async function webJson(pathname, params = {}, jar = new CookieJar(), referer = `${WEB_BASE}/`) {
    const url = new URL(pathname, WEB_BASE);
    for (const [name, value] of Object.entries({ ...WEB_QUERY, ...params })) url.searchParams.set(name, value);
    const cookie = jar.header();
    const headers = {
      'User-Agent': WEB_UA, Referer: referer, Origin: WEB_BASE,
      Accept: 'application/json, text/javascript',
      ...(cookie ? { Cookie: cookie } : {}),
    };
    const response = await webRequest(url.href, { method: 'GET', headers });
    jar.absorb(response.headers);
    return checkedWebResponse(response);
  }

  async function finishRedirect(value, jar) {
    let url = new URL(value, WEB_BASE);
    for (let count = 0; count < 5; count++) {
      if (url.protocol !== 'https:' || !(url.hostname === 'hongguoduanju.com' || url.hostname.endsWith('.hongguoduanju.com'))) {
        throw new Error('登录确认跳转到了不支持的站点');
      }
      const response = await webRequest(url.href, {
        method: 'GET', headers: { 'User-Agent': WEB_UA, Referer: `${WEB_BASE}/`, Cookie: jar.header() },
      });
      jar.absorb(response.headers);
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers?.location) {
        url = new URL(response.headers.location, url);
        continue;
      }
      if (response.status !== 200) throw new Error(`登录确认失败（HTTP ${response.status}）`);
      return;
    }
    throw new Error('登录确认跳转次数过多');
  }

  return {
    async status() {
      const restored = await ensureRestored();
      return restored.signedIn ? publicAccount() : restored;
    },

    librarySessionId() { return librarySession?.id || ''; },
    readLibrary(id, kind) { return libraryAction(id, library => library.read(kind)); },
    changeLibrary(id, change) { return libraryAction(id, library => library.change(change)); },

    async completeWebLogin(cookie) {
      const attempt = ++loginGeneration;
      login = null;
      const token = generation;
      const nextProfile = await withTimeout(verify({ cookie }), 15000, '账号资料验证超时，请重试');
      if (attempt !== loginGeneration || token !== generation) return { success: true, status: 'cancelled' };
      const nextCredentials = { cookie };
      let storageWarning = '';
      try { sessionStore.save({ ...nextCredentials, profile: nextProfile }); } catch (error) { storageWarning = safeMessage(error); }
      credentials = nextCredentials; profile = nextProfile; expired = false; history = []; historyLoaded = false;
      resetLibrarySession(nextCredentials);
      verifiedAt = now();
      generation++; restorePromise = Promise.resolve(publicAccount());
      return publicAccount({ status: 'signed-in', storageWarning });
    },

    async startLogin() {
      const attempt = ++loginGeneration;
      login = null;
      const jar = new CookieJar();
      const payload = await webJson('/passport/web/get_qrcode/', { next: `${WEB_BASE}/` }, jar);
      if (attempt !== loginGeneration) throw new Error('扫码已取消，请重新获取二维码');
      const qr = parseQr(payload);
      login = { id: randomUUID(), token: qr.token, jar, expiresAt: now() + qr.expiresIn * 1000 };
      return { success: true, loginId: login.id, image: qr.image, expiresIn: qr.expiresIn, expiresAt: login.expiresAt };
    },

    async pollLogin(loginId) {
      if (!login || login.id !== loginId) throw new Error('扫码会话已失效，请重新获取二维码');
      if (now() >= login.expiresAt) {
        login = null;
        return { success: true, status: 'expired' };
      }
      const currentLogin = login;
      const attempt = loginGeneration;
      const stillCurrent = () => login === currentLogin && attempt === loginGeneration;
      const data = responseData(await webJson('/passport/web/check_qrconnect/', {
        next: `${WEB_BASE}/`, token: login.token,
      }, login.jar));
      if (!stillCurrent()) return { success: true, status: 'cancelled' };
      console.log('[Account] QR status:', String(data.status || ''), data.redirect_url ? 'redirect' : 'no-redirect');
      if (['5', 'expired'].includes(String(data.status))) {
        login = null;
        return { success: true, status: 'expired' };
      }
      if (!['3', 'confirmed'].includes(String(data.status))) return { success: true, status: 'pending' };
      if (data.redirect_url) await finishRedirect(String(data.redirect_url), login.jar);
      if (!stillCurrent()) return { success: true, status: 'cancelled' };
      console.log('[Account] Login session cookie:', login.jar.hasSession() ? 'present' : 'missing');
      if (!login.jar.hasSession()) return { success: true, status: 'pending' };

      const cookie = login.jar.header();
      console.log('[Account] Profile verify: start');
      const nextProfile = await withTimeout(verify({ cookie }), 15000, '账号资料验证超时，请重试');
      if (!stillCurrent()) return { success: true, status: 'cancelled' };
      console.log('[Account] Profile verify: done');
      const nextCredentials = { cookie };
      let storageWarning = '';
      try { sessionStore.save({ ...nextCredentials, profile: nextProfile }); }
      catch (error) { storageWarning = safeMessage(error); }
      credentials = nextCredentials;
      profile = nextProfile;
      resetLibrarySession(nextCredentials);
      expired = false;
      verifiedAt = now();
      history = [];
      historyLoaded = false;
      generation++;
      login = null;
      restorePromise = Promise.resolve(publicAccount());
      return publicAccount({ storageWarning, status: 'signed-in' });
    },

    cancelLogin(loginId) {
      if (loginId && login && login.id !== loginId) return { success: true };
      loginGeneration++;
      login = null;
      return { success: true };
    },

    async logout() {
      if (local) sessionStore.clear();
      loginGeneration++;
      generation++;
      resetLibrarySession();
      credentials = null;
      profile = null;
      expired = false;
      history = [];
      historyLoaded = false;
      login = null;
      restorePromise = Promise.resolve(publicAccount());
      let storageWarning = '';
      if (!local) {
        try { sessionStore.clear(); } catch (error) { storageWarning = safeMessage(error); }
      }
      return publicAccount({ storageWarning });
    },

    refreshHistory() {
      const current = credentials;
      if (!current || !profile) return Promise.resolve({ success: true, signedIn: false, account: null, results: [] });
      const token = generation;
      if (historyRefresh?.token === token) return historyRefresh.promise;
      if (now() - verifiedAt >= 120000) void verifySession(current, token);
      const pending = { token, promise: null };
      historyRefresh = pending;
      pending.promise = (async () => {
        const combined = [];
        const seenPages = new Set();
        let offset = 0;
        for (let page = 0; page < 200; page++) {
          const raw = responseData(await accountJson(current, '/reading/bookapi/read_history/list/v1/', {
            book_type: '2', limit: '0', offset: String(offset), last_min_read_timestamp_ms: '0',
            full_field: 'true', is_first_load: String(page === 0), query_soft_deleted: 'false',
          }));
          if (token !== generation || current !== credentials) return { success: true, signedIn: false, account: null, results: [] };
          if (!Array.isArray(raw.data_list)) throw new Error('APP 观看记录格式已变化');
          const pageKey = JSON.stringify(raw.data_list.map(row => row?.book_id_str || row?.book_id || row?.series_id));
          if (seenPages.has(pageKey)) break;
          seenPages.add(pageKey);
          combined.push(...raw.data_list);
          if (![true, 1, '1', 'true'].includes(raw.has_more)) {
            if (!combined.length && localHistory()?.accountId === profile.id && localHistory().rows.length) {
              const confirmed = await verifySession(current, token);
              if (token !== generation) return publicAccount({ results: [] });
              if (!confirmed) throw new Error('暂时无法确认云端观看记录，请稍后重试。');
            }
            history = parseHistory({ data: { data_list: combined } }).map(row => ({
              ...row, series_title: row.series_title || `剧集 ${row.series_id}`,
            }));
            historyLoaded = true;
            cacheLocalHistory(profile.id, history);
            return publicAccount({ results: history.map(row => ({ ...row })) });
          }
          const next = Number(raw.next_offset ?? offset + 500);
          if (!raw.data_list.length || !Number.isSafeInteger(next) || next <= offset) break;
          offset = next;
        }
        throw new Error('云端观看记录未读取完整，请稍后刷新。');
      })().catch(error => {
        if (token === generation && current === credentials && isExpiredSession(error)) {
          expireAccount();
          return publicAccount({ results: [] });
        }
        throw error;
      }).finally(() => { if (historyRefresh === pending) historyRefresh = null; });
      return pending.promise;
    },

    async history({ refresh = false } = {}) {
      const current = credentials;
      if (!current || !profile) return { success: true, signedIn: false, account: null, results: [] };
      if (!historyLoaded || refresh) return this.refreshHistory();
      return publicAccount({ results: history.map(row => ({ ...row })) });
    },

    activeAccountId() {
      return profile?.id || '';
    },

    cachedHistory() {
      const saved = localHistory();
      return profile ? (historyLoaded ? history : saved?.accountId === profile.id ? saved.rows : []) : [];
    },

    localHistory,

    async uploadProgress(accountId, position, expectedCloud, { allowNew = false, retryProgress = false, shouldSend } = {}) {
      const current = credentials;
      const token = generation;
      const checkAccount = () => {
        if (!current || current !== credentials || profile?.id !== accountId || token !== generation) {
          throw new Error(allowNew ? '红果账号已变更，请重新登录。' : '测试账号已变更，请重新开始测试。');
        }
      };
      const beforeWrite = () => {
        checkAccount();
        if (shouldSend && !shouldSend()) throw new Error('本机观看进度已更新，将在下次同步时处理。');
      };
      checkAccount();
      await this.refreshHistory();
      beforeWrite();
      const cloud = this.row(position.series_id);
      const direction = chooseAccountProgress(position, cloud, { allowNew });
      const sameBaseline = cloud && expectedCloud
        ? cloud.updatedAt === expectedCloud.updatedAt && isSameAccountProgress(cloud, expectedCloud)
        : !cloud && !expectedCloud;
      const alreadyHasHistory = retryProgress && direction === 'unchanged' && cloud?.updatedAt <= position.updatedAt;
      if ((!alreadyHasHistory && direction !== 'upload') || !sameBaseline) {
        throw new Error('云端进度已变更，请重新查看后再同步。');
      }
      const { history: historyBody, progress: progressBody } = accountProgressBodies(position);
      if (!alreadyHasHistory) verifyAccountProgressWrite(await accountJson(current, '/reading/bookapi/read_history/update/v', {}, historyBody, beforeWrite));
      beforeWrite();
      try {
        verifyAccountProgressWrite(await accountJson(current, '/reading/bookapi/read_progress/upload/v', {}, progressBody, beforeWrite));
      } catch (error) {
        beforeWrite();
        if (allowNew) throw error;
        throw new Error('云端观看记录已提交，断点回写未获确认。请先在手机上刷新核对。');
      }
      if (allowNew) return;
      for (const wait of [0, 1000, 3000, 7000, 15000]) {
        if (wait) await delay(wait);
        checkAccount();
        try { await this.refreshHistory(); }
        catch { continue; }
        checkAccount();
        const readBack = this.row(position.series_id);
        if (isSameAccountProgress(position, readBack)) return { ...readBack };
      }
      checkAccount();
      throw new Error(allowNew ? '云端进度还未更新，稍后会自动重试。' : '服务器已响应，但还未读回相同的分集和断点。请在手机上刷新核对。');
    },

    uploadProgressForTest(accountId, position, expectedCloud) {
      return this.uploadProgress(accountId, position, expectedCloud);
    },

    row(seriesId) {
      return profile ? history.find(row => row.series_id === String(seriesId)) || null : null;
    },
  };
}

module.exports = {
  createAccountService, secureSessionStore, parseQr, parsePassportProfile, parseHistory, safeMessage,
};
