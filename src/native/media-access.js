const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { readFileIdentity, readFileIdentityAsync, sameFileObject } = require('./file-identity');

const MAX_MEDIA_CAPABILITIES = 4096;

function fileIdentity(resolved) {
  try { return readFileIdentity(resolved); }
  catch (_) { return null; }
}

async function fileIdentityAsync(resolved) {
  try { return await readFileIdentityAsync(resolved); }
  catch (_) { return null; }
}

function createMediaAccess(devUrl) {
  const files = new Map(), ids = new Map();
  const devOrigin = devUrl ? new URL(devUrl).origin : '';
  const allowed = origin => origin === 'null' || origin === 'file://' || (!!devOrigin && origin === devOrigin);
  function register(file, identity, validate) {
    const resolved = path.resolve(String(file));
    let id = ids.get(resolved);
    if (id) {
      const entry = files.get(id);
      if (!sameFileObject(entry.identity, identity)) { ids.delete(resolved); files.delete(id); id = undefined; }
      else {
        entry.identity = identity;
        if (typeof validate === 'function') entry.validate = validate;
        // 刷新最近访问顺序，避免活跃媒体令牌被淘汰
        files.delete(id);
        files.set(id, entry);
      }
    }
    if (!id) {
      id = randomUUID();
      ids.set(resolved, id);
      files.set(id, { file:resolved, identity, validate });
      while (files.size > MAX_MEDIA_CAPABILITIES) {
        const oldestId = files.keys().next().value;
        const oldest = files.get(oldestId);
        files.delete(oldestId);
        if (oldest && ids.get(oldest.file) === oldestId) ids.delete(oldest.file);
      }
    }
    return `hongguo-local://f/${id}`;
  }
  return {
    localUrl(file, validate) {
      const resolved = path.resolve(String(file));
      const identity = fileIdentity(resolved);
      return register(resolved, identity, validate);
    },
    async localUrlAsync(file, validate) {
      const resolved = path.resolve(String(file));
      const identity = await readFileIdentityAsync(resolved);
      return register(resolved, identity, validate);
    },
    localUrlWithIdentity(file, identity, validate) {
      if (!identity || typeof identity.contentHash !== 'string' || !identity.contentHash) throw new Error('下载视频身份不完整');
      return register(file, { ...identity }, validate);
    },
    resolveLocal(value) {
      const url = new URL(value);
      if (url.hostname !== 'f' || url.search || url.hash) return null;
      return files.get(url.pathname.slice(1))?.file || null;
    },
    isValid(value) {
      try {
        const url = new URL(value);
        const id = url.hostname === 'f' && !url.search && !url.hash ? url.pathname.slice(1) : null;
        const entry = id && files.get(id);
        if (!entry) return false;
        if (entry.identity === null) return false;
        if (!sameFileObject(entry.identity, fileIdentity(entry.file))) {
          files.delete(id);
          if (ids.get(entry.file) === id) ids.delete(entry.file);
          return false;
        }
        return typeof entry.validate === 'function' && entry.validate(entry.file) === true;
      } catch (_) { return false; }
    },
    // 异步校验本地文件身份与头部摘要，避免协议处理器在主线程同步阻塞读取 48KB
    async isValidAsync(value) {
      try {
        const url = new URL(value);
        const id = url.hostname === 'f' && !url.search && !url.hash ? url.pathname.slice(1) : null;
        const entry = id && files.get(id);
        if (!entry) return false;
        if (entry.identity === null) return false;
        const currentIdentity = await fileIdentityAsync(entry.file);
        if (files.get(id) !== entry) return false;
        if (!sameFileObject(entry.identity, currentIdentity)) {
          files.delete(id);
          if (ids.get(entry.file) === id) ids.delete(entry.file);
          return false;
        }
        return typeof entry.validate === 'function' && entry.validate(entry.file) === true;
      } catch (_) { return false; }
    },
    revoke(file) {
      try {
        const resolved = path.resolve(String(file));
        const id = ids.get(resolved);
        if (id) {
          ids.delete(resolved);
          files.delete(id);
        }
      } catch (_) {}
    },
    corsHeaders(request) {
      const origin = request.headers.get('origin');
      // Opaque origins are not identities: unguessable media capabilities remain mandatory.
      if ((origin && !allowed(origin)) || (request.initiatorOrigin && !allowed(request.initiatorOrigin))) return null;
      if (origin && request.initiatorOrigin && origin !== request.initiatorOrigin && !(origin === 'null' && request.initiatorOrigin === 'file://')) return null;
      return { 'Access-Control-Allow-Origin': origin || 'null', Vary: 'Origin', 'Cache-Control': 'no-store' };
    },
    clear() { files.clear(); ids.clear(); },
  };
}
module.exports = { createMediaAccess };
