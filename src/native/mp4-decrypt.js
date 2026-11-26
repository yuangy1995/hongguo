// 纯 MP4 CENC-AES-CTR 解密模块（无网络库依赖，供 Worker 线程零开销加载）
const fs = require('node:fs');
const crypto = require('node:crypto');

// 复用 16 字节计数器缓冲区，前 8 字节存放 sample IV，后 8 字节保持为 0（从第 0 块开始大端递增）
const SCRATCH_IV = Buffer.alloc(16);

/**
 * 使用原生 OpenSSL/BoringSSL AES-128-CTR 解密单个音视频 sample
 */
function decryptSample(key, nonce, cipher) {
  if (!cipher || cipher.length === 0) return Buffer.alloc(0);
  SCRATCH_IV.fill(0);
  nonce.copy(SCRATCH_IV, 0, 0, Math.min(8, nonce.length));
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, SCRATCH_IV);
  const first = decipher.update(cipher);
  const tail = decipher.final();
  return tail.length === 0 ? first : Buffer.concat([first, tail]);
}

/**
 * MP4 Box 结构解析
 */
function parseBoxes(data, start, end) {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = data.readUInt32BE(off);
    const typ = data.subarray(off + 4, off + 8).toString('latin1');
    let hdr = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hdr || off + size > end) break;
    let children = null;
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta'].includes(typ)) {
      children = parseBoxes(data, off + hdr, off + size);
    }
    boxes.push({ typ, off, size, hdr, children });
    off += size;
  }
  return boxes;
}

/**
 * 重建去除加密描述符后的 moov box，并修正后续 chunk 偏移
 */
function rebuildMoov(data, moovOff, moovSize, top) {
  const moovBox = top.find(b => b.typ === 'moov');
  if (!moovBox) throw new Error('no moov box');

  function clone(box) {
    return {
      typ: box.typ,
      off: box.off,
      size: box.size,
      hdr: box.hdr,
      children: box.children ? box.children.map(clone) : null,
    };
  }

  function prune(box) {
    if (!box.children) return box;
    const keep = [];
    for (const c of box.children) {
      if (['senc', 'saio', 'saiz', 'sgpd', 'sbgp'].includes(c.typ)) continue;
      keep.push(prune(c));
    }
    box.children = keep;
    return box;
  }

  const tree = prune(clone(moovBox));

  function* walkChildren(box) {
    for (const c of (box.children || [])) {
      yield c;
      for (const x of walkChildren(c)) yield x;
    }
  }

  const patches = {};
  for (const b of walkChildren(tree)) {
    if (b.typ === 'stsd') {
      const content = b.off + 8;
      const count = data.readUInt32BE(content + 4);
      let p = content + 8;
      const entries = [];
      for (let i = 0; i < count; i++) {
        const esize = data.readUInt32BE(p);
        const etyp = data.subarray(p + 4, p + 8).toString('latin1');
        if (etyp === 'encv' || etyp === 'enca') {
          const hdrSize = etyp === 'encv' ? 78 : 28;
          const children = parseBoxes(data, p + 8 + hdrSize, p + esize);
          let newType = 'mp4a';
          if (etyp === 'encv') {
            const sinf = children.find(child => child.typ === 'sinf');
            const frma = sinf && parseBoxes(data, sinf.off + sinf.hdr, sinf.off + sinf.size).find(child => child.typ === 'frma');
            const original = frma && frma.size === frma.hdr + 4
              ? data.toString('latin1', frma.off + frma.hdr, frma.off + frma.hdr + 4) : null;
            const avc = children.some(child => child.typ === 'avcC');
            const hevc = children.some(child => child.typ === 'hvcC');
            newType = original || (avc && !hevc ? 'avc1' : hevc && !avc ? 'hvc1' : null);
            if (!['avc1', 'avc3', 'hvc1', 'hev1'].includes(newType)
              || (newType.startsWith('avc') ? !avc || hevc : !hevc || avc)) {
              throw new Error('无法确定加密视频的原始编码（codec），请更换片源重试。');
            }
          }
          const entry = Buffer.alloc(8 + hdrSize);
          entry.writeUInt32BE(0, 0);
          entry.write(newType, 4, 4, 'latin1');
          data.copy(entry, 8, p + 8, p + 8 + hdrSize);

          const entryExtra = Buffer.concat(children.filter(child => child.typ !== 'sinf')
            .map(child => data.subarray(child.off, child.off + child.size)));
          const fullEntry = Buffer.concat([entry, entryExtra]);
          fullEntry.writeUInt32BE(fullEntry.length, 0);
          entries.push(fullEntry);
        } else {
          entries.push(data.subarray(p, p + esize));
        }
        p += esize;
      }
      const stsdHdr = Buffer.alloc(16);
      data.copy(stsdHdr, 0, b.off, content + 8);
      stsdHdr.writeUInt32BE(entries.length, 12);
      const fullStsd = Buffer.concat([stsdHdr, ...entries]);
      fullStsd.writeUInt32BE(fullStsd.length, 0);
      patches[b.off] = fullStsd;
    }
  }

  function serialize(box) {
    if (!box.children) {
      return patches[box.off] || data.subarray(box.off, box.off + box.size);
    }
    const body = Buffer.concat(box.children.map(serialize));
    const hdrb = Buffer.alloc(box.hdr);
    data.copy(hdrb, 0, box.off, box.off + box.hdr);
    if (box.hdr === 8) {
      hdrb.writeUInt32BE(8 + body.length, 0);
    } else {
      hdrb.writeUInt32BE(1, 0);
      hdrb.writeBigUInt64BE(BigInt(16 + body.length), 8);
    }
    return Buffer.concat([hdrb, body]);
  }

  const first = serialize(tree);
  const delta = moovSize - first.length;

  for (const b of walkChildren(tree)) {
    if (b.typ === 'stco') {
      const nc = data.readUInt32BE(b.off + 12);
      for (let i = 0; i < nc; i++) {
        const v = data.readUInt32BE(b.off + 16 + i * 4);
        if (v >= moovOff + moovSize) {
          data.writeUInt32BE(v - delta, b.off + 16 + i * 4);
        }
      }
    }
  }

  return serialize(tree);
}

