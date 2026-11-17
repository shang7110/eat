/**
 * 秒去水印 —— 抖音云托管后端入口
 * ─────────────────────────────────────────────────────────
 * 原微信云函数（parse / login / market / hotboard / imageErase / seccheck）
 * 在这里按路径路由，业务逻辑原样复用（见 handlers/）。
 *
 * 前端调用方式（抖音端）：
 *   tt.createCloud({envID}).callContainer({ path:'/parse', init:{ method:'POST', body } })
 *
 * 启动：node index.js（云托管需监听 PORT，默认 8080）
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const wxShim = require('./lib/wx-shim');
const storage = require('./lib/storage');
const { flush } = require('./lib/db');

// ⚠️ 抖音云硬性要求：服务「能且只能」监听 8000 端口，否则发布后冷启动超时
//    官方文档：代码规范与风格指南 → https://developer.open-douyin.com/docs/resource/zh-CN/developer/tools/cloud/function-service/cloud-service/container-service/code-format
//    本地调试可用 PORT 覆盖（默认 8000，与线上保持一致，避免部署才发现问题）
const PORT = process.env.PORT || 8000;
const FN_VERSION = 'v1-douyin-20261117';

// 生产建议设为 false：只信任平台注入的 header，避免前端伪造 openid 绕过配额
const ALLOW_BODY_OPENID = process.env.ALLOW_BODY_OPENID !== 'false';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

/* ---------------- 静态文件（AI 服务需要公网可访问的图片 URL） ---------------- */
app.use('/files', express.static(storage.FILES_DIR, {
  maxAge: '1d',
  setHeaders(res) { res.setHeader('Access-Control-Allow-Origin', '*'); }
}));

/* ---------------- openid 提取 ----------------
 * 抖音云托管通过 callContainer 调用时会注入用户身份头，具体字段名以官方文档为准。
 * 这里做了多来源兜底，联调时可在日志中确认实际命中的是哪一个。
 */
function pickOpenid(req) {
  const h = req.headers || {};
  const fromHeader =
    h['x-tt-openid'] ||
    h['x-douyin-openid'] ||
    h['x-tt-user-openid'] ||
    h['openid'] ||
    h['x-wx-openid'] ||        // 兼容微信云托管
    '';
  if (fromHeader) return { openid: fromHeader, source: 'header' };
  if (ALLOW_BODY_OPENID) {
    const body = req.body || {};
    const fromBody = body.openid || body.OPENID || (req.query && req.query.openid) || '';
    if (fromBody) return { openid: fromBody, source: 'body' };
  }
  return { openid: '', source: 'none' };
}

/* ---------------- 健康检查 ---------------- */
// 抖音云要求业务必须实现 GET /v1/ping，平台靠它的 200 状态判断实例存活，
// 缺失会一直判为不健康、部署失败
app.get('/v1/ping', (req, res) => {
  res.status(200).json({ code: 0, msg: 'pong', fnVersion: FN_VERSION, time: Date.now() });
});
app.get('/ping', (req, res) => {
  res.status(200).json({ code: 0, msg: 'pong', fnVersion: FN_VERSION, time: Date.now() });
});

app.get('/', (req, res) => {
  res.json({ code: 0, msg: 'miao-erase-server', fnVersion: FN_VERSION, time: Date.now() });
});
app.get('/health', (req, res) => {
  res.json({
    code: 0,
    fnVersion: FN_VERSION,
    publicBaseUrl: storage.PUBLIC_BASE_URL || '(未配置，AI 接口可能拿不到图片)',
    hasVolcKey: !!process.env.VOLC_API_KEY,
    hasAliKey: !!process.env.DASHSCOPE_API_KEY,
    time: Date.now()
  });
});

/* ---------------- 备用上传接口 ----------------
 * 前端优先用抖音云 SDK 的 cloud.uploadFile；
 * 若该能力不可用，可改走 POST /upload（multipart），返回公网 url。
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ code: 1, msg: '缺少文件' });
    const ext = (path.extname(req.file.originalname || '') || '.jpg').toLowerCase();
    const cloudPath = `upload/${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`;
    const up = await storage.uploadFile({ cloudPath, fileContent: req.file.buffer });
    const t = await storage.getTempFileURL({ fileList: [up.fileID] });
    res.json({ code: 0, data: { fileID: up.fileID, url: t.fileList[0].tempFileURL } });
  } catch (e) {
    console.error('[upload] 失败:', e.message);
    res.status(500).json({ code: -1, msg: e.message });
  }
});

/* ---------------- 业务路由 ---------------- */
const HANDLERS = ['parse', 'login', 'market', 'hotboard', 'imageErase', 'seccheck'];

HANDLERS.forEach((name) => {
  app.post('/' + name, async (req, res) => {
    const t0 = Date.now();
    const { openid, source } = pickOpenid(req);
    const body = Object.assign({}, req.body || {});
    // login 通过 event 取 openid 的场景：这里是唯一可信来源，覆盖 body 中的值
    body.__openidSource = source;

    const ctx = {
      openid,
      appid: req.headers['x-tt-appid'] || req.headers['x-wx-appid'] || '',
      headers: req.headers
    };

    try {
      const handler = require('./handlers/' + name);
      if (typeof handler.main !== 'function') {
        return res.status(500).json({ code: -1, msg: `handler ${name} 缺少 main` });
      }
      // 抖音 callContainer 的 path 不带参数，openid 通过 body 透传给业务
      if (!body.openid && openid) body.openid = openid;

      const result = await wxShim.runWithContext(ctx, () => handler.main(body, { source: 'http' }));
      const cost = Date.now() - t0;
      if (cost > 3000) console.log(`[slow] /${name} ${cost}ms`);
      res.json(result);
    } catch (e) {
      console.error(`[${name}] 执行失败 (${Date.now() - t0}ms):`, e && e.message);
      res.status(200).json({
        code: -1,
        msg: (e && e.message) || '服务端异常',
        fnVersion: FN_VERSION,
        unsupported: !!(e && e.unsupported)
      });
    }
  });
});

/* ---------------- 兜底 ---------------- */
app.use((req, res) => {
  res.status(404).json({ code: 1, msg: '未知接口: ' + req.method + ' ' + req.path, fnVersion: FN_VERSION });
});

const server = app.listen(PORT, () => {
  console.log(`[server] 已启动 http://0.0.0.0:${PORT}  ${FN_VERSION}`);
  console.log('[server] 健康检查: GET /v1/ping 与 GET /health');
  console.log('[server] PUBLIC_BASE_URL =', storage.PUBLIC_BASE_URL || '(未配置)');
  console.log('[server] FILES_DIR =', storage.FILES_DIR);
  console.log('[server] 路由:', HANDLERS.map((n) => '/' + n).join(' ') + ' /upload /files /health /v1/ping');
  if (PORT !== 8000) console.warn('[server] ⚠️ 抖音云只接受 8000 端口，当前为 ' + PORT + '，线上会启动失败');
});

// AI 处理可能耗时较长，放宽连接超时
server.timeout = 150000;
server.keepAliveTimeout = 65000;

/* ---------------- 优雅退出：落盘 ---------------- */
['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, () => {
    console.log('[server] 收到', sig, '，正在落盘退出…');
    flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
});
process.on('uncaughtException', (e) => {
  console.error('[server] 未捕获异常:', e && e.stack);
});
process.on('unhandledRejection', (e) => {
  console.error('[server] 未处理 Promise 拒绝:', e && (e.stack || e.message || e));
});
