/* Local layered PSD export. Raster preparation is sequential; PSD encoding is
 * isolated in a disposable worker so the editor stays responsive/cancellable. */
(() => {
  'use strict';
  const LIMITS = Object.freeze({ count: 12, boardPixels: 20000000, documentPixels: 25000000 });
  let exporting = false;
  const abortError = () => new DOMException('已取消 PSD 导出，照片和修改仍然保留。', 'AbortError');
  function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
  function describeGroup(entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('请先完成至少一张照片。');
    if (entries.length > LIMITS.count) throw new Error('每组最多导出 12 张照片。');
    const sizes = entries.map(entry => {
      const width = Number(entry.settings?.width ?? 900), height = Number(entry.settings?.height ?? 1200);
      if (![width, height].every(n => Number.isInteger(n) && n >= 300 && n <= 4000)) throw new Error('画板尺寸应在 300 到 4000 像素之间。');
      return { width, height };
    });
    const columns = Math.min(5, entries.length), rows = Math.ceil(entries.length / columns), gap = 80;
    const cellWidth = Math.max(...sizes.map(s => s.width)), cellHeight = Math.max(...sizes.map(s => s.height));
    const width = columns * cellWidth + (columns - 1) * gap, height = rows * cellHeight + (rows - 1) * gap;
    const pixelCount = sizes.reduce((sum, s) => sum + s.width * s.height, 0);
    if (pixelCount > LIMITS.boardPixels || width * height > LIMITS.documentPixels) throw new Error('这组画板尺寸较大，请减少照片数量或改用 900 × 1200 后再导出 PSD。');
    const artboards = entries.map((entry, i) => ({
      name: String(i + 1).padStart(2, '0') + ' · ' + String(entry.name || '照片').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f]/g, '').slice(0, 100),
      left: (i % columns) * (cellWidth + gap), top: Math.floor(i / columns) * (cellHeight + gap), ...sizes[i],
    }));
    return { width, height, count: entries.length, columns, rows, artboards, pixelCount };
  }
  function disposeLayers(rendered) {
    const canvases = new Set([rendered?.compositeCanvas, ...(rendered?.layers || []).flatMap(l => [l.canvas, l.maskCanvas])]);
    for (const canvas of canvases) if (canvas) canvas.width = canvas.height = 1;
  }
  function packLayer(layer, board) {
    if (!layer.canvas || !Number.isInteger(layer.left ?? 0) || !Number.isInteger(layer.top ?? 0)) throw new Error('PSD 图层位置无效，请重试。');
    const x = layer.left || 0, y = layer.top || 0;
    const left = Math.max(0, x), top = Math.max(0, y);
    const right = Math.min(board.width, x + layer.canvas.width), bottom = Math.min(board.height, y + layer.canvas.height);
    if (right <= left || bottom <= top) return null;
    const width = right - left, height = bottom - top;
    const imageData = layer.canvas.getContext('2d').getImageData(left - x, top - y, width, height);
    const packed = { name: layer.name, left: board.left + left, top: board.top + top, imageData,
      opacity: layer.opacity ?? 1, hidden: !!layer.hidden, blendMode: layer.blendMode || 'normal' };
    if (layer.maskCanvas) {
      if (layer.maskCanvas.width !== layer.canvas.width || layer.maskCanvas.height !== layer.canvas.height) throw new Error('PSD 蒙版尺寸与图层不一致。');
      packed.mask = { left: packed.left, top: packed.top, defaultColor: layer.maskDefaultColor ?? 0,
        imageData: layer.maskCanvas.getContext('2d').getImageData(left - x, top - y, width, height) };
    }
    return packed;
  }
  async function exportGroup(entries, options = {}) {
    if (exporting) throw new Error('已有一组 PSD 正在导出，请稍候。');
    const plan = describeGroup(entries), signal = options.signal, progress = options.onProgress || (() => {});
    checkAbort(signal);
    if (!window.GrayEngine?.renderLayers) throw new Error('PSD 分层组件未能加载，请重新打开工具。');
    if (!window.Worker) throw new Error('当前浏览器不支持 PSD 导出，请使用新版 Edge 或 Chrome。');
    exporting = true;
    let worker, waiting = null, nextId = 0, terminalError = null;
    const rejectWaiting = error => { terminalError = error; if (waiting) { const current = waiting; waiting = null; clearTimeout(current.timer); current.reject(error); } };
    const cancel = () => { rejectWaiting(abortError()); worker?.terminate(); };
    const request = (type, payload = {}, transfer = []) => new Promise((resolve, reject) => {
      if (terminalError) { reject(terminalError); return; }
      const id = ++nextId;
      const timer = setTimeout(() => { rejectWaiting(new Error('PSD 导出耗时过长，请减少本组照片数量后重试。')); worker?.terminate(); }, 180000);
      waiting = { id, resolve, reject, timer };
      try { worker.postMessage({ type, id, ...payload }, transfer); } catch (error) { rejectWaiting(error); }
    });
    try {
      worker = new Worker('./psd-worker.js');
      worker.onerror = event => { event.preventDefault(); rejectWaiting(new Error('PSD 写入组件未能运行，请重新打开工具后重试。')); };
      worker.onmessage = ({ data }) => {
        if (!waiting || data.id !== waiting.id) return;
        const current = waiting; waiting = null; clearTimeout(current.timer);
        data.error ? current.reject(new Error(data.error)) : current.resolve(data);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      checkAbort(signal);
      await request('init', { plan });
      for (let i = 0; i < entries.length; i++) {
        checkAbort(signal);
        progress({ stage: 'layers', completed: i, total: entries.length, message: '正在准备画板 ' + (i + 1) + ' / ' + entries.length });
        await new Promise(resolve => setTimeout(resolve, 0));
        let rendered;
        try {
          checkAbort(signal);
          rendered = await GrayEngine.renderLayers(entries[i].prepared, entries[i].settings);
          checkAbort(signal);
          const board = plan.artboards[i];
          if (rendered.width !== board.width || rendered.height !== board.height || !rendered.compositeCanvas) throw new Error('画板尺寸发生变化，请重新导出。');
          const layers = rendered.layers.map(layer => packLayer(layer, board)).filter(Boolean);
          const composite = rendered.compositeCanvas.getContext('2d').getImageData(0, 0, board.width, board.height);
          const transfers = [composite.data.buffer];
          for (const layer of layers) { transfers.push(layer.imageData.data.buffer); if (layer.mask) transfers.push(layer.mask.imageData.data.buffer); }
          disposeLayers(rendered); rendered = null;
          await request('add', { index: i, layers, composite }, transfers);
        } finally { disposeLayers(rendered); }
      }
      checkAbort(signal);
      progress({ stage: 'encode', completed: entries.length, total: entries.length, message: '正在写入 PSD 文件…' });
      const result = await request('finish');
      checkAbort(signal);
      return new Blob([result.bytes], { type: 'image/vnd.adobe.photoshop' });
    } finally {
      worker?.terminate(); signal?.removeEventListener('abort', cancel);
      if (waiting) clearTimeout(waiting.timer);
      waiting = null; exporting = false;
    }
  }
  window.GrayPsd = Object.freeze({ describeGroup, exportGroup, limits: LIMITS });
})();
