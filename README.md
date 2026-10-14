# 轻图 · 灰底工作台

批量制作电商鞋类灰底图的本地工具：自动抠出鞋子，保留原图纹理和落地阴影，统一构图、调色、加 Logo，并可导出分层 PSD。

全部在本机离线处理，照片不会上传到任何服务器。

> 实际使用中，一组商品图的处理时间从约 30 分钟缩短到约 10 分钟。

## 功能

- **自动抠图**：基于 [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) 识别模型。v7 起每张图识别两次，第二次把鞋子区域放大后单独识别，边缘更利落
- **保留原图阴影**：可选仅保留落地阴影、保留原图阴影或无阴影，并可调范围、深浅、柔和度，还能用画笔擦除多余阴影
- **统一构图**：默认 900 × 1200、#E6E6E6 灰底，鞋子按轮廓自动居中、按比例缩放，支持旋转微调
- **商品调色**：亮度、对比度、色温、饱和度，只作用于商品本身
- **Logo 与品牌模板**：上传透明 PNG Logo，常用设置可保存为模板重复使用
- **批量导出**：单张 JPG / PNG、整批 ZIP，或把同款多个角度导出为一个分层 PSD（鞋子、阴影、Logo、背景分层，带可编辑蒙版）
- **零安装**：Windows 上双击 `启动工具.cmd` 即可使用，无需安装 Python、Node.js 或 Photoshop

<!-- 截图：在 docs/ 下放一张处理前后对比图，再取消下一行的注释 -->
<!-- ![处理前后对比](docs/before-after.jpg) -->

## 下载使用

到本仓库的 **Releases** 页面下载完整安装包（含运行环境和识别模型），解压后双击 `启动工具.cmd`。详细操作见 [使用说明.txt](使用说明.txt)。

系统要求：Windows 10 / 11，64 位。

## 从源码运行

仓库里不包含运行环境和识别模型（单个文件超过 GitHub 的 100 MB 限制），需要自己放到对应位置：

1. **Node.js 运行环境**：下载 Node.js v24 Windows x64 版，把 `node.exe` 放到 `runtime/node.exe`
2. **ONNX Runtime**：在 `runtime/` 目录下执行 `npm install onnxruntime-node@1.22.0`
3. **识别模型**：下载 [BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx](https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx)，重命名为 `birefnet-tiny.onnx`，放到 `models/`。校验信息见 [models/model-info.json](models/model-info.json)

然后双击 `启动工具.cmd`，或执行：

```bash
runtime/node.exe server.cjs
```

## 目录结构

| 文件 | 作用 |
|---|---|
| `server.cjs` | 本机服务，只监听 127.0.0.1，负责提供页面、调用识别模型、保存品牌模板 |
| `native-inference.cjs` | 识别模型的后台线程 |
| `inference.js` | 抠图：两次识别、主体筛选、生成蒙版 |
| `processing.js` | 阴影提取、调色、构图与合成 |
| `editor.js` / `app.js` | 画布编辑与界面逻辑 |
| `psd-export.js` / `psd-worker.js` | 分层 PSD 导出 |
| `assets/default-logo.png` | 示例 Logo，可替换为自己的 |

## 第三方组件

BiRefNet、ONNX Runtime、Konva、ag-psd、pako、base64-js 等，均为 MIT 协议，详见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) 和 `licenses/` 文件夹。
