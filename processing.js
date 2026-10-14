/*
 * Gray Studio — local, deterministic photographic compositing.
 * The color-unmix equation follows the method documented by Color Unmix:
 * https://github.com/dunkel-Stern/photoshop-color-unmix
 * C = alpha * F + (1-alpha) * B. No Photoshop APIs are required.
 * The segmentation protects opaque product RGB; only edge pixels are unmixed.
 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const pointBasis = (x, y) => [1, x, y, x * y, x * x, y * y];
  const evaluate = (c, x, y) => clamp(c[0] + c[1] * x + c[2] * y + c[3] * x * y + c[4] * x * x + c[5] * y * y, 150, 255);
  const quantile = (values, q) => {
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[Math.min(values.length - 1, Math.floor((values.length - 1) * q))];
  };
  const bboxGap = (a, b) => Math.hypot(Math.max(0, a.x - b.right, b.x - a.right), Math.max(0, a.y - b.bottom, b.y - a.bottom));

  function components(width, height, include, pixelVisit) {
    const n = width * height, labels = new Int32Array(n), queue = new Int32Array(n), result = [];
    let id = 0;
    for (let start = 0; start < n; start++) {
      if (labels[start] || !include(start)) continue;
      id++;
      let head = 0, tail = 1;
      queue[0] = start; labels[start] = id;
      const item = { id, area: 0, x: width, y: height, right: 0, bottom: 0, sumX: 0, sumY: 0, border: 0, dark: 0, near: 0, peak: 0 };
      while (head < tail) {
        const i = queue[head++], x = i % width, y = (i / width) | 0;
        item.area++; item.sumX += x; item.sumY += y;
        item.x = Math.min(item.x, x); item.y = Math.min(item.y, y);
        item.right = Math.max(item.right, x + 1); item.bottom = Math.max(item.bottom, y + 1);
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) item.border++;
        if (pixelVisit) pixelVisit(item, i);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, j = yy * width + xx;
            if ((!dx && !dy) || xx < 0 || xx >= width || labels[j] || !include(j)) continue;
            labels[j] = id; queue[tail++] = j;
          }
        }
      }
      item.width = item.right - item.x; item.height = item.bottom - item.y;
      result.push(item);
    }
    return { labels, items: result };
  }

  // Two-pass chamfer distances retain the source coordinate system for the shoe
  // and shadow. They are not image-resampling operations.
  function distanceField(width, height, inside) {
    const d = new Float32Array(width * height), diagonal = Math.SQRT2;
    for (let i = 0; i < d.length; i++) d[i] = inside(i) ? 0 : 1e7;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x) d[i] = Math.min(d[i], d[i - 1] + 1);
      if (y) {
        d[i] = Math.min(d[i], d[i - width] + 1);
        if (x) d[i] = Math.min(d[i], d[i - width - 1] + diagonal);
        if (x + 1 < width) d[i] = Math.min(d[i], d[i - width + 1] + diagonal);
      }
    }
    for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x + 1 < width) d[i] = Math.min(d[i], d[i + 1] + 1);
      if (y + 1 < height) {
        d[i] = Math.min(d[i], d[i + width] + 1);
        if (x) d[i] = Math.min(d[i], d[i + width - 1] + diagonal);
        if (x + 1 < width) d[i] = Math.min(d[i], d[i + width + 1] + diagonal);
      }
    }
    return d;
  }

  function solve(matrix, vector) {
    const a = matrix.map((row, i) => [...row, vector[i]]), n = vector.length;
    for (let c = 0; c < n; c++) {
      let pivot = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
      [a[c], a[pivot]] = [a[pivot], a[c]];
      if (Math.abs(a[c][c]) < 1e-8) return null;
      const v = a[c][c];
      for (let j = c; j <= n; j++) a[c][j] /= v;
      for (let r = 0; r < n; r++) if (r !== c) {
        const f = a[r][c];
        for (let j = c; j <= n; j++) a[r][j] -= f * a[c][j];
      }
    }
    return a.map(row => row[n]);
  }

  function estimateBackground(rgba, width, height, mask, distances, bbox, warnings) {
    const grid = 16, cells = Array.from({ length: grid * grid }, () => []);
    const stride = Math.max(1, Math.floor(Math.sqrt(width * height / 70000)));
    const safeDistance = Math.max(2, Math.min(bbox.width, bbox.height) * 0.025);
    const padding = Math.max(bbox.width, bbox.height) * 0.65;
    let candidateCount = 0;
    for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
      const i = y * width + x, p = i * 4;
      if (mask[i] > 0.08 || distances[i] < safeDistance || rgba[p + 3] < 245) continue;
      if (x < bbox.x - padding || x > bbox.right + padding || y < bbox.y - padding || y > bbox.bottom + padding) continue;
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2], l = luminance(r, g, b);
      if (l < 180 || Math.max(r, g, b) - Math.min(r, g, b) > 32) continue;
      const cx = Math.min(grid - 1, (x / width * grid) | 0), cy = Math.min(grid - 1, (y / height * grid) | 0);
      cells[cy * grid + cx].push({ x: x / Math.max(1, width - 1) * 2 - 1, y: y / Math.max(1, height - 1) * 2 - 1, rgb: [r, g, b], l });
      candidateCount++;
    }
    const samples = [];
    for (const cell of cells) {
      if (cell.length < 3) continue;
      cell.sort((a, b) => a.l - b.l);
      // The upper middle of each small cell is robust to a shadow occupying its
      // lower tail, without selecting clipped specular highlights exclusively.
      const lo = Math.floor(cell.length * 0.65), hi = Math.max(lo + 1, Math.ceil(cell.length * 0.90));
      const sample = { x: 0, y: 0, rgb: [0, 0, 0], count: hi - lo };
      for (let k = lo; k < hi; k++) {
        sample.x += cell[k].x; sample.y += cell[k].y;
        for (let c = 0; c < 3; c++) sample.rgb[c] += cell[k].rgb[c];
      }
      sample.x /= sample.count; sample.y /= sample.count;
      sample.rgb = sample.rgb.map(v => v / sample.count);
      sample.basis = pointBasis(sample.x, sample.y);
      samples.push(sample);
    }
    if (samples.length < 8 || candidateCount < 40) throw new Error('未找到足够的浅色摄影背景。请使用背景较干净、主体完整的原图。');
    let coefficients = [0, 1, 2].map(c => [quantile(samples.map(s => s.rgb[c]), 0.7), 0, 0, 0, 0, 0]);
    let weights = new Float64Array(samples.length).fill(1);
    for (let iteration = 0; iteration < 5; iteration++) {
      const mat = Array.from({ length: 6 }, () => new Float64Array(6));
      const rhs = Array.from({ length: 3 }, () => new Float64Array(6));
      let weightSum = 0;
      for (let j = 0; j < samples.length; j++) {
        const s = samples[j], w = weights[j]; weightSum += w;
        for (let k = 0; k < 6; k++) {
          for (let l = 0; l < 6; l++) mat[k][l] += w * s.basis[k] * s.basis[l];
          for (let c = 0; c < 3; c++) rhs[c][k] += w * s.basis[k] * s.rgb[c];
        }
      }
      // Very mild curvature regularisation prevents empty corners overfitting.
      for (let k = 1; k < 6; k++) mat[k][k] += weightSum * (k > 2 ? 0.001 : 0.00005);
      coefficients = coefficients.map((old, c) => solve(mat, rhs[c]) || old);
      const residuals = samples.map(s => luminance(...s.rgb) - luminance(...coefficients.map(c => evaluate(c, s.x, s.y))));
      const spread = Math.max(0.9, quantile(residuals.map(v => Math.abs(v)), 0.5) * 1.4826);
      weights = Float64Array.from(residuals, r => r < -2 * spread ? 0.015 : r > 4 * spread ? 0.05 : 1);
    }
    const residuals = samples.map(s => Math.abs(luminance(...s.rgb) - luminance(...coefficients.map(c => evaluate(c, s.x, s.y)))));
    const error = quantile(residuals, 0.5), rgb = coefficients.map(c => evaluate(c, 0, 0));
    if (error > 5 || samples.length < 30) warnings.push('原背景明暗较不均匀，请重点检查鞋边和阴影区域。');
    return { coefficients, rgb, sampleCount: candidateCount, medianError: error };
  }

  function analyze(input) {
    const { width, height, mask } = input || {}, rgba = input && input.rgba;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || width * height > 25000000) throw new Error('图片尺寸无效或过大。');
    const n = width * height;
    if (!rgba || rgba.length !== n * 4 || !mask || mask.length !== n) throw new Error('图片像素与主体蒙版的尺寸不一致。');
    const warnings = [];
    let confident = 0;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(mask[i]) || mask[i] < 0 || mask[i] > 1) throw new Error('主体蒙版包含无效数值。');
      if (mask[i] >= 0.5 && rgba[i * 4 + 3] > 127) confident++;
    }
    if (confident < Math.max(12, n * 0.0005)) throw new Error('没有识别到可靠的鞋子主体。请换一张主体更清楚的原图。');
    if (confident > n * 0.96) throw new Error('主体识别覆盖了整张图片，无法可靠地替换背景。');
    const found = components(width, height, i => mask[i] >= 0.45 && rgba[i * 4 + 3] > 127, (item, i) => {
      const p = i * 4;
      if (luminance(rgba[p], rgba[p + 1], rgba[p + 2]) < 170) item.dark++;
    });
    for (const c of found.items) {
      const cx = c.sumX / c.area / width, cy = c.sumY / c.area / height;
      const centrality = Math.exp(-2.2 * ((cx - 0.5) ** 2 + (cy - 0.5) ** 2));
      const thin = Math.min(c.width, c.height) / Math.max(c.width, c.height);
      const borderPenalty = c.border ? (thin < 0.13 || c.width > width * 0.85 || c.height > height * 0.85 ? 0.04 : 0.45) : 1;
      c.score = c.area * centrality * (0.25 + 0.75 * c.dark / c.area) * borderPenalty;
      c.suspiciousBorder = borderPenalty < 0.1;
    }
    found.items.sort((a, b) => b.score - a.score);
    const main = found.items[0];
    if (!main || main.area < Math.max(12, n * 0.0005)) throw new Error('主体识别结果太小，无法输出可靠图片。');
    const selected = [main], keep = new Set([main.id]);
    for (const c of found.items.slice(1)) {
      if (selected.length >= 4) break;
      if (c.suspiciousBorder || c.area < Math.max(n * 0.0004, main.area * 0.035) || c.score < main.score * 0.05) continue;
      if (bboxGap(main, c) > Math.max(main.width, main.height) * 0.72) continue;
      if (c.dark / c.area < 0.12 && main.dark / main.area > 0.5) continue;
      selected.push(c); keep.add(c.id);
    }
    const bbox = { x: width, y: height, right: 0, bottom: 0 };
    for (const c of selected) {
      bbox.x = Math.min(bbox.x, c.x); bbox.y = Math.min(bbox.y, c.y);
      bbox.right = Math.max(bbox.right, c.right); bbox.bottom = Math.max(bbox.bottom, c.bottom);
    }
    bbox.width = bbox.right - bbox.x; bbox.height = bbox.bottom - bbox.y;
    const margin = Math.max(2, Math.min(width, height) * 0.005);
    if (bbox.x < margin || bbox.y < margin || bbox.right > width - margin || bbox.bottom > height - margin) warnings.push('鞋子靠近原图边缘，可能已经被原图裁切；请检查完整性。');
    const removedArea = found.items.filter(c => !keep.has(c.id)).reduce((s, c) => s + c.area, 0);
    if (removedArea > n * 0.005) warnings.push('已排除主体以外的独立物体，请检查是否保留了整双鞋。');
    const distance = distanceField(width, height, i => keep.has(found.labels[i]));
    const background = estimateBackground(rgba, width, height, mask, distance, bbox, warnings);
    const subjectAlpha = new Float32Array(n), shadowAlpha = new Float32Array(n);
    const edgeReach = Math.max(4, Math.min(16, Math.max(width, height) * 0.006));
    const span = Math.max(bbox.width, bbox.height), shadowReach = Math.max(12, span * 0.24);
    const contactReach = Math.max(3, span * 0.025);
    for (let y = 0; y < height; y++) {
      const yn = y / Math.max(1, height - 1) * 2 - 1;
      for (let x = 0; x < width; x++) {
        const i = y * width + x, p = i * 4, xn = x / Math.max(1, width - 1) * 2 - 1;
        const rejected = found.labels[i] && !keep.has(found.labels[i]);
        const allowed = !rejected && distance[i] <= edgeReach;
        const m = allowed ? mask[i] : 0;
        const bg = background.coefficients.map(c => evaluate(c, xn, yn));
        let a = smooth(0.015, 0.94, m);
        if (m > 0.025 && m < 0.94) {
          // Minimum alpha required for a valid foreground, from Color Unmix.
          // Restrict to the silhouette: applying this globally would turn dark
          // product fabric into transparency and change its original colour.
          let necessary = 0;
          for (let c = 0; c < 3; c++) {
            const v = rgba[p + c], b = bg[c];
            const need = v < b ? (b - v) / Math.max(1, b) : (v - b) / Math.max(1, 255 - b);
            necessary = Math.max(necessary, need);
          }
          a = Math.max(a, necessary * smooth(0.025, 0.16, m));
        }
        subjectAlpha[i] = clamp(a) * rgba[p + 3] / 255;
        if (a >= 0.999 || rejected || distance[i] > shadowReach || rgba[p + 3] < 245) continue;
        const tr = rgba[p] / bg[0], tg = rgba[p + 1] / bg[1], tb = rgba[p + 2] / bg[2];
        const difference = Math.max(tr, tg, tb) - Math.min(tr, tg, tb);
        const chromaGate = 1 - smooth(0.07, 0.25, difference);
        const spatialGate = 1 - smooth(shadowReach * 0.45, shadowReach, distance[i]);
        const rawShadow = clamp(1 - Math.min(tr, tg, tb), 0, 0.98);
        // Do not infer shadow from the same anti-aliased shoe edge a second time.
        const edgeGate = 1 - smooth(0.015, 0.30, m);
        const noiseGate = smooth(0, 0.0035, rawShadow);
        shadowAlpha[i] = rawShadow * chromaGate * spatialGate * edgeGate * noiseGate;
      }
    }
    // Keep shadow components attached to the shoe, then let their sub-threshold
    // tails survive in a small soft band. Small detached marks are not shadows.
    const shadows = components(width, height, i => shadowAlpha[i] > 0.006, (c, i) => {
      if (distance[i] <= contactReach) c.near++;
      c.peak = Math.max(c.peak, shadowAlpha[i]);
    });
    const shadowKeep = new Set(shadows.items.filter(c => c.near > 0 && c.area >= Math.max(5, n * 0.00001) && c.peak > 0.012).map(c => c.id));
    const shadowDistance = distanceField(width, height, i => shadowKeep.has(shadows.labels[i]));
    const tailReach = Math.max(3, span * 0.018);
    for (let i = 0; i < n; i++) {
      const label = shadows.labels[i];
      if (label && !shadowKeep.has(label)) shadowAlpha[i] = 0;
      else if (!label) shadowAlpha[i] *= 1 - smooth(0, tailReach, shadowDistance[i]);
    }
    // Suppress sensor/JPEG grain only in the extracted floor shadow. The
    // original product RGB and its edge alpha never pass through this filter.
    const shadowTemp = new Float32Array(n), kernel = [1, 2, 3, 4, 3, 2, 1];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (subjectAlpha[i] > 0.3) { shadowTemp[i] = shadowAlpha[i]; continue; }
      let sum = 0, weight = 0;
      for (let k = -3; k <= 3; k++) { const xx = x + k; if (xx < 0 || xx >= width) continue; const j = y * width + xx; if (subjectAlpha[j] > 0.3) continue; sum += shadowAlpha[j] * kernel[k + 3]; weight += kernel[k + 3]; }
      shadowTemp[i] = weight ? sum / weight : shadowAlpha[i];
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (subjectAlpha[i] > 0.3) continue;
      let sum = 0, weight = 0;
      for (let k = -3; k <= 3; k++) { const yy = y + k; if (yy < 0 || yy >= height) continue; const j = yy * width + x; if (subjectAlpha[j] > 0.3) continue; sum += shadowTemp[j] * kernel[k + 3]; weight += kernel[k + 3]; }
      if (weight) shadowAlpha[i] = sum / weight;
    }
    // A nearly invisible long tail must not determine the displayed shoe size.
    // Preserve every product edge and the stronger part of the original shadow,
    // then let the remaining low-density ground fade into the replacement floor.
    // This is evaluated after smoothing so an obsolete pre-filter extent cannot
    // keep shrinking the product when the user increases its size.
    const shadowCore = { x: bbox.x, y: bbox.y, right: bbox.right, bottom: bbox.bottom };
    for (let i = 0; i < n; i++) if (subjectAlpha[i] > 0.001 || shadowAlpha[i] >= 0.06) {
      const x = i % width, y = (i / width) | 0;
      shadowCore.x = Math.min(shadowCore.x, x); shadowCore.y = Math.min(shadowCore.y, y);
      shadowCore.right = Math.max(shadowCore.right, x + 1); shadowCore.bottom = Math.max(shadowCore.bottom, y + 1);
    }
    const fadeX = Math.max(4, bbox.width * 0.045), fadeY = Math.max(4, bbox.height * 0.045);
    const crop = { x: bbox.x, y: bbox.y, right: bbox.right, bottom: bbox.bottom };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (subjectAlpha[i] <= 0.001 && shadowAlpha[i] > 0) {
        const dx = Math.max(0, shadowCore.x - x, x + 1 - shadowCore.right), dy = Math.max(0, shadowCore.y - y, y + 1 - shadowCore.bottom);
        shadowAlpha[i] *= (1 - smooth(0, fadeX, dx)) * (1 - smooth(0, fadeY, dy));
      }
      if (shadowAlpha[i] > 0.0005 || subjectAlpha[i] > 0.001) {
        crop.x = Math.min(crop.x, x); crop.y = Math.min(crop.y, y);
        crop.right = Math.max(crop.right, x + 1); crop.bottom = Math.max(crop.bottom, y + 1);
      }
    }
    crop.x = Math.max(0, crop.x - 4); crop.y = Math.max(0, crop.y - 4);
    crop.right = Math.min(width, crop.right + 4); crop.bottom = Math.min(height, crop.bottom + 4);
    crop.width = crop.right - crop.x; crop.height = crop.bottom - crop.y;
    return { version: 1, rgba: new Uint8ClampedArray(rgba), width, height, subjectAlpha, shadowAlpha, background, bbox, crop, warnings };
  }

  function canvas(width, height) {
    let c;
    if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(width, height);
    else if (typeof document !== 'undefined') { c = document.createElement('canvas'); c.width = width; c.height = height; }
    else throw new Error('当前环境不支持 Canvas 图像输出。');
    return c;
  }

  function finiteSetting(settings, name, fallback, min, max) {
    const v = settings[name] == null ? fallback : Number(settings[name]);
    if (!Number.isFinite(v)) throw new Error('调整参数包含无效数值，请恢复默认后重试。');
    return clamp(v, min, max);
  }

  function toneSettings(settings) {
    return {
      exposure: finiteSetting(settings, 'exposure', 0, -1.5, 1.5),
      contrast: finiteSetting(settings, 'contrast', 0, -50, 50),
      temperature: finiteSetting(settings, 'temperature', 0, -50, 50),
      saturation: finiteSetting(settings, 'saturation', 0, -50, 50),
    };
  }

  // Exposure and white-balance multipliers operate in linear light. A small
  // interpolated lookup table avoids millions of transfer-function powers on
  // each slider adjustment. Neutral settings bypass this path entirely.
  function toneTransform(settings) {
    const t = toneSettings(settings);
    if (!Object.values(t).some(v => v !== 0)) return null;
    const steps = 4096, exp = 2 ** t.exposure, warm = t.temperature / 50;
    const gains = [1 + warm * 0.16, 1 + warm * 0.018, 1 - warm * 0.16];
    const tables = gains.map(gain => {
      const lut = new Float64Array(steps + 1);
      for (let i = 0; i <= steps; i++) {
        const s = i / steps, linear = (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * exp * gain;
        lut[i] = (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055) * 255;
      }
      return lut;
    });
    const contrast = 2 ** (t.contrast / 50), saturation = 1 + t.saturation / 100;
    return rgb => {
      for (let c = 0; c < 3; c++) {
        const position = clamp(rgb[c], 0, 255) / 255 * steps, i = Math.floor(position), f = position - i;
        const exposed = tables[c][i] * (1 - f) + tables[c][Math.min(steps, i + 1)] * f;
        rgb[c] = (exposed - 127.5) * contrast + 127.5;
      }
      const l = luminance(...rgb);
      for (let c = 0; c < 3; c++) rgb[c] = clamp(l + (rgb[c] - l) * saturation, 0, 255);
      return rgb;
    };
  }

  function colorPixel(rgb, settings = {}) {
    if (!rgb || rgb.length !== 3 || Array.from(rgb).some(v => !Number.isFinite(v))) throw new Error('颜色像素无效。');
    const transform = toneTransform(settings), copy = Array.from(rgb);
    return transform ? transform(copy) : copy;
  }

  // Cached derived masks are kept outside the prepared photograph. In
  // particular, never overwrite shadowAlpha: the source shadow is also needed
  // to recover the straight foreground at anti-aliased product edges.
  const shadowCache = new WeakMap();

  function shadowSettings(settings) {
    const mode = settings.shadowMode == null ? 'contact' : settings.shadowMode;
    if (!['contact', 'original', 'none'].includes(mode)) throw new Error('阴影模式无效。');
    const range = finiteSetting(settings, 'shadowRange', 1, 0.3, 2);
    const softness = finiteSetting(settings, 'shadowSoftness', 0, 0, 1);
    const source = settings.shadowEdits == null ? [] : settings.shadowEdits;
    if (!Array.isArray(source) || source.length > 200) throw new Error('阴影笔画过多，请撤销部分操作后重试。');
    let count = 0;
    const edits = source.map(stroke => {
      if (!stroke || !['erase', 'restore'].includes(stroke.mode) || typeof stroke.radius !== 'number' || !Number.isFinite(stroke.radius) || stroke.radius <= 0 || stroke.radius > 1 || !Array.isArray(stroke.points) || !stroke.points.length) throw new Error('阴影笔画参数无效。');
      count += stroke.points.length;
      if (count > 20000) throw new Error('阴影笔画过多，请撤销部分操作后重试。');
      const points = stroke.points.map(point => {
        if (!Array.isArray(point) || point.length !== 2 || point.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('阴影笔画坐标无效。');
        return [point[0], point[1]];
      });
      // Strokes saved by older versions retain their former brush shape and
      // full opacity; the v5 editor explicitly stores the new brush settings.
      const hardness = finiteSetting(stroke, 'hardness', 0.55, 0, 1);
      const opacity = finiteSetting(stroke, 'opacity', 1, 0, 1);
      return { mode: stroke.mode, radius: stroke.radius, hardness, opacity, points };
    });
    return { mode, range, softness, edits, editKey: JSON.stringify(edits) };
  }

  function lowerSoleDistances(prepared) {
    const { width, height, subjectAlpha, crop, bbox } = prepared;
    // Work in the stable source crop, not in the export canvas. Independently
    // connected shoes each contribute their own lower contour, so a higher
    // shoe in a pair does not lose its contact shadow to a single global line.
    const w = crop.width, h = crop.height;
    const found = components(w, h, i => subjectAlpha[((i / w) | 0) * width + (i % w) + crop.y * width + crop.x] >= 0.45);
    const soles = new Map();
    for (const component of found.items) if (component.area >= Math.max(4, bbox.width * bbox.height * 0.00015)) {
      soles.set(component.id, { component, bottom: new Int32Array(component.width).fill(-1) });
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sole = soles.get(found.labels[y * w + x]);
      if (sole) sole.bottom[x - sole.component.x] = y;
    }
    const d = new Float32Array(w * h).fill(1e7);
    for (const { component, bottom } of soles.values()) {
      const lowerLimit = component.y + component.height * 0.45;
      for (let x = 0; x < bottom.length; x++) {
        const y = bottom[x];
        // The narrow shaft sides and collar are not floor contact surfaces.
        if (y >= lowerLimit) d[y * w + component.x + x] = 0;
      }
    }
    // Asymmetric chamfer distance: the floor may extend further below and to
    // the side of a sole, while gray haze above it fades much sooner. Soft
    // falloff is applied during render, allowing range changes without another
    // segmentation or another distance-field calculation.
    const horizontal = 1, down = 1.45, up = 4, downDiagonal = Math.hypot(horizontal, down), upDiagonal = Math.hypot(horizontal, up);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x) d[i] = Math.min(d[i], d[i - 1] + horizontal);
      if (y) {
        d[i] = Math.min(d[i], d[i - w] + down);
        if (x) d[i] = Math.min(d[i], d[i - w - 1] + downDiagonal);
        if (x + 1 < w) d[i] = Math.min(d[i], d[i - w + 1] + downDiagonal);
      }
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x + 1 < w) d[i] = Math.min(d[i], d[i + 1] + horizontal);
      if (y + 1 < h) {
        d[i] = Math.min(d[i], d[i + w] + up);
        if (x) d[i] = Math.min(d[i], d[i + w - 1] + upDiagonal);
        if (x + 1 < w) d[i] = Math.min(d[i], d[i + w + 1] + upDiagonal);
      }
    }
    return d;
  }

  function brushGain(prepared, edits, cached) {
    const { width, height, crop, subjectAlpha } = prepared, n = crop.width * crop.height;
    // An appended stroke can reuse the previous result. Undo and changed
    // strokes replay from an untouched all-visible mask, not an edited source.
    const keys = edits.map(stroke => JSON.stringify(stroke));
    const canAppend = cached && cached.keys.length < keys.length && cached.keys.every((key, i) => key === keys[i]);
    const canReplaceLast = cached && cached.beforeLast && cached.keys.length === keys.length && keys.slice(0, -1).every((key, i) => key === cached.keys[i]);
    const start = canAppend ? cached.keys.length : canReplaceLast ? keys.length - 1 : 0;
    const gain = canAppend ? cached.gain.slice() : canReplaceLast ? cached.beforeLast.slice() : new Float32Array(n).fill(1);
    const coverage = new Uint8Array(n), touched = [];
    let beforeLast = null;
    for (let s = start; s < edits.length; s++) {
      if (s === edits.length - 1) beforeLast = gain.slice();
      const stroke = edits[s], radius = Math.max(0.25, stroke.radius * Math.max(width, height));
      const points = stroke.points.map(([x, y]) => [x * width - crop.x, y * height - crop.y]);
      for (let p = 0; p < Math.max(1, points.length - 1); p++) {
        const [ax, ay] = points[p], [bx, by] = points[Math.min(p + 1, points.length - 1)];
        const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
        const left = Math.max(0, Math.floor(Math.min(ax, bx) - radius)), right = Math.min(crop.width - 1, Math.ceil(Math.max(ax, bx) + radius));
        const top = Math.max(0, Math.floor(Math.min(ay, by) - radius)), bottom = Math.min(crop.height - 1, Math.ceil(Math.max(ay, by) + radius));
        for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
          const i = y * crop.width + x, sourceIndex = (y + crop.y) * width + x + crop.x;
          if (subjectAlpha[sourceIndex] > 0.001 || coverage[i] === 255) continue;
          const t = length2 ? clamp(((x - ax) * dx + (y - ay) * dy) / length2) : 0;
          const distance = Math.hypot(x - ax - dx * t, y - ay - dy * t);
          const shape = stroke.hardness >= 1 ? (distance < radius ? 1 : 0) : 1 - smooth(radius * stroke.hardness, radius, distance);
          const amount = Math.round(255 * shape);
          if (amount > coverage[i]) {
            if (!coverage[i]) touched.push(i);
            coverage[i] = amount;
          }
        }
      }
      for (const i of touched) {
        const amount = coverage[i] / 255 * stroke.opacity;
        gain[i] = stroke.mode === 'erase' ? gain[i] * (1 - amount) : gain[i] + (1 - gain[i]) * amount;
        coverage[i] = 0;
      }
      touched.length = 0;
    }
    return { gain, keys, beforeLast };
  }

  function shadowControls(prepared, settings) {
    const controls = shadowSettings(settings);
    let cached = shadowCache.get(prepared);
    if (!cached) { cached = {}; shadowCache.set(prepared, cached); }
    if (controls.mode === 'contact' && !cached.contactDistance) cached.contactDistance = lowerSoleDistances(prepared);
    if (controls.edits.length && cached.editKey !== controls.editKey) {
      cached.brush = brushGain(prepared, controls.edits, cached.brush);
      cached.editKey = controls.editKey;
    }
    const baseReach = Math.max(6, Math.max(prepared.bbox.width, prepared.bbox.height) * 0.085);
    const core = Math.max(1.5, baseReach * 0.20);
    return {
      mode: controls.mode,
      distance: cached.contactDistance,
      // Range shortens the outer tail without fading the immediate sole contact.
      core, reach: core + (Math.max(core + 1, baseReach * controls.range) - core) * (1 + controls.softness * 1.25),
      gain: controls.edits.length ? cached.brush.gain : null,
    };
  }

  function layout(prepared, settings = {}, logoDimensions = null) {
    if (!prepared || !prepared.bbox || !prepared.crop) throw new Error('请先分析原图。');
    const targetWidth = settings.width == null ? 900 : Number(settings.width), targetHeight = settings.height == null ? 1200 : Number(settings.height);
    if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight) || targetWidth < 16 || targetHeight < 16 || targetWidth > 6000 || targetHeight > 6000) throw new Error('输出尺寸必须介于 16 与 6000 像素。');
    const scale = finiteSetting(settings, 'scale', 0.86, 0.2, 0.96);
    const rotation = finiteSetting(settings, 'rotation', 0, -180, 180);
    const radians = rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const offsetX = finiteSetting(settings, 'offsetX', 0, -1, 1), offsetY = finiteSetting(settings, 'offsetY', -0.01875, -1, 1);
    const logoX = finiteSetting(settings, 'logoX', 30 / 900, -1, 1), logoY = finiteSetting(settings, 'logoY', 27 / 1200, -1, 1);
    const logoWidth = finiteSetting(settings, 'logoWidth', 194 / 900, 0.001, 1), logoOpacity = finiteSetting(settings, 'logoOpacity', 1, 0, 1);
    if (settings.logoEnabled != null && typeof settings.logoEnabled !== 'boolean') throw new Error('Logo 开关参数无效。');
    const { bbox, crop } = prepared, warnings = [];
    let logoPlacement = null;
    if (settings.logoEnabled !== false && logoOpacity > 0 && logoDimensions) {
      const lw = Number(logoDimensions.width), lh = Number(logoDimensions.height);
      if (!(lw > 0 && lh > 0 && Number.isFinite(lw) && Number.isFinite(lh))) throw new Error('Logo 尺寸无效。');
      const f = Math.min(targetWidth * logoWidth / lw, targetWidth / lw, targetHeight / lh);
      logoPlacement = { x: clamp(targetWidth * logoX, 0, targetWidth - lw * f), y: clamp(targetHeight * logoY, 0, targetHeight - lh * f), width: lw * f, height: lh * f };
      if (f > 1.05) warnings.push('Logo 已放大，较大尺寸导出时建议使用更清晰的 Logo 文件。');
    }
    // The shoe alone owns layout. A wide shadow crop may extend outside the
    // export canvas, but must never shrink or displace the product.
    let factor = Math.min(targetWidth * scale / bbox.width, targetHeight * scale / bbox.height);
    const rotatedWidth = Math.abs(cos) * bbox.width + Math.abs(sin) * bbox.height;
    const rotatedHeight = Math.abs(sin) * bbox.width + Math.abs(cos) * bbox.height;
    factor = Math.min(factor, targetWidth * 0.98 / rotatedWidth, targetHeight * 0.98 / rotatedHeight);
    const subjectLeft = bbox.x - crop.x, subjectTop = bbox.y - crop.y;
    const place = (f, minY) => {
      const centerX = clamp(targetWidth * (0.5 + offsetX), targetWidth * 0.01 + rotatedWidth * f / 2, targetWidth * 0.99 - rotatedWidth * f / 2);
      const centerY = clamp(targetHeight * (0.5 + offsetY), Math.max(targetHeight * 0.01, minY) + rotatedHeight * f / 2, targetHeight * 0.99 - rotatedHeight * f / 2);
      const subjectX = centerX - bbox.width * f / 2, subjectY = centerY - bbox.height * f / 2;
      return { x: subjectX - subjectLeft * f, y: subjectY - subjectTop * f };
    };
    let point = place(factor, 0);
    // Top-corner branding gets a little breathing room for tall poses. Logos
    // intentionally placed lower can overlay a product, like a watermark.
    if (logoPlacement && logoPlacement.y + logoPlacement.height <= targetHeight * 0.25) {
      const centerX = point.x + subjectLeft * factor + bbox.width * factor / 2;
      const left = centerX - rotatedWidth * factor / 2, right = centerX + rotatedWidth * factor / 2;
      if (left < logoPlacement.x + logoPlacement.width && right > logoPlacement.x) {
        const safeTop = logoPlacement.y + logoPlacement.height + targetHeight * 0.025;
        const safeFactor = (targetHeight * 0.99 - safeTop) / rotatedHeight;
        if (factor > safeFactor) { factor = safeFactor; warnings.push('已稍微缩小主体，为顶部 Logo 留出空间。'); }
        point = place(factor, safeTop);
      }
    }
    const originalScale = prepared.sourceFile && Array.isArray(prepared.sourceBox) && prepared.width > 0 && prepared.height > 0
      ? Math.min(prepared.sourceBox[2] / prepared.width, prepared.sourceBox[3] / prepared.height) : 1;
    if (factor > originalScale * 1.001) warnings.push('输出中的鞋子已超过可用像素大小，建议使用更高分辨率原图或减小输出尺寸。');
    const centerX = point.x + subjectLeft * factor + bbox.width * factor / 2;
    const centerY = point.y + subjectTop * factor + bbox.height * factor / 2;
    const a = cos * factor, b = sin * factor, c = -sin * factor, d = cos * factor;
    const sourceCenterX = bbox.x + bbox.width / 2, sourceCenterY = bbox.y + bbox.height / 2;
    const sourceTransform = { a, b, c, d, e: centerX - a * sourceCenterX - c * sourceCenterY, f: centerY - b * sourceCenterX - d * sourceCenterY };
    return {
      width: targetWidth, height: targetHeight, warnings, logoPlacement, sourceTransform,
      placement: { x: point.x, y: point.y, scale: factor, width: crop.width * factor, height: crop.height * factor, subjectX: point.x + subjectLeft * factor, subjectY: point.y + subjectTop * factor, subjectWidth: bbox.width * factor, subjectHeight: bbox.height * factor, rotation, centerX, centerY },
    };
  }

  // Keep segmentation and shadow editing at their established working size.
  // Only the safe opaque shoe interior is replaced with pixels sampled directly
  // from the original photograph at final export size. The validated v3 edge
  // unmix and floor composite remain unchanged, avoiding new bright/dark rims.
  const originalCoreCache = new WeakMap();

  function originalCoreDistances(prepared) {
    let cached = originalCoreCache.get(prepared);
    if (cached) return cached;
    const { width, height, crop, subjectAlpha } = prepared;
    const full = distanceField(width, height, i => subjectAlpha[i] < 0.999999);
    cached = new Float32Array(crop.width * crop.height);
    for (let y = 0; y < crop.height; y++) {
      const start = (y + crop.y) * width + crop.x;
      cached.set(full.subarray(start, start + crop.width), y * crop.width);
    }
    originalCoreCache.set(prepared, cached);
    return cached;
  }

  function outputPatchBounds(placement, width, height, transform, crop) {
    const corners = transform && placement.rotation ? [
      [crop.x, crop.y], [crop.x + crop.width, crop.y],
      [crop.x, crop.y + crop.height], [crop.x + crop.width, crop.y + crop.height],
    ].map(([x, y]) => [transform.a * x + transform.c * y + transform.e, transform.b * x + transform.d * y + transform.f]) : [
      [placement.x, placement.y], [placement.x + placement.width, placement.y + placement.height],
    ];
    let x = Math.floor(Math.min(...corners.map(p => p[0]))), y = Math.floor(Math.min(...corners.map(p => p[1])));
    let right = Math.ceil(Math.max(...corners.map(p => p[0]))), bottom = Math.ceil(Math.max(...corners.map(p => p[1])));
    // Normally retain the whole patch, including off-canvas shadows, so dragging
    // remains continuous. Very small source subjects can produce enormous
    // off-canvas patches; cap only this invisible excess to a modest margin.
    if ((right - x) * (bottom - y) > Math.max(4000000, width * height * 1.5)) {
      const marginX = Math.max(8, Math.ceil(width * 0.08)), marginY = Math.max(8, Math.ceil(height * 0.08));
      x = Math.max(x, -marginX); y = Math.max(y, -marginY);
      right = Math.min(right, width + marginX); bottom = Math.min(bottom, height + marginY);
    }
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
  }

  async function originalDetailPatch(prepared, basePatch, geometry, color, tone, includeOriginal = true) {
    const { placement, sourceTransform: transform } = geometry;
    const rect = outputPatchBounds(placement, geometry.width, geometry.height, transform, prepared.crop);
    const patch = canvas(rect.width, rect.height), ctx = patch.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = color; ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    if (placement.rotation) {
      ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e - rect.x, transform.f - rect.y);
      ctx.drawImage(basePatch, prepared.crop.x, prepared.crop.y, prepared.crop.width, prepared.crop.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else ctx.drawImage(basePatch, placement.x - rect.x, placement.y - rect.y, placement.width, placement.height);
    if (!includeOriginal) return { patch, rect };
    const original = canvas(rect.width, rect.height), originalContext = original.getContext('2d', { alpha: false, willReadFrequently: true });
    let bitmap;
    try {
      bitmap = await createImageBitmap(prepared.sourceFile, { imageOrientation: 'from-image' });
      const box = prepared.sourceBox;
      if (!Array.isArray(box) || box.length !== 4 || box.some(v => !Number.isFinite(v)) || box[0] < 0 || box[1] < 0 || box[2] <= 0 || box[3] <= 0 || box[0] + box[2] > bitmap.width || box[1] + box[3] > bitmap.height || bitmap.width !== prepared.originalWidth || bitmap.height !== prepared.originalHeight) throw new Error('原图尺寸与识别结果不一致，请重新添加这张照片。');
      originalContext.fillStyle = '#fff'; originalContext.fillRect(0, 0, rect.width, rect.height);
      originalContext.imageSmoothingEnabled = true; originalContext.imageSmoothingQuality = 'high';
      // The destination uses the existing logical source coordinates, including
      // fractional placement. Export then copies this integer-aligned raster 1:1.
      if (placement.rotation) {
        originalContext.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e - rect.x, transform.f - rect.y);
        originalContext.drawImage(bitmap, box[0], box[1], box[2], box[3], 0, 0, prepared.width, prepared.height);
        originalContext.setTransform(1, 0, 0, 1, 0, 0);
      } else originalContext.drawImage(bitmap, box[0], box[1], box[2], box[3],
          placement.x - prepared.crop.x * placement.scale - rect.x,
          placement.y - prepared.crop.y * placement.scale - rect.y,
          prepared.width * placement.scale, prepared.height * placement.scale);
      const raw = originalContext.getImageData(0, 0, rect.width, rect.height).data;
      const composite = ctx.getImageData(0, 0, rect.width, rect.height), out = composite.data;
      const distances = originalCoreDistances(prepared), crop = prepared.crop;
      // Include the final-pixel sampling footprint when reducing heavily. Even
      // the transition band stays inside fully opaque product pixels.
      const guard = Math.max(2, 2 / placement.scale), foreground = [0, 0, 0];
      const determinant = transform.a * transform.d - transform.b * transform.c;
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
          const dx = rect.x + x + 0.5 - transform.e, dy = rect.y + y + 0.5 - transform.f;
          const sx = placement.rotation ? (transform.d * dx - transform.c * dy) / determinant - crop.x - 0.5 : (rect.x + x + 0.5 - placement.x) / placement.scale - 0.5;
          const sy = placement.rotation ? (-transform.b * dx + transform.a * dy) / determinant - crop.y - 0.5 : (rect.y + y + 0.5 - placement.y) / placement.scale - 0.5;
          if (sx < 0 || sx > crop.width - 1 || sy < 0 || sy > crop.height - 1) continue;
          const iy = Math.floor(sy), iy1 = Math.min(crop.height - 1, iy + 1), ty = sy - iy;
          const ix = Math.floor(sx), ix1 = Math.min(crop.width - 1, ix + 1), tx = sx - ix;
          const distance = (distances[iy * crop.width + ix] * (1 - tx) + distances[iy * crop.width + ix1] * tx) * (1 - ty)
            + (distances[iy1 * crop.width + ix] * (1 - tx) + distances[iy1 * crop.width + ix1] * tx) * ty;
          const weight = smooth(guard, guard + 2, distance);
          if (weight <= 0) continue;
          const i = (y * rect.width + x) * 4;
          for (let c = 0; c < 3; c++) foreground[c] = raw[i + c];
          if (tone) tone(foreground);
          for (let c = 0; c < 3; c++) out[i + c] = foreground[c] * weight + out[i + c] * (1 - weight);
        }
      }
      ctx.putImageData(composite, 0, 0);
      return { patch, rect };
    } finally {
      if (bitmap) bitmap.close();
      original.width = original.height = 1;
    }
  }

  async function render(prepared, settings = {}, previewOnly = false, encodeOutput = true) {
    if (!prepared || prepared.version !== 1 || !prepared.subjectAlpha || !prepared.crop) throw new Error('请先分析原图。');
    const color = settings.background || '#e6e6e6';
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('背景色必须是六位 HEX 色值。');
    const bgNew = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    const strength = finiteSetting(settings, 'shadow', 1, 0, 2), tone = toneTransform(settings);
    const format = String(settings.format || 'jpeg').toLowerCase();
    if (!['jpeg', 'jpg', 'png', 'webp'].includes(format)) throw new Error('支持 JPG、PNG 或 WebP 输出。');
    const mime = format === 'jpg' ? 'image/jpeg' : 'image/' + format;
    const quality = finiteSetting(settings, 'quality', 0.98, 0.5, 1);
    // Validate placement settings before loading any image or allocating rasters.
    layout(prepared, settings);
    const shadow = shadowControls(prepared, settings);
    let logo = null;
    if (settings.logoEnabled !== false && root.GrayAssets) logo = await root.GrayAssets.getLogo(settings.logoId || 'default');
    const geometry = layout(prepared, settings, logo), { width: targetWidth, height: targetHeight, placement, logoPlacement } = geometry;
    const { rgba, width, height, subjectAlpha, shadowAlpha, background, crop } = prepared;
    // Live brush feedback uses a bounded source raster. Mask coordinates remain
    // those of the original analysis, so brush placement and export agree.
    const previewFactor = previewOnly ? Math.min(1, 900 / Math.max(crop.width, crop.height)) : 1;
    const patchWidth = Math.max(1, Math.round(crop.width * previewFactor)), patchHeight = Math.max(1, Math.round(crop.height * previewFactor));
    let patch = canvas(patchWidth, patchHeight);
    const pctx = patch.getContext('2d', { alpha: false });
    const pixels = pctx.createImageData(patchWidth, patchHeight), out = pixels.data;
    const foreground = [0, 0, 0];
    for (let py = 0; py < patchHeight; py++) {
      const cy = previewOnly ? Math.min(crop.height - 1, Math.floor((py + 0.5) * crop.height / patchHeight)) : py;
      const y = cy + crop.y, yn = y / Math.max(1, height - 1) * 2 - 1;
      for (let px = 0; px < patchWidth; px++) {
        const cx = previewOnly ? Math.min(crop.width - 1, Math.floor((px + 0.5) * crop.width / patchWidth)) : px;
        const x = cx + crop.x, i = y * width + x, src = i * 4, dst = (py * patchWidth + px) * 4;
        const a = subjectAlpha[i], sh = shadowAlpha[i], patchIndex = cy * crop.width + cx;
        const modeGain = shadow.mode === 'none' ? 0 : shadow.mode === 'contact' ? 1 - smooth(shadow.core, shadow.reach, shadow.distance[patchIndex]) : 1;
        const editGain = shadow.gain ? shadow.gain[patchIndex] : 1;
        const newSh = clamp(sh * strength * modeGain * editGain, 0, 0.98), xn = x / Math.max(1, width - 1) * 2 - 1;
        if (tone && a > 0.001) {
          // Recover straight foreground RGB first. Toning the premultiplied
          // edge or the already-composited gray floor would create color rims.
          for (let c = 0; c < 3; c++) foreground[c] = a >= 0.999999 ? rgba[src + c] : clamp((rgba[src + c] - evaluate(background.coefficients[c], xn, yn) * (1 - a) * (1 - sh)) / a, 0, 255);
          tone(foreground);
          for (let c = 0; c < 3; c++) out[dst + c] = foreground[c] * a + bgNew[c] * (1 - a) * (1 - newSh);
          out[dst + 3] = 255;
          continue;
        }
        for (let c = 0; c < 3; c++) {
          if (a >= 0.999999) { out[dst + c] = rgba[src + c]; continue; }
          const b = evaluate(background.coefficients[c], xn, yn);
          // Use one product-edge composite. The input edge already contains B;
          // multiplying the original edge RGB by alpha again creates dark rims.
          if (a > 0.001) {
            // A faint segmentation tail can overlap a real contact shadow.
            // Recover the edge against that shadowed ground, so it does not
            // become a bright seam when the original white floor is replaced.
            const foregroundPremultiplied = clamp(rgba[src + c] - b * (1 - a) * (1 - sh), 0, 255 * a);
            out[dst + c] = foregroundPremultiplied + bgNew[c] * (1 - a) * (1 - newSh);
          } else if (sh > 0) {
            // Recover a modest colour contribution as well as neutral density.
            // Spatial/cleanup gates have already acted on sh; limiting tint
            // avoids a bright cast from a noisy estimated light background.
            const raw = clamp(1 - Math.min(rgba[src] / evaluate(background.coefficients[0], xn, yn), rgba[src + 1] / evaluate(background.coefficients[1], xn, yn), rgba[src + 2] / evaluate(background.coefficients[2], xn, yn)), 0, 0.98);
            const tint = raw > 0.00001 ? clamp((rgba[src + c] - b * (1 - raw)) / raw, 0, 45) : 0;
            out[dst + c] = bgNew[c] * (1 - newSh) + tint * newSh;
          } else out[dst + c] = bgNew[c];
        }
        out[dst + 3] = 255;
      }
    }
    pctx.putImageData(pixels, 0, 0);
    let patchPlacement = { x: placement.x, y: placement.y, width: placement.width, height: placement.height };
    if (prepared.sourceFile || placement.rotation || previewOnly) {
      const enhanced = await originalDetailPatch(prepared, patch, geometry, color, tone, Boolean(prepared.sourceFile && !previewOnly));
      patch.width = patch.height = 1;
      patch = enhanced.patch; patchPlacement = enhanced.rect;
    }
    const result = {
      blob: null, width: targetWidth, height: targetHeight,
      warnings: [...new Set([...(prepared.warnings || []), ...geometry.warnings])], placement, patchCanvas: patch, patchPlacement, logoPlacement,
      sourceTransform: geometry.sourceTransform,
      sourceGeometry: { width, height, crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, bbox: { ...prepared.bbox } },
    };
    if (previewOnly) return result;
    const output = canvas(targetWidth, targetHeight), ctx = output.getContext('2d', { alpha: false });
    ctx.fillStyle = color; ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(patch, patchPlacement.x, patchPlacement.y, patchPlacement.width, patchPlacement.height);
    if (logoPlacement) {
      ctx.globalAlpha = finiteSetting(settings, 'logoOpacity', 1, 0, 1);
      ctx.drawImage(logo.image, logoPlacement.x, logoPlacement.y, logoPlacement.width, logoPlacement.height);
      ctx.globalAlpha = 1;
    }
    // Layered export reuses this exact full-resolution photographic render,
    // without doing a throwaway PNG encode. Ordinary image export is unchanged.
    if (!encodeOutput) { result.compositeCanvas = output; return result; }
    let blob;
    if (output.convertToBlob) blob = await output.convertToBlob({ type: mime, quality });
    else blob = await new Promise((resolve, reject) => output.toBlob(b => b ? resolve(b) : reject(new Error('图片编码失败。')), mime, quality));
    if (!blob) throw new Error('图片编码失败。');
    result.blob = blob;
    return result;
  }

  // Independent PSD layers use the same final-pixel geometry as image export.
  // The shoe's RGB is resolved against its floor from the validated render,
  // preserving both Color Unmix edges and the original-resolution core patch.
  // The photographic shadow retains its unpainted pixels; only its separate
  // mask holds the contact-range, mode and brush restrictions.
  async function renderLayers(prepared, settings = {}) {
    const rendered = await render(prepared, settings, false, false);
    const { width: targetWidth, height: targetHeight, placement, sourceTransform: transform } = rendered;
    const { width, height, crop, rgba, subjectAlpha, shadowAlpha, background } = prepared;
    const color = settings.background || '#e6e6e6', bg = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    const strength = finiteSetting(settings, 'shadow', 1, 0, 2), controls = shadowControls(prepared, settings);
    const bound = outputPatchBounds(placement, targetWidth, targetHeight, transform, crop);
    const rect = { x: Math.max(0, bound.x), y: Math.max(0, bound.y) };
    rect.width = Math.max(1, Math.min(targetWidth, bound.x + bound.width) - rect.x);
    rect.height = Math.max(1, Math.min(targetHeight, bound.y + bound.height) - rect.y);
    const temporary = [], ownedLayers = [];
    const make = (w, h) => { const result = canvas(w, h); temporary.push(result); return result; };
    const makeLayer = (w, h) => { const result = canvas(w, h); ownedLayers.push(result); return result; };
    try {
      const shoeSource = make(crop.width, crop.height), baseSource = make(crop.width, crop.height), visibleSource = make(crop.width, crop.height);
      const shoeContext = shoeSource.getContext('2d'), baseContext = baseSource.getContext('2d'), visibleContext = visibleSource.getContext('2d');
      const shoePixels = shoeContext.createImageData(crop.width, crop.height), basePixels = baseContext.createImageData(crop.width, crop.height), visiblePixels = visibleContext.createImageData(crop.width, crop.height);
      for (let cy = 0; cy < crop.height; cy++) for (let cx = 0; cx < crop.width; cx++) {
        const x = cx + crop.x, y = cy + crop.y, i = y * width + x, k = cy * crop.width + cx, src = i * 4, dst = k * 4;
        const a = subjectAlpha[i] > 0.001 ? subjectAlpha[i] : 0, sh = shadowAlpha[i];
        const xn = x / Math.max(1, width - 1) * 2 - 1, yn = y / Math.max(1, height - 1) * 2 - 1;
        const modeGain = controls.mode === 'none' ? 0 : controls.mode === 'contact' ? 1 - smooth(controls.core, controls.reach, controls.distance[k]) : 1;
        const editGain = controls.gain ? controls.gain[k] : 1;
        const base = clamp(sh * strength, 0, 0.98), visible = clamp(sh * strength * modeGain * editGain, 0, 0.98);
        // White-with-alpha projects the coverage with exactly Canvas's sampling
        // footprint. Its alpha becomes an ordinary editable grayscale PSD mask.
        shoePixels.data.set([255, 255, 255, Math.round(a * 255)], dst);
        const raw = !a && sh > 0 ? clamp(1 - Math.min(...[0, 1, 2].map(c => rgba[src + c] / evaluate(background.coefficients[c], xn, yn))), 0, 0.98) : 0;
        for (let c = 0; c < 3; c++) {
          const tint = raw > 0.00001 ? clamp((rgba[src + c] - evaluate(background.coefficients[c], xn, yn) * (1 - raw)) / raw, 0, 45) : 0;
          basePixels.data[dst + c] = visiblePixels.data[dst + c] = tint;
        }
        basePixels.data[dst + 3] = Math.round(base * 255);
        visiblePixels.data[dst + 3] = Math.round(visible * 255);
      }
      shoeContext.putImageData(shoePixels, 0, 0); baseContext.putImageData(basePixels, 0, 0); visibleContext.putImageData(visiblePixels, 0, 0);
      const project = source => {
        const target = make(rect.width, rect.height), ctx = target.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        if (placement.rotation) {
          ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e - rect.x, transform.f - rect.y);
          ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        } else ctx.drawImage(source, placement.x - rect.x, placement.y - rect.y, placement.width, placement.height);
        const pixels = ctx.getImageData(0, 0, rect.width, rect.height);
        target.width = target.height = 1;
        return pixels;
      };
      const shoeCoverage = project(shoeSource).data, base = project(baseSource), visible = project(visibleSource).data;
      shoeSource.width = shoeSource.height = baseSource.width = baseSource.height = visibleSource.width = visibleSource.height = 1;
      const reference = make(rect.width, rect.height), referenceContext = reference.getContext('2d', { alpha: false, willReadFrequently: true });
      referenceContext.fillStyle = color; referenceContext.fillRect(0, 0, rect.width, rect.height);
      referenceContext.imageSmoothingEnabled = true; referenceContext.imageSmoothingQuality = 'high';
      const pp = rendered.patchPlacement;
      referenceContext.drawImage(rendered.patchCanvas, pp.x - rect.x, pp.y - rect.y, pp.width, pp.height);
      const exact = referenceContext.getImageData(0, 0, rect.width, rect.height).data;
      reference.width = reference.height = 1;
      const shoe = makeLayer(rect.width, rect.height), shoeMask = makeLayer(rect.width, rect.height), shadow = makeLayer(rect.width, rect.height), shadowMask = makeLayer(rect.width, rect.height);
      const shoeOut = shoe.getContext('2d').createImageData(rect.width, rect.height), shoeMaskOut = shoeMask.getContext('2d').createImageData(rect.width, rect.height), shadowMaskOut = shadowMask.getContext('2d').createImageData(rect.width, rect.height);
      for (let i = 0; i < exact.length; i += 4) {
        const a = shoeCoverage[i + 3] / 255, desired = visible[i + 3] / 255;
        const baseAlpha = Math.max(base.data[i + 3], visible[i + 3]);
        base.data[i + 3] = baseAlpha;
        const gain = baseAlpha ? Math.round(visible[i + 3] / baseAlpha * 255) : 0;
        for (let c = 0; c < 3; c++) {
          // At empty floor pixels the existing composite also captures the
          // resampling of the tinted photographic floor. Resolve its tiny
          // rounding residue here, rather than introducing a white/gray seam.
          if (!a && desired > 0) base.data[i + c] = clamp((exact[i + c] - bg[c] * (1 - desired)) / desired, 0, 255);
          else if (desired > 0) base.data[i + c] = visible[i + c];
          const floor = bg[c] * (1 - desired) + base.data[i + c] * desired;
          shoeOut.data[i + c] = a ? clamp((exact[i + c] - floor * (1 - a)) / a, 0, 255) : 0;
          shoeMaskOut.data[i + c] = shoeCoverage[i + 3];
          shadowMaskOut.data[i + c] = gain;
        }
        shoeOut.data[i + 3] = shoeMaskOut.data[i + 3] = shadowMaskOut.data[i + 3] = 255;
      }
      shoe.getContext('2d').putImageData(shoeOut, 0, 0); shoeMask.getContext('2d').putImageData(shoeMaskOut, 0, 0);
      shadow.getContext('2d').putImageData(base, 0, 0); shadowMask.getContext('2d').putImageData(shadowMaskOut, 0, 0);
      const backgroundCanvas = makeLayer(targetWidth, targetHeight), backgroundContext = backgroundCanvas.getContext('2d', { alpha: false });
      backgroundContext.fillStyle = color; backgroundContext.fillRect(0, 0, targetWidth, targetHeight);
      const layers = [
        { name: '鞋子', canvas: shoe, maskCanvas: shoeMask, left: rect.x, top: rect.y, maskDefaultColor: 0 },
        { name: '阴影', canvas: shadow, maskCanvas: shadowMask, left: rect.x, top: rect.y, maskDefaultColor: 0 },
        { name: '灰色背景', canvas: backgroundCanvas, left: 0, top: 0 },
      ];
      if (rendered.logoPlacement && root.GrayAssets) {
        const logo = await root.GrayAssets.getLogo(settings.logoId || 'default'), p = rendered.logoPlacement;
        const left = Math.floor(p.x), top = Math.floor(p.y), right = Math.min(targetWidth, Math.ceil(p.x + p.width)), bottom = Math.min(targetHeight, Math.ceil(p.y + p.height));
        const logoCanvas = makeLayer(Math.max(1, right - left), Math.max(1, bottom - top)), ctx = logoCanvas.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(logo.image, p.x - left, p.y - top, p.width, p.height);
        layers.unshift({ name: 'Logo', canvas: logoCanvas, left, top, opacity: finiteSetting(settings, 'logoOpacity', 1, 0, 1) });
      }
      // PSD thumbnail/composite must describe the actual quantized layer masks.
      // Recompose after splitting, including Logo opacity, so Photoshop and the
      // file preview agree even at antialiased edges.
      const compositeCanvas = rendered.compositeCanvas, ctx = compositeCanvas.getContext('2d');
      ctx.fillStyle = color; ctx.fillRect(0, 0, targetWidth, targetHeight);
      for (const layer of [...layers].reverse()) {
        if (layer.hidden) continue;
        let raster = layer.canvas;
        if (layer.maskCanvas) {
          raster = make(layer.canvas.width, layer.canvas.height);
          const pixel = layer.canvas.getContext('2d').getImageData(0, 0, raster.width, raster.height);
          const mask = layer.maskCanvas.getContext('2d').getImageData(0, 0, raster.width, raster.height).data;
          for (let i = 0; i < pixel.data.length; i += 4) pixel.data[i + 3] = Math.round(pixel.data[i + 3] * mask[i] / 255);
          raster.getContext('2d').putImageData(pixel, 0, 0);
        }
        ctx.globalAlpha = layer.opacity == null ? 1 : layer.opacity;
        ctx.drawImage(raster, layer.left, layer.top);
        if (layer.maskCanvas) raster.width = raster.height = 1;
      }
      ctx.globalAlpha = 1;
      return { width: targetWidth, height: targetHeight, layers, compositeCanvas, warnings: rendered.warnings };
    } catch (error) {
      for (const item of ownedLayers) item.width = item.height = 1;
      rendered.compositeCanvas.width = rendered.compositeCanvas.height = 1;
      throw error;
    } finally {
      for (const item of temporary) item.width = item.height = 1;
      rendered.patchCanvas.width = rendered.patchCanvas.height = 1;
    }
  }

  root.GrayProcessing = Object.freeze({ analyze, render, renderLayers, preview: (prepared, settings) => render(prepared, settings, true), layout, colorPixel });
})(typeof globalThis !== 'undefined' ? globalThis : window);
