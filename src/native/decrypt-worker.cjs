const { Worker, isMainThread, parentPort } = require('node:worker_threads');

const MAX_IDLE_WORKERS = 2;
const WORKER_IDLE_TTL_MS = 30_000;
const idleWorkers = [];
let nextTaskId = 1;

function createPooledWorker() {
  const worker = new Worker(__filename);
  const entry = { worker, idleTimer: null, dead: false };
  worker.once('exit', () => {
    entry.dead = true;
    clearTimeout(entry.idleTimer);
    const idx = idleWorkers.indexOf(entry);
    if (idx !== -1) idleWorkers.splice(idx, 1);
  });
  worker.unref();
  return entry;
}

function acquireWorker() {
  while (idleWorkers.length > 0) {
    const entry = idleWorkers.pop();
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (!entry.dead) {
      entry.worker.ref();
      return entry;
    }
  }
  const entry = createPooledWorker();
  entry.worker.ref();
  return entry;
}

function releaseWorker(entry) {
  if (!entry || entry.dead) return;
  if (idleWorkers.length >= MAX_IDLE_WORKERS) {
    entry.dead = true;
    void entry.worker.terminate();
    return;
  }
  entry.worker.unref();
  entry.idleTimer = setTimeout(() => {
    const idx = idleWorkers.indexOf(entry);
    if (idx !== -1) idleWorkers.splice(idx, 1);
    entry.dead = true;
    void entry.worker.terminate();
  }, WORKER_IDLE_TTL_MS);
  entry.idleTimer.unref?.();
  idleWorkers.push(entry);
}

// 媒体解析与逐帧解密在独立常驻 Worker 中执行，支持零拷贝 ArrayBuffer 传输且不阻塞主进程取消 IPC。
function decryptInWorker(payload, { signal, cancelToken, transferInput = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || cancelToken?.reason) return reject(new Error('已取消'));
    const entry = acquireWorker();
    const { worker } = entry;
    const id = nextTaskId++;
    let settled = false;

    const cleanupListeners = () => {
      signal?.removeEventListener('abort', cancel);
      cancelToken?.unsubscribe?.(cancel);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };

    const finish = async (error, result, terminateWorker = false) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      if (terminateWorker) {
        entry.dead = true;
        // 等待子线程完全停止后再返回，确保调用方随后清理临时文件时无写句柄残留
        await worker.terminate();
      } else {
        releaseWorker(entry);
      }
      if (error) reject(error);
      else if (result?.buffer) {
        const u8 = result.buffer;
        resolve(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));
      } else {
        resolve(undefined);
      }
    };

    const onMessage = msg => {
      if (!msg || msg.id !== id) return;
      void finish(msg.error ? new Error(msg.error) : null, msg, false);
    };
    const onError = error => void finish(error, null, true);
    const onExit = code => {
      if (!settled) void finish(new Error(`视频处理意外中断（${code}）`), null, false);
    };
    const cancel = () => { void finish(new Error('已取消'), null, true); };

    signal?.addEventListener('abort', cancel, { once: true });
    cancelToken?.subscribe?.(cancel);
    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);

    if (signal?.aborted || cancelToken?.reason) {
      cancel();
      return;
    }

    const transferList = [];
    const message = { id, key: payload.key };
    if (payload.srcPath) {
      message.srcPath = payload.srcPath;
      message.dstPath = payload.dstPath;
    } else if (payload.buffer) {
      const buf = payload.buffer;
      message.buffer = buf;
      // 仅当调用方明确放弃所有权且底层 ArrayBuffer 非共享池切片时执行零拷贝转移
      if (transferInput && ArrayBuffer.isView(buf) && buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
        transferList.push(buf.buffer);
      }
    }
    worker.postMessage(message, transferList);
  });
}

if (!isMainThread) {
  const mp4Decrypt = require('./mp4-decrypt');
  parentPort.on('message', job => {
    const { id } = job;
    try {
      const key = Buffer.isBuffer(job.key) ? job.key : Buffer.from(job.key.buffer, job.key.byteOffset, job.key.byteLength);
      if (job.srcPath) {
        mp4Decrypt.decryptMp4File(job.srcPath, job.dstPath, key);
        parentPort.postMessage({ id, done: true });
      } else {
        const u8 = job.buffer;
        const input = Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
        const result = mp4Decrypt.decryptMp4Buffer(input, key);
        // 大体积视频 Buffer 独占底层 ArrayBuffer，直接零拷贝转移回主线程；小尺寸池化切片安全拷贝后转移
        const out = (result.byteOffset === 0 && result.byteLength === result.buffer.byteLength)
          ? result
          : Uint8Array.prototype.slice.call(result);
        parentPort.postMessage({ id, buffer: out }, [out.buffer]);
      }
    } catch (error) {
      parentPort.postMessage({ id, error: error.message });
    }
  });
}

module.exports = { decryptInWorker };
