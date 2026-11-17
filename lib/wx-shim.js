/**
 * wx-server-sdk 替身（让原云函数代码几乎零改动跑在普通 Node 服务里）
 * ─────────────────────────────────────────────
 * 原云函数写法：const cloud = require('wx-server-sdk')
 * 迁移后写法：const cloud = require('../lib/wx-shim')
 *
 * 已实现：
 *   cloud.init / DYNAMIC_CURRENT_ENV
 *   cloud.database()                     → lib/db.js
 *   cloud.getWXContext()                 → 从 HTTP 请求上下文取 openid
 *   cloud.uploadFile / getTempFileURL / downloadFile / deleteFile → lib/storage.js
 *
 * 未实现（抖音平台无等价能力）：
 *   cloud.openapi.*  → 调用会抛出带说明的错误，需按抖音开放平台对应接口重写
 */
const { AsyncLocalStorage } = require('async_hooks');
const { db } = require('./db');
const storage = require('./storage');

const als = new AsyncLocalStorage();

/** 每个 HTTP 请求进来时包一层，注入上下文（openid / appid / header） */
function runWithContext(ctx, fn) {
  return als.run(ctx || {}, fn);
}

function getCtx() {
  return als.getStore() || {};
}

function getWXContext() {
  const c = getCtx();
  return {
    OPENID: c.openid || '',
    APPID: c.appid || '',
    UNIONID: '',
    ENV: process.env.CLOUD_ENV || 'prod',
    SOURCE: 'http'
  };
}

/** 未实现能力的统一报错，避免静默失败 */
function unsupported(name) {
  const err = new Error(
    `[wx-shim] ${name} 在抖音端无等价能力，需按抖音开放平台对应接口重写`
  );
  err.errCode = -100;
  err.unsupported = true;
  return err;
}

const openapi = new Proxy({}, {
  get(_t, group) {
    return new Proxy({}, {
      get(_t2, method) {
        return async () => { throw unsupported(`cloud.openapi.${String(group)}.${String(method)}`); };
      }
    });
  }
});

module.exports = {
  DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  init() { /* no-op：服务常驻，无需初始化 */ },

  database() { return db; },
  getWXContext,
  runWithContext,

  uploadFile: (opt) => storage.uploadFile(opt),
  getTempFileURL: (opt) => storage.getTempFileURL(opt),
  downloadFile: (opt) => storage.downloadFile(opt),
  deleteFile: (opt) => storage.deleteFile(opt),

  openapi,

  // 透出，便于 handler 判断
  _internal: { getCtx }
};
