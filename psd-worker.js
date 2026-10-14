/* One export per disposable worker. All dependencies are bundled locally. */
'use strict';
importScripts('./vendor/ag-psd-31.0.3.js');
agPsd.initializeCanvas((w, h) => new OffscreenCanvas(w, h));
let plan = null, psd = null, composite = null, count = 0, layerId = 1, srgbProfile = null;
// ag-psd does not yet write ICC resources through its public API. Insert the
// standard 1039 resource without changing the pinned third-party bundle.
function embedSrgb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lengthOffset = 30 + view.getUint32(26), resourceLength = view.getUint32(lengthOffset);
  const insertAt = lengthOffset + 4 + resourceLength, length = 12 + srgbProfile.length + (srgbProfile.length % 2);
  const result = new Uint8Array(bytes.length + length), output = new DataView(result.buffer);
  result.set(bytes.subarray(0, insertAt));
  result.set([0x38, 0x42, 0x49, 0x4d, 0x04, 0x0f, 0, 0], insertAt);
  output.setUint32(insertAt + 8, srgbProfile.length);
  result.set(srgbProfile, insertAt + 12);
  result.set(bytes.subarray(insertAt), insertAt + length);
  output.setUint32(lengthOffset, resourceLength + length);
  return result;
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      plan = data.plan;
      if (!plan || plan.width * plan.height > 25000000 || plan.count > 12 || plan.count < 1) throw new Error('PSD 画板数量或尺寸无效。');
      const profileResponse = await fetch('./assets/srgb.icc');
      if (!profileResponse.ok) throw new Error('PSD 色彩配置文件未能加载。');
      srgbProfile = new Uint8Array(await profileResponse.arrayBuffer());
      if (srgbProfile.length < 128 || String.fromCharCode(...srgbProfile.subarray(36, 40)) !== 'acsp') throw new Error('PSD 色彩配置文件无效。');
      composite = new OffscreenCanvas(plan.width, plan.height);
      psd = { width: plan.width, height: plan.height, bitsPerChannel: 8, colorMode: 3, children: [],
        artboards: { count: plan.count, autoExpandOffset: { horizontal: 0, vertical: 0 }, origin: { horizontal: 0, vertical: 0 },
          autoExpandEnabled: false, autoNestEnabled: false, autoPositionEnabled: false, shrinkwrapOnSaveEnabled: false,
          docDefaultNewArtboardBackgroundType: 1, docDefaultNewArtboardBackgroundColor: { r: 230, g: 230, b: 230 } },
        imageResources: { resolutionInfo: { horizontalResolution: 72, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: 72, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } } };
    } else if (data.type === 'add') {
      if (!psd || data.index !== count) throw new Error('画板顺序不一致，请重新导出。');
      const board = plan.artboards[count];
      // Photoshop's physical records are bottom-to-top. Our render API is
      // top-to-bottom; ag-psd serializes its array without reversing it.
      const children = [...data.layers].reverse().map(layer => ({ ...layer, id: layerId++ }));
      psd.children.push({ id: layerId++, name: board.name, opened: false, blendMode: 'pass through',
        artboard: { rect: { left: board.left, top: board.top, right: board.left + board.width, bottom: board.top + board.height }, backgroundType: 1, color: { r: 230, g: 230, b: 230 } }, children });
      const image = data.composite;
      if (image.width !== board.width || image.height !== board.height) throw new Error('画板预览尺寸无效。');
      composite.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data.buffer), image.width, image.height), board.left, board.top);
      count++;
    } else if (data.type === 'finish') {
      if (!psd || count !== plan.count) throw new Error('照片还没有全部准备完成。');
      // Keep board 01 at the top of Photoshop's Layers panel.
      psd.children.reverse();
      psd.imageData = composite.getContext('2d').getImageData(0, 0, plan.width, plan.height);
      const bytes = embedSrgb(agPsd.writePsdUint8Array(psd, { noBackground: true, generateThumbnail: true }));
      if (bytes.byteLength > 1500000000) throw new Error('PSD 文件过大，请分成两组导出。');
      self.postMessage({ id: data.id, bytes }, [bytes.buffer]);
      composite.width = composite.height = 1; composite = null; psd = null;
      return;
    } else throw new Error('未知 PSD 导出操作。');
    self.postMessage({ id: data.id, ok: true });
  } catch (error) { self.postMessage({ id: data.id, error: error?.message || 'PSD 写入失败。' }); }
};