/**
 * 解密 CENC-AES-CTR 加密的 MP4（内存版）
 */
function decryptMp4Buffer(data, key) {
  const total = data.length;
  const top = parseBoxes(data, 0, total);
  const moov = top.find(b => b.typ === 'moov');
  if (!moov) throw new Error('no moov box found in MP4');

  const getBox = (boxes, typ) => (boxes || []).find(b => b.typ === typ);

  function* walkBoxes(boxes) {
    for (const b of boxes) {
      if (b.children) {
        for (const x of walkBoxes(b.children)) yield x;
      }
      yield b;
    }
  }

  const stbls = Array.from(walkBoxes(top)).filter(b => b.typ === 'stbl');
  const trackInfo = [];
  for (const stbl of stbls) {
    const stsz = getBox(stbl.children, 'stsz');
    const stco = getBox(stbl.children, 'stco');
    const stsc = getBox(stbl.children, 'stsc');
    const senc = getBox(stbl.children, 'senc');
    if (!stsz || !stco || !stsc) continue;

    const ss = data.readUInt32BE(stsz.off + 12);
    const n = data.readUInt32BE(stsz.off + 16);
    const sizes = new Uint32Array(n);
    if (ss === 0) {
      for (let i = 0; i < n; i++) {
        sizes[i] = data.readUInt32BE(stsz.off + 20 + i * 4);
      }
    } else {
      sizes.fill(ss);
    }

    const nc = data.readUInt32BE(stco.off + 12);
    const chunkOffs = new Uint32Array(nc);
    for (let i = 0; i < nc; i++) {
      chunkOffs[i] = data.readUInt32BE(stco.off + 16 + i * 4);
    }

    const ns = data.readUInt32BE(stsc.off + 12);
    const stscTab = new Array(ns);
    for (let i = 0; i < ns; i++) {
      stscTab[i] = [
        data.readUInt32BE(stsc.off + 16 + i * 12),
        data.readUInt32BE(stsc.off + 20 + i * 12),
        data.readUInt32BE(stsc.off + 24 + i * 12),
      ];
    }

    const ivs = [];
    if (senc) {
      const sc = data.readUInt32BE(senc.off + 12);
      for (let i = 0; i < sc; i++) {
        ivs.push(data.subarray(senc.off + 16 + i * 8, senc.off + 24 + i * 8));
      }
    }

    const chunkSpc = new Uint32Array(nc);
    for (let i = 0; i < stscTab.length; i++) {
      const fc = stscTab[i][0];
      const spc = stscTab[i][1];
      const nxt = (i + 1 < stscTab.length) ? stscTab[i + 1][0] : (nc + 1);
      const endCi = Math.min(nc, nxt - 1);
      for (let ci = Math.max(0, fc - 1); ci < endCi; ci++) {
        chunkSpc[ci] = spc;
      }
    }

    const sampleOffs = new Uint32Array(n);
    let si = 0;
    for (let ci = 0; ci < nc && si < n; ci++) {
      let off = chunkOffs[ci];
      const spc = chunkSpc[ci] || 1;
      for (let s = 0; s < spc && si < n; s++) {
        sampleOffs[si] = off;
        off += sizes[si];
        si++;
      }
    }

    trackInfo.push({ sizes, offs: sampleOffs, count: si, ivs, stco });
  }

  for (const ti of trackInfo) {
    const limit = Math.min(ti.count, ti.ivs.length);
    for (let i = 0; i < limit; i++) {
      const off = ti.offs[i];
      const sz = ti.sizes[i];
      if (sz === 0 || off + sz > total) continue;
      const plain = decryptSample(key, ti.ivs[i], data.subarray(off, off + sz));
      plain.copy(data, off);
    }
  }

  const newMoov = rebuildMoov(data, moov.off, moov.size, top);
  const out = [];
  let off = 0;
  while (off < total) {
    let size = data.readUInt32BE(off);
    const typ = data.subarray(off + 4, off + 8).toString('latin1');
    if (size === 1) {
      size = Number(data.readBigUInt64BE(off + 8));
    } else if (size === 0) {
      size = total - off;
    }
    if (typ === 'moov') {
      out.push(newMoov);
    } else {
      out.push(data.subarray(off, off + size));
    }
    off += size;
  }

  return Buffer.concat(out);
}

/**
 * 解密 MP4 文件并保存
 */
function decryptMp4File(srcPath, dstPath, key) {
  const data = fs.readFileSync(srcPath);
  const finalBuf = decryptMp4Buffer(data, key);
  fs.writeFileSync(dstPath, finalBuf);
}

module.exports = {
  decryptSample,
  decryptMp4Buffer,
  decryptMp4File,
};
