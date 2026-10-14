/* Local logo assets and named templates. Photos are never stored here. */
(() => {
  'use strict';
  const DEFAULT = { id: 'default', name: '默认 Logo（示例）' };
  let store = { version: 1, logos: [], templates: [] }, ready = null, writing = Promise.resolve();
  const cache = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  async function init() {
    if (!ready) ready = (async () => {
      const response = await fetch('/brand-store', { cache: 'no-store' });
      if (!response.ok) throw new Error('品牌模板未能读取，请重新启动工具。');
      const value = await response.json();
      if (value.version !== 1 || !Array.isArray(value.logos) || !Array.isArray(value.templates)) throw new Error('品牌模板文件格式无效。');
      store = value;
    })().catch(error => { ready = null; throw error; });
    return ready;
  }
  function update(change) {
    const task = writing.catch(() => {}).then(async () => {
      await init();
      const next = clone(store), result = change(next);
      const response = await fetch('/brand-store', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Qingtu': '1' }, body: JSON.stringify(next) });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || '品牌模板未能保存，请确认工具文件夹可以写入。'); }
      store = await response.json();
      return result;
    });
    writing = task;
    return task;
  }
  // createImageBitmap instead of <img>.decode(): the latter waits for the page to be painted, so a batch started and then
  // left in a background window would stall at the first photo. Data URLs are converted by hand (the page's CSP blocks fetching them).
  async function sourceBlob(source) {
    if (!source.startsWith('data:')) { const response = await fetch(source); if (!response.ok) throw new Error(); return response.blob(); }
    const [head, payload] = source.split(','), binary = atob(payload), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: head.slice(5).split(';')[0] });
  }
  async function decode(source) {
    let image;
    try { image = await createImageBitmap(await sourceBlob(source)); } catch { throw new Error('Logo 图片无法读取，请重新导出透明 PNG。'); }
    if (!image.width || !image.height || image.width > 8192 || image.height > 8192 || image.width * image.height > 16000000) throw new Error('Logo 尺寸过大，请导出不超过 1600 万像素的 PNG。');
    const full = document.createElement('canvas'); full.width = image.width; full.height = image.height;
    const ctx = full.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0); image.close();
    const data = ctx.getImageData(0, 0, full.width, full.height).data;
    let left = full.width, top = full.height, right = 0, bottom = 0;
    for (let y = 0; y < full.height; y++) for (let x = 0; x < full.width; x++) if (data[(y * full.width + x) * 4 + 3] > 0) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
    if (right <= left || bottom <= top) throw new Error('Logo 是全透明的，请检查导出的图层。');
    const cropped = document.createElement('canvas'); cropped.width = right - left; cropped.height = bottom - top;
    cropped.getContext('2d').drawImage(full, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
    full.width = full.height = 1;
    return { image: cropped, width: cropped.width, height: cropped.height };
  }
  function getLogoInfo(id = 'default') {
    const item = id === 'default' ? DEFAULT : store.logos.find(x => x.id === id);
    return item ? { id: item.id, name: item.name } : null;
  }
  async function getLogo(id = 'default') {
    if (cache.has(id)) return cache.get(id);
    const promise = (async () => {
      if (id === 'default') return decode('assets/default-logo.png');
      await init();
      const item = store.logos.find(x => x.id === id);
      if (!item) throw new Error('这份模板的 Logo 不存在，请重新选择 Logo。');
      return decode(item.dataUrl);
    })().catch(error => { cache.delete(id); throw error; });
    cache.set(id, promise);
    return promise;
  }
  async function addLogo(file) {
    if (!file || file.size > 5 * 1024 * 1024) throw new Error('Logo 请使用不超过 5 MB 的透明 PNG。');
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (head.join(',') !== '137,80,78,71,13,10,26,10') throw new Error('Logo 请使用 PNG 文件。');
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Logo 文件读取失败。')); reader.readAsDataURL(file); });
    const decoded = await decode(dataUrl), id = 'logo-' + crypto.randomUUID(), name = file.name.replace(/\.png$/i, '').slice(0, 60) || '自定义 Logo';
    await update(next => { if (next.logos.length >= 12) throw new Error('已保存 12 个 Logo，请先在模板管理中删除不再使用的 Logo。'); next.logos.push({ id, name, dataUrl: decoded.image.toDataURL('image/png') }); });
    cache.set(id, Promise.resolve(decoded));
    return { id, name };
  }
  function normalizeSettings(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模板设置无效。');
    // Rotation and brush strokes belong to individual photos, not reusable templates.
    const value = {}, ranges = { width:[300,4000], height:[300,4000], scale:[.2,.96], shadow:[0,1.6], shadowRange:[.3,2], shadowSoftness:[0,1], quality:[.5,1], offsetX:[-.5,.5], offsetY:[-.5,.5], exposure:[-1.5,1.5], contrast:[-50,50], temperature:[-50,50], saturation:[-50,50], logoX:[0,1], logoY:[0,1], logoWidth:[.02,.8], logoOpacity:[0,1] };
    for (const [key, [min,max]] of Object.entries(ranges)) if (raw[key] !== undefined) {
      const number = Number(raw[key]); if (!Number.isFinite(number) || number < min || number > max || ((key === 'width' || key === 'height') && !Number.isInteger(number))) throw new Error('模板中的尺寸或参数无效。'); value[key] = number;
    }
    value.shadowMode = raw.shadowMode ?? 'contact';
    if (!['contact','original','none'].includes(value.shadowMode)) throw new Error('模板阴影模式无效。');
    // Brush strokes belong to one photograph and must never enter a reusable template.
    if (!/^#[0-9a-f]{6}$/i.test(raw.background || '')) throw new Error('模板背景色无效。'); value.background = raw.background;
    if (!['jpeg','png'].includes(raw.format)) throw new Error('模板导出格式无效。'); value.format = raw.format;
    value.logoEnabled = raw.logoEnabled !== false; value.logoId = String(raw.logoId || 'default');
    if (value.logoId !== 'default' && !store.logos.some(x => x.id === value.logoId)) throw new Error('请先上传这份模板使用的 Logo。');
    return value;
  }
  async function saveTemplate(name, settings) {
    name = String(name || '').trim().slice(0, 40); if (!name) throw new Error('请给模板起个名字。');
    await init(); const normalized = normalizeSettings(settings);
    return update(next => {
      const existing = next.templates.find(x => x.name === name);
      if (!existing && next.templates.length >= 20) throw new Error('最多保存 20 个模板，请先删除不再使用的模板。');
      const template = { id: existing?.id || 'template-' + crypto.randomUUID(), name, settings: normalized };
      if (existing) next.templates[next.templates.indexOf(existing)] = template; else next.templates.push(template);
      return clone(template);
    });
  }
  async function listTemplates() { await init(); return clone(store.templates); }
  async function deleteTemplate(id) { return update(next => { next.templates = next.templates.filter(x => x.id !== id); }); }
  async function listLogos() { await init(); return [DEFAULT, ...store.logos.map(({id,name}) => ({id,name}))]; }
  async function deleteLogo(id) {
    if (id === 'default') throw new Error('默认 Logo 会随工具保留。');
    return update(next => { if (next.templates.some(x => x.settings.logoId === id)) throw new Error('有模板正在使用这个 Logo，请先删除对应模板。'); next.logos = next.logos.filter(x => x.id !== id); cache.delete(id); });
  }
  window.GrayAssets = Object.freeze({ init, getLogo, getLogoInfo, addLogo, saveTemplate, listTemplates, deleteTemplate, listLogos, deleteLogo });
})();
