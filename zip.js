/* PhotoCore — dependency-free browser image processing, all work stays on this device.
 * resizeImage(Blob|File, {maxEdge:2048, quality:0.9, format:'jpeg'|'png'|'webp'}, signal?)
 *   => Promise<{blob,width,height,originalWidth,originalHeight,resized,keptOriginal}>.
 *   Dimensions are visually oriented pixels. Never upscales; normalizes EXIF orientation.
 * makeZip([{name,blob}], progress?) => Promise<Blob> (ZIP STORE, UTF-8 filenames).
 *   progress({completed,total,percent,name}); empty entries produce a valid empty ZIP.
 * sanitizePath(path) => safe relative path, preserving subdirectories.
 * uniqueName(path, usedSet) => safe unique path; reserves its lowercase spelling in usedSet.
 * Browser requirements: Canvas, Blob, TextEncoder; createImageBitmap or HTMLImageElement.
 */
(function (root) {
  'use strict';
  const MAX_PIXELS = 80000000;
  const ZIP_LIMIT = 0x100000000;
  const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const encoder = new TextEncoder();

  function abort(signal) {
    if (signal && signal.aborted) throw new DOMException('处理已取消', 'AbortError');
  }
  function sanitizePath(value) {
    let path = String(value == null ? '' : value).normalize('NFC').replace(/\\/g, '/');
    path = path.replace(/^[a-z]:/i, '').replace(/^\/+/, '');
    const parts = [];
    for (let part of path.split('/')) {
      if (!part || part === '.' || part === '..') continue;
      part = part.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/[. ]+$/g, '').trim();
      if (!part || part === '.' || part === '..') continue;
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) part = '_' + part;
      // Keep paths portable without cutting a Unicode surrogate pair.
      if (Array.from(part).length > 180) {
        const dot = part.lastIndexOf('.');
        const ext = dot > 0 && part.length - dot <= 12 ? part.slice(dot) : '';
        part = Array.from(ext ? part.slice(0, dot) : part).slice(0, 180 - ext.length).join('') + ext;
      }
      parts.push(part);
    }
    return parts.join('/') || 'image';
  }
  function uniqueName(path, usedSet) {
    if (!(usedSet && typeof usedSet.add === 'function' && typeof usedSet.has === 'function')) {
      throw new TypeError('uniqueName 需要一个 Set');
    }
    const safe = sanitizePath(path);
    const occupied = new Set(Array.from(usedSet, x => String(x).toLowerCase()));
    const slash = safe.lastIndexOf('/');
    const dot = safe.lastIndexOf('.');
    const split = dot > slash + 1 ? dot : safe.length;
    let candidate = safe, index = 2;
    while (occupied.has(candidate.toLowerCase())) {
      candidate = safe.slice(0, split) + ' (' + index++ + ')' + safe.slice(split);
    }
    usedSet.add(candidate.toLowerCase());
    return candidate;
  }

  function exifOrientation(bytes) {
    let base = 0;
    if (bytes.length >= 6 && ascii(bytes, 0, 6) === 'Exif\0\0') base = 6;
    if (bytes.length < base + 8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = ascii(bytes, base, 2) === 'II';
    if (!little && ascii(bytes, base, 2) !== 'MM') return null;
    if (view.getUint16(base + 2, little) !== 42) return null;
    const ifd = base + view.getUint32(base + 4, little);
    if (ifd < base + 8 || ifd + 2 > bytes.length) return null;
    const count = view.getUint16(ifd, little);
    if (ifd + 2 + count * 12 > bytes.length) return null;
    for (let i = 0; i < count; i++) {
      const pos = ifd + 2 + i * 12;
      if (view.getUint16(pos, little) === 0x112) {
        if (view.getUint16(pos + 2, little) !== 3 || view.getUint32(pos + 4, little) !== 1) return null;
        const orientation = view.getUint16(pos + 8, little);
        return orientation >= 1 && orientation <= 8 ? orientation : null;
      }
    }
    return 1;
  }
  function ascii(bytes, offset, length) {
    let out = '';
    for (let i = offset; i < offset + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
  function metadata(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const info = { format: '', width: 0, height: 0, orientation: 1, animated: false };
    const applyExif = exif => {
      const value = exifOrientation(exif);
      if (value === null || info.orientation === null) info.orientation = null;
      else if (value !== 1) info.orientation = value;
    };
    if (bytes.length >= 24 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') {
      info.format = 'png';
      if (ascii(bytes, 12, 4) !== 'IHDR') throw new Error('PNG 文件头损坏，无法读取图片。');
      info.width = view.getUint32(16); info.height = view.getUint32(20);
      for (let pos = 8; pos + 12 <= bytes.length;) {
        const size = view.getUint32(pos), type = ascii(bytes, pos + 4, 4);
        if (pos + 12 + size > bytes.length) break;
        if (type === 'eXIf') applyExif(bytes.subarray(pos + 8, pos + 8 + size));
        if (type === 'acTL') info.animated = true;
        if (type === 'IEND') break;
        pos += 12 + size;
      }
    } else if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
      info.format = 'webp';
      const uint24 = pos => bytes[pos] + bytes[pos + 1] * 256 + bytes[pos + 2] * 65536;
      for (let pos = 12; pos + 8 <= bytes.length;) {
        const type = ascii(bytes, pos, 4), size = view.getUint32(pos + 4, true), data = pos + 8;
        if (data + size > bytes.length) break;
        if (type === 'VP8X' && size >= 10) {
          info.width = uint24(data + 4) + 1; info.height = uint24(data + 7) + 1;
          info.animated = !!(bytes[data] & 2);
        } else if (type === 'VP8 ' && size >= 10 && !info.width) {
          info.width = view.getUint16(data + 6, true) & 0x3fff;
          info.height = view.getUint16(data + 8, true) & 0x3fff;
        } else if (type === 'VP8L' && size >= 5 && !info.width && bytes[data] === 0x2f) {
          const bits = view.getUint32(data + 1, true);
          info.width = (bits & 0x3fff) + 1; info.height = ((bits >>> 14) & 0x3fff) + 1;
        } else if (type === 'EXIF') applyExif(bytes.subarray(data, data + size));
        if (type === 'ANIM') info.animated = true;
        pos = data + size + (size & 1);
      }
    } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      info.format = 'jpeg';
      for (let pos = 2; pos + 1 < bytes.length;) {
        if (bytes[pos] !== 0xff) break;
        while (bytes[pos] === 0xff) pos++;
        const marker = bytes[pos++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 1 || (marker >= 0xd0 && marker <= 0xd8)) continue;
        if (pos + 2 > bytes.length) break;
        const size = view.getUint16(pos);
        if (size < 2 || pos + size > bytes.length) break;
        if (marker === 0xe1 && ascii(bytes, pos + 2, 6) === 'Exif\0\0') applyExif(bytes.subarray(pos + 2, pos + size));
        if (size >= 7 && marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          info.height = view.getUint16(pos + 3); info.width = view.getUint16(pos + 5);
        }
        pos += size;
      }
    } else {
      throw new Error('不支持此图片格式。请选择 JPG、PNG 或 WebP 静态图片。');
    }
    if (info.animated) throw new Error('暂不支持动态图片。请选择 JPG、PNG 或 WebP 静态图片。');
    if (!info.width || !info.height) throw new Error('图片尺寸无法读取，文件可能已损坏。');
    checkPixels(info.width, info.height);
    return info;
  }
  function checkPixels(width, height) {
    if (width * height > MAX_PIXELS) throw new Error('图片超过 8000 万像素，请先缩小原图后再处理。');
  }
  async function decode(file, signal) {
    if (typeof root.createImageBitmap === 'function') {
      try {
        const bitmap = await root.createImageBitmap(file, { imageOrientation: 'from-image' });
        if (signal && signal.aborted) { bitmap.close(); abort(signal); }
        return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
      } catch (error) { if (error.name === 'AbortError') throw error; }
    }
    abort(signal);
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      let complete = false;
      const cleanup = () => {
        image.onload = image.onerror = null;
        if (signal) signal.removeEventListener('abort', cancelled);
        URL.revokeObjectURL(url);
      };
      const cancelled = () => {
        if (complete) return;
        complete = true; cleanup(); image.src = '';
        reject(new DOMException('处理已取消', 'AbortError'));
      };
      image.onload = () => {
        if (complete) return;
        complete = true; cleanup();
        resolve({ image, width: image.naturalWidth, height: image.naturalHeight, release: () => { image.src = ''; } });
      };
      image.onerror = () => {
        if (complete) return;
        complete = true; cleanup(); image.src = '';
        reject(new Error('图片无法解码，文件可能损坏或浏览器不支持。'));
      };
      if (signal) signal.addEventListener('abort', cancelled, { once: true });
      image.src = url;
    });
  }
  async function resizeImage(file, options = {}, signal) {
    abort(signal);
    if (!file || typeof file.arrayBuffer !== 'function' || !file.size) throw new Error('图片为空或无法读取。');
    if (file.type && !['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/octet-stream'].includes(file.type.toLowerCase())) {
      throw new Error('不支持此图片格式。请选择 JPG、PNG 或 WebP 静态图片。');
    }
    let { maxEdge = 2048, quality = 0.9, format = 'jpeg' } = options;
    if (format === 'jpg') format = 'jpeg';
    maxEdge = Number(maxEdge); quality = Number(quality);
    if (!Number.isInteger(maxEdge) || maxEdge < 1 || maxEdge > 16384) throw new Error('最长边应为 1 至 16384 的整数。');
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new Error('图片质量应在 0 至 1 之间。');
    if (!MIME[format]) throw new Error('输出格式仅支持 JPG、PNG 或 WebP。');
    let bytes = new Uint8Array(await file.arrayBuffer());
    abort(signal);
    const info = metadata(bytes);
    bytes = null;
    const decoded = await decode(file, signal);
    let canvas;
    try {
      abort(signal);
      const originalWidth = decoded.width, originalHeight = decoded.height;
      if (!originalWidth || !originalHeight) throw new Error('图片尺寸无效。');
      checkPixels(originalWidth, originalHeight);
      const scale = Math.min(1, maxEdge / Math.max(originalWidth, originalHeight));
      const width = Math.max(1, Math.round(originalWidth * scale));
      const height = Math.max(1, Math.round(originalHeight * scale));
      const resized = width !== originalWidth || height !== originalHeight;
      canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { alpha: format !== 'jpeg' });
      if (!context) throw new Error('浏览器无法创建图片画布，请减少尺寸或更换浏览器。');
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      if (format === 'jpeg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); }
      context.drawImage(decoded.image, 0, 0, width, height);
      abort(signal);
      const encoded = await new Promise((resolve, reject) => canvas.toBlob(blob => {
        if (blob) resolve(blob); else reject(new Error('图片导出失败，请减少尺寸后重试。'));
      }, MIME[format], quality));
      abort(signal);
      if (encoded.type !== MIME[format]) throw new Error('此浏览器不支持所选输出格式，请选择 JPG 或 PNG。');
      const keptOriginal = !resized && info.format === format && info.orientation === 1 && encoded.size >= file.size;
      return { blob: keptOriginal ? file : encoded, width, height, originalWidth, originalHeight, resized, keptOriginal };
    } finally {
      decoded.release();
      if (canvas) { canvas.width = 1; canvas.height = 1; }
    }
  }

  const CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    CRC_TABLE[n] = value >>> 0;
  }
  async function crc32(blob) {
    let crc = 0xffffffff;
    for (let pos = 0; pos < blob.size; pos += 1024 * 1024) {
      const bytes = new Uint8Array(await blob.slice(pos, pos + 1024 * 1024).arrayBuffer());
      for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function makeZip(entries, onProgress) {
    if (!Array.isArray(entries)) throw new TypeError('ZIP 文件列表无效。');
    if (entries.length >= 65535) throw new Error('ZIP 最多支持 65534 个文件，请分批下载。');
    const records = [], used = new Set();
    let estimate = 22;
    for (const entry of entries) {
      if (!entry || !entry.blob || typeof entry.blob.slice !== 'function' || !Number.isSafeInteger(entry.blob.size) || entry.blob.size < 0) throw new Error('ZIP 中包含无法读取的文件。');
      const name = uniqueName(entry.name, used), nameBytes = encoder.encode(name);
      if (nameBytes.length > 65535) throw new Error('文件路径过长，请缩短名称后重试。');
      if (entry.blob.size >= ZIP_LIMIT) throw new Error('单个文件达到 4 GB，请分批下载。');
      estimate += 30 + 46 + 2 * nameBytes.length + entry.blob.size;
      if (estimate >= ZIP_LIMIT) throw new Error('ZIP 达到 4 GB，请减少文件数量并分批下载。');
      records.push({ name, nameBytes, blob: entry.blob });
    }
    const local = [], central = [];
    let offset = 0, completed = 0;
    const date = new Date();
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    for (const record of records) {
      const { nameBytes, blob, name } = record, crc = await crc32(blob);
      const header = new Uint8Array(30 + nameBytes.length), h = new DataView(header.buffer);
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
      h.setUint32(18, blob.size, true); h.setUint32(22, blob.size, true); h.setUint16(26, nameBytes.length, true);
      header.set(nameBytes, 30);
      const directory = new Uint8Array(46 + nameBytes.length), d = new DataView(directory.buffer);
      d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x0800, true);
      d.setUint16(12, dosTime, true); d.setUint16(14, dosDate, true); d.setUint32(16, crc, true);
      d.setUint32(20, blob.size, true); d.setUint32(24, blob.size, true); d.setUint16(28, nameBytes.length, true);
      d.setUint32(42, offset, true); directory.set(nameBytes, 46);
      local.push(header, blob); central.push(directory); offset += header.length + blob.size;
      completed++;
      if (typeof onProgress === 'function') onProgress({ completed, total: records.length, percent: completed / records.length * 100, name });
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, records.length, true); e.setUint16(10, records.length, true);
    e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
    return new Blob([...local, ...central, end], { type: 'application/zip' });
  }
  root.PhotoCore = Object.freeze({ resizeImage, makeZip, sanitizePath, uniqueName });
})(typeof window !== 'undefined' ? window : globalThis);
