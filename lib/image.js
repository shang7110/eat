/**
 * 图片尺寸处理
 * ─────────────────────────────────────────────
 * 背景：抖音的 tt.compressImage 不支持 compressedWidth（不能指定目标宽度），
 *      而火山 erase-image 要求「宽 ≤2560 且 高 ≤1440」，手机竖图 1080×1920 会被直接拒绝。
 *      因此统一在后端做尺寸合规处理，两端前端都不必关心像素约束。
 *
 * 依赖体积考虑：jimp 只在真正需要重绘时才 require，未安装时不会影响其它接口启动。
 */

/** 直接解析文件头取尺寸（比 jimp 快得多，用于「是否需要重绘」的判断） */
function readSize(buf) {
  if (!buf || buf.length < 24) return null;

  // PNG：IHDR 在第 16~24 字节
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
  }

  // JPEG：扫描 SOFn 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15，排除 DHT(0xC4)/JPG(0xC8)/DAC(0xCC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
          type: 'jpeg'
        };
      }
      i += 2 + len;
    }
  }

  // WebP：RIFF....WEBP
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    const fmt = buf.slice(12, 16).toString('ascii');
    if (fmt === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
    }
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, type: 'webp' };
    }
    if (fmt === 'VP8X') {
      return {
        width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
        height: (buf.readUIntLE(27, 3) & 0xffffff) + 1,
        type: 'webp'
      };
    }
  }
  return null;
}

/** 等比缩放尺寸到限制内 */
function fitSize(w, h, maxW, maxH) {
  const scale = Math.min(maxW / w, maxH / h, 1);
  if (scale >= 1) return null;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale
  };
}

/**
 * 若超出限制则重绘为 jpeg，返回可上传的新 buffer
 * @param {Buffer} buf
 * @param {number} maxW
 * @param {number} maxH
 * @returns {Promise<{buffer:Buffer, changed:boolean, width:number, height:number, note:string}>}
 */
async function fitToLimit(buf, maxW, maxH) {
  const size = readSize(buf);
  if (!size) {
    return { buffer: buf, changed: false, width: 0, height: 0, note: '尺寸未知，原样透传' };
  }

  const target = fitSize(size.width, size.height, maxW, maxH);
  if (!target) {
    return { buffer: buf, changed: false, width: size.width, height: size.height, note: '尺寸合规' };
  }

  let Jimp;
  try {
    Jimp = require('jimp');
  } catch (e) {
    console.warn('[image] jimp 未安装，跳过重绘（可能导致供应商拒绝）');
    return { buffer: buf, changed: false, width: size.width, height: size.height, note: 'jimp 未安装' };
  }

  const jimplike = Jimp.Jimp || Jimp;    // 兼容 0.22 与 1.x 的导出差异
  const img = await jimplike.read(buf);
  img.resize(target.width, target.height, jimplike.RESIZE_BICUBIC || undefined);
  img.quality(92);
  const out = await img.getBufferAsync(jimplike.MIME_JPEG || 'image/jpeg');

  return {
    buffer: out,
    changed: true,
    width: target.width,
    height: target.height,
    note: `已重绘 ${size.width}×${size.height} → ${target.width}×${target.height}`
  };
}

module.exports = { readSize, fitSize, fitToLimit };
