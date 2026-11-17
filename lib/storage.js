/**
 * 文件存储（替代微信云存储）
 * ─────────────────────────────────────────────
 * 落盘到 FILES_DIR，通过 PUBLIC_BASE_URL 暴露为公网可访问链接
 * （火山/阿里 的图像 API 都需要公网 URL，本地路径传不过去）
 *
 * 环境变量：
 *   FILES_DIR       本地目录，默认 <server>/data/files
 *   PUBLIC_BASE_URL 云托管外网访问域名，如 https://xxxx.douyincloud.com
 *
 * ⚠️ 多实例部署时本地磁盘不共享，需改用对象存储（抖音云对象存储 / 火山 TOS），见 README。
 */
const fs = require('fs');
const path = require('path');

const FILES_DIR = process.env.FILES_DIR || path.join(__dirname, '..', 'data', 'files');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const PREFIX = 'cloud://';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 净化路径，防止 ../ 穿越 */
function safeJoin(cloudPath) {
  const rel = String(cloudPath || '')
    .replace(/^cloud:\/\//, '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  const full = path.join(FILES_DIR, rel);
  const root = path.resolve(FILES_DIR);
  if (!path.resolve(full).startsWith(root)) throw new Error('非法文件路径');
  return full;
}

function fileIDToPath(fileID) {
  return safeJoin(String(fileID || '').replace(PREFIX, ''));
}

/**
 * 上传（写入）文件
 * @param {{cloudPath:string, fileContent:Buffer|string}} opt
 * @returns {Promise<{fileID:string}>}
 */
async function uploadFile(opt) {
  const cloudPath = opt && opt.cloudPath;
  const content = opt && opt.fileContent;
  if (!cloudPath) throw new Error('uploadFile: 缺少 cloudPath');
  if (content === undefined || content === null) throw new Error('uploadFile: 缺少 fileContent');

  const full = safeJoin(cloudPath);
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, content);
  return { fileID: PREFIX + String(cloudPath).replace(/^cloud:\/\//, '') };
}

/**
 * 取临时链接（本实现直接给公网永久链接）
 * @param {{fileList:string[]}} opt
 * @returns {Promise<{fileList:Array<{fileID:string, tempFileURL:string, status:number}>}>}
 */
async function getTempFileURL(opt) {
  const list = (opt && opt.fileList) || [];
  const out = list.map((fileID) => {
    const rel = String(fileID).replace(PREFIX, '');
    const url = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/files/${rel}` : `/files/${rel}`;
    return { fileID, tempFileURL: url, status: 0 };
  });
  return { fileList: out };
}

/**
 * 读取文件
 * @param {{fileID:string}} opt
 * @returns {Promise<{fileContent:Buffer}>}
 */
async function downloadFile(opt) {
  const full = fileIDToPath(opt && opt.fileID);
  if (!fs.existsSync(full)) throw new Error('文件不存在: ' + (opt && opt.fileID));
  return { fileContent: fs.readFileSync(full) };
}

/** 删除文件（忽略不存在） */
async function deleteFile(opt) {
  const list = (opt && opt.fileList) || [];
  list.forEach((fid) => {
    try {
      const full = fileIDToPath(fid);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch (e) { /* ignore */ }
  });
  return { fileList: list.map((f) => ({ fileID: f, status: 0 })) };
}

module.exports = {
  uploadFile,
  getTempFileURL,
  downloadFile,
  deleteFile,
  FILES_DIR,
  PUBLIC_BASE_URL
};
