/**
 * imageErase 云函数：AI 去水印（双供应商，火山引擎为主 / 阿里云百炼兜底）
 *
 * ===== 供应商 A：火山引擎 AI MediaKit 图像擦除修复（默认，0.00138 元/张）=====
 * 文档：https://docs.volcengine.com/docs/6448/2479104
 *   POST https://mediakit.cn-beijing.volces.com/api/v1/tools-sync/erase-image
 *   header: Authorization: Bearer <API Key>
 *   body:   { image_url, standard_scene, output_format }
 *   同步接口，直接返回 result.image_url（有效期 24 小时）
 *   standard_scene：
 *     full_screen_text_erase  全屏文字擦除（默认，自动检测，无需蒙版）
 *     full_screen_icon_erase  全屏图标擦除（logo 类）
 *     selected_area_erase     指定区域（需 selected_area 或 mask_url）
 *   限制：宽 ≤2560 且 高 ≤1440（横竖都按这个上限，1080x1920 竖图会被拒）
 *        单图 ≤10MB，支持 jpg/png/webp/bmp/tiff/heic
 *
 * ===== 供应商 B：阿里云百炼「万相-通用图像编辑」（兜底，0.14 元/张）=====
 * 异步：提交任务 → 轮询 → 取结果；宽高 [512,4096]，分辨率上限更宽松。
 * 火山失败（含尺寸不支持）时自动回落，保证功能不中断。
 *
 * ===== 环境变量（云开发控制台 → 云函数 → imageErase → 配置）=====
 *   VOLC_API_KEY        火山引擎 AI MediaKit 专用 API Key（配了就优先走火山）
 *   DASHSCOPE_API_KEY   阿里云百炼 API Key（可选的兜底通道）
 *   ERASE_PROVIDER      可选，强制指定 volc / ali；不填则按 Key 自动选
 *   密钥只放环境变量，禁止写入代码
 *
 * 返回结果统一转存云存储（两家给的链接都只有 24 小时有效期）
 */
const cloud = require('../lib/wx-shim')
const { fitToLimit } = require('../lib/image')
const https = require('https')
const { URL } = require('url')

const db = cloud.database()
const _ = db.command

const FN_VERSION = 'v3-20261117'

/* ---------- 每日额度（防刷）----------
 * 集合 erase_quota，文档 _id = `${openid}_${YYYYMMDD}`（北京时间）
 * 字段 { openid, date, count, createdAt, updatedAt }
 * 先 inc(1) 占额度再处理，超过上限则退还；处理失败也退还 → 并发也不会超刷
 * 上限用环境变量 ERASE_DAILY_LIMIT 配置，默认 3
 */
const QUOTA_COLL = 'erase_quota'
const DAILY_LIMIT = (() => {
  const n = parseInt(process.env.ERASE_DAILY_LIMIT || '3', 10)
  return Number.isFinite(n) && n > 0 ? n : 3
})()

/** 北京时间日期键 YYYYMMDD（云函数运行在 UTC） */
function cnDateKey() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return '' + y + m + day
}

async function ensureQuotaDoc(openid, dateKey) {
  const _id = openid + '_' + dateKey
  const payload = {
    data: { _id, openid, date: dateKey, count: 0, createdAt: Date.now(), updatedAt: Date.now() }
  }
  try {
    await db.collection(QUOTA_COLL).add(payload)
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || '')
    // 集合不存在时先建集合再写一次；文档已存在则忽略
    if (/not exist|COLLECTION_NOT_EXIST/i.test(msg)) {
      try { await db.createCollection(QUOTA_COLL) } catch (e2) { /* 已存在 */ }
      try { await db.collection(QUOTA_COLL).add(payload) } catch (e3) { /* 已存在 */ }
    }
  }
  return _id
}

/** 占一次额度：返回 { ok, used, left }，超限自动退还 */
async function consumeQuota(openid) {
  const dateKey = cnDateKey()
  const _id = await ensureQuotaDoc(openid, dateKey)
  try {
    await db.collection(QUOTA_COLL).doc(_id).update({
      data: { count: _.inc(1), updatedAt: Date.now() }
    })
    const doc = await db.collection(QUOTA_COLL).doc(_id).get()
    const used = (doc.data && doc.data.count) || 0
    if (used > DAILY_LIMIT) {
      await refundQuota(_id)
      return { ok: false, used: DAILY_LIMIT, left: 0, limit: DAILY_LIMIT, date: dateKey }
    }
    return { ok: true, used, left: Math.max(0, DAILY_LIMIT - used), limit: DAILY_LIMIT, date: dateKey }
  } catch (e) {
    // 计数失败不应阻断主流程（宁可放行也不要因统计问题让功能不可用），但要留痕
    console.error('[imageErase][quota] 计数失败:', e.message)
    return { ok: true, used: 0, left: DAILY_LIMIT, limit: DAILY_LIMIT, date: dateKey, degraded: true }
  }
}

async function refundQuota(_id) {
  try {
    await db.collection(QUOTA_COLL).doc(_id).update({
      data: { count: _.inc(-1), updatedAt: Date.now() }
    })
  } catch (e) { /* ignore */ }
}

/** 只读查询剩余次数（不占额度） */
async function peekQuota(openid) {
  const dateKey = cnDateKey()
  const _id = openid + '_' + dateKey
  try {
    const doc = await db.collection(QUOTA_COLL).doc(_id).get()
    const used = (doc.data && doc.data.count) || 0
    return { used, left: Math.max(0, DAILY_LIMIT - used), limit: DAILY_LIMIT, date: dateKey }
  } catch (e) {
    return { used: 0, left: DAILY_LIMIT, limit: DAILY_LIMIT, date: dateKey }
  }
}

const VOLC_KEY = process.env.VOLC_API_KEY || ''
const VOLC_ENDPOINT =
  process.env.VOLC_ERASE_ENDPOINT ||
  'https://mediakit.cn-beijing.volces.com/api/v1/tools-sync/erase-image'

const ALI_KEY = process.env.DASHSCOPE_API_KEY || ''
const ALI_DOMAIN = process.env.DASHSCOPE_DOMAIN || 'https://dashscope.aliyuncs.com'

const FORCE_PROVIDER = String(process.env.ERASE_PROVIDER || '').toLowerCase()

/** 通用 JSON 请求（Node 原生 https，避免额外依赖） */
function requestJSON(urlStr, { method = 'POST', headers = {}, body, timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null
    const opt = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
        headers
      ),
      timeout
    }
    const req = https.request(opt, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch (e) { /* 非 JSON 原样返回 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(json || { raw: data })
        } else {
          const err = new Error((json && (json.message || json.code)) || ('HTTP ' + res.statusCode))
          err.statusCode = res.statusCode
          err.body = json || data
          reject(err)
        }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时')) })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 下载二进制（用于把结果图转存云存储） */
function downloadBuffer(urlStr, depth = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    https.get({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      timeout: 30000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
        res.resume()
        downloadBuffer(res.headers.location, depth + 1).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error('下载失败 HTTP ' + res.statusCode))
        res.resume()
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================= 供应商 A：火山引擎（同步，快且便宜） ================= */

async function eraseByVolc(imageUrl, opts) {
  const scene = opts.scene || 'full_screen_text_erase'
  const body = {
    image_url: imageUrl,
    standard_scene: scene,
    // 必须显式指定：默认输出 webp，而小程序保存相册对 webp 支持很差
    output_format: 'jpeg'
  }
  // 指定区域模式（前端传了归一化坐标才用）
  if (scene === 'selected_area_erase' && opts.area) body.selected_area = opts.area

  const t0 = Date.now()
  let res = null
  try {
    res = await requestJSON(VOLC_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + VOLC_KEY },
      body
    })
  } catch (e) {
    console.error('[imageErase][volc] 请求异常:', e.message, JSON.stringify(e.body || {}).slice(0, 300))
    return { ok: false, provider: 'volc', msg: '火山接口调用失败：' + (e.message || '未知错误'), raw: e.body }
  }

  if (!res || res.success !== true) {
    const err = (res && res.error) || {}
    console.error('[imageErase][volc] 处理失败:', JSON.stringify(err).slice(0, 400))
    return {
      ok: false,
      provider: 'volc',
      msg: err.message || '火山去水印失败',
      code: err.code || '',
      raw: err
    }
  }

  const url = (res.result && res.result.image_url) || ''
  if (!url) {
    return { ok: false, provider: 'volc', msg: '火山未返回结果图' }
  }
  console.log(
    '[imageErase][volc] 成功 耗时=' + (Date.now() - t0) + 'ms',
    'size=' + ((res.result && res.result.image_size) || 0),
    'fmt=' + ((res.result && res.result.image_format) || '')
  )
  return { ok: true, provider: 'volc', url, costMs: Date.now() - t0 }
}

/* ================= 供应商 B：阿里云百炼（异步，兜底） ================= */

async function eraseByAli(imageUrl) {
  let taskId = ''
  try {
    const submit = await requestJSON(ALI_DOMAIN + '/api/v1/services/aigc/image2image/image-synthesis', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + ALI_KEY, 'X-DashScope-Async': 'enable' },
      body: {
        model: 'wanx2.1-imageedit',
        input: {
          function: 'remove_watermark',
          prompt: '去除图像中的文字',
          base_image_url: imageUrl
        },
        parameters: { n: 1 }
      }
    })
    taskId = (submit && submit.output && submit.output.task_id) || ''
    if (!taskId) {
      console.error('[imageErase][ali] 创建任务失败:', JSON.stringify(submit).slice(0, 300))
      return { ok: false, provider: 'ali', msg: (submit && (submit.message || submit.code)) || '创建任务失败' }
    }
  } catch (e) {
    console.error('[imageErase][ali] 创建任务异常:', e.message)
    return { ok: false, provider: 'ali', msg: '创建任务失败：' + (e.message || '未知错误') }
  }

  const deadline = Date.now() + 35000
  let lastStatus = ''
  while (Date.now() < deadline) {
    await sleep(2000)
    let q = null
    try {
      q = await requestJSON(ALI_DOMAIN + '/api/v1/tasks/' + taskId, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + ALI_KEY }
      })
    } catch (e) {
      console.warn('[imageErase][ali] 查询异常:', e.message)
      continue
    }
    const out = (q && q.output) || {}
    lastStatus = out.task_status || ''
    if (lastStatus === 'SUCCEEDED') {
      const arr = out.results || []
      const one = arr.find((it) => it && it.url)
      if (one && one.url) return { ok: true, provider: 'ali', url: one.url }
      return { ok: false, provider: 'ali', msg: '任务成功但无结果图' }
    }
    if (lastStatus === 'FAILED' || lastStatus === 'CANCELED' || lastStatus === 'UNKNOWN') {
      console.error('[imageErase][ali] 任务失败:', lastStatus, JSON.stringify(out).slice(0, 300))
      return { ok: false, provider: 'ali', msg: out.message || ('任务处理失败：' + lastStatus) }
    }
  }
  return { ok: false, provider: 'ali', msg: '处理超时（状态 ' + (lastStatus || '未知') + '）' }
}

/* ================= 路由与主流程 ================= */

function pickProviders() {
  const order = []
  if (FORCE_PROVIDER === 'volc') {
    if (VOLC_KEY) order.push('volc')
    if (ALI_KEY) order.push('ali')
  } else if (FORCE_PROVIDER === 'ali') {
    if (ALI_KEY) order.push('ali')
  } else {
    // 默认：火山优先（便宜 100 倍），阿里兜底
    if (VOLC_KEY) order.push('volc')
    if (ALI_KEY) order.push('ali')
  }
  return order
}

exports.main = async (event, context) => {
  const ev = event || {}
  const action = ev.action || 'erase'
  const OPENID = (cloud.getWXContext() || {}).OPENID || ''

  if (action === 'ping') {
    const order = pickProviders()
    return {
      code: 0,
      data: {
        fnVersion: FN_VERSION,
        provider: order[0] || '',
        fallback: order.slice(1),
        volcKeyReady: !!VOLC_KEY,
        aliKeyReady: !!ALI_KEY,
        endpoint: VOLC_ENDPOINT
      }
    }
  }

  if (action === 'quota') {
    // 只读查询剩余次数，不占额度（前端进页面时展示用）
    if (!OPENID) {
      return { code: 0, data: { left: DAILY_LIMIT, limit: DAILY_LIMIT, used: 0, anonymous: true }, fnVersion: FN_VERSION }
    }
    const q = await peekQuota(OPENID)
    return { code: 0, data: q, fnVersion: FN_VERSION }
  }

  if (action !== 'erase') {
    return { code: 1, msg: '未知 action: ' + action, fnVersion: FN_VERSION }
  }

  let fileID = ev.fileID
  if (!fileID && !ev.imageBase64) return { code: 1, msg: '缺少 fileID 或 imageBase64', fnVersion: FN_VERSION }

  const providers = pickProviders()
  if (!providers.length) {
    return {
      code: -2,
      msg: '未配置任何去水印密钥：请在云函数环境变量中填写 VOLC_API_KEY（火山，推荐）或 DASHSCOPE_API_KEY（阿里）',
      fnVersion: FN_VERSION
    }
  }

  // 1. 每日额度：先占位（inc），超限立即退还并拒绝；处理失败也会退还
  let quota = null
  let quotaId = ''
  if (OPENID) {
    const q = await consumeQuota(OPENID)
    quotaId = OPENID + '_' + q.date
    if (!q.ok) {
      console.warn('[imageErase][quota] 超限 openid=' + OPENID.slice(0, 6) + '*** date=' + q.date)
      return {
        code: -429,
        msg: '今日免费额度已用完（每天 ' + q.limit + ' 张），明天再来吧',
        quota: q,
        fnVersion: FN_VERSION
      }
    }
    quota = q
  } else {
    console.warn('[imageErase][quota] 无 openid，跳过额度检查（云端测试调用？）')
  }

  // 2. 取图片内容：支持两种入参
  //    - fileID：微信端 / 已上传到云存储（走临时链接）
  //    - imageBase64：抖音端直传数据（callContainer 免域名白名单，不依赖云存储）
  let imageUrl = ''
  let rawBuffer = null

  if (ev.imageBase64) {
    try {
      rawBuffer = Buffer.from(String(ev.imageBase64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    } catch (e) {
      rawBuffer = null;
    }
    if (!rawBuffer || !rawBuffer.length) {
      if (quotaId) await refundQuota(quotaId)
      return { code: -3, msg: '图片数据解析失败', fnVersion: FN_VERSION }
    }
    try {
      const up0 = await cloud.uploadFile({
        cloudPath: 'erase-in/' + Date.now() + '-' + Math.floor(Math.random() * 10000) + '.jpg',
        fileContent: rawBuffer
      })
      const t0 = await cloud.getTempFileURL({ fileList: [up0.fileID] })
      imageUrl = (t0.fileList && t0.fileList[0] && t0.fileList[0].tempFileURL) || ''
      fileID = up0.fileID
    } catch (e) {
      if (quotaId) await refundQuota(quotaId)
      return { code: -3, msg: '图片暂存失败：' + e.message, fnVersion: FN_VERSION }
    }
  } else {
    try {
      const r = await cloud.getTempFileURL({ fileList: [fileID] })
      imageUrl = (r.fileList && r.fileList[0] && r.fileList[0].tempFileURL) || ''
    } catch (e) {
      if (quotaId) await refundQuota(quotaId)
      return { code: -3, msg: '获取图片链接失败', fnVersion: FN_VERSION }
    }
  }

  if (!imageUrl) {
    if (quotaId) await refundQuota(quotaId)
    return { code: -3, msg: '获取图片链接失败', fnVersion: FN_VERSION }
  }

  // 2.5 尺寸合规（火山：宽 ≤2560 且 高 ≤1440；抖音端前端无法指定压缩尺寸，统一在此处理）
  try {
    if (!rawBuffer) {
      const dl = await cloud.downloadFile({ fileID })
      rawBuffer = dl && dl.fileContent
    }
    if (rawBuffer && rawBuffer.length) {
      const fitted = await fitToLimit(rawBuffer, 2560, 1440)
      if (fitted.changed) {
        const upFit = await cloud.uploadFile({
          cloudPath: 'erase-fit/' + Date.now() + '-' + Math.floor(Math.random() * 10000) + '.jpg',
          fileContent: fitted.buffer
        })
        const tFit = await cloud.getTempFileURL({ fileList: [upFit.fileID] })
        const newUrl = (tFit.fileList && tFit.fileList[0] && tFit.fileList[0].tempFileURL) || ''
        if (newUrl) {
          imageUrl = newUrl
          console.log('[imageErase] 尺寸重绘:', fitted.note)
        }
      }
    }
  } catch (e) {
    console.warn('[imageErase] 尺寸处理跳过:', e && e.message)
  }

  // 3. 按顺序尝试（火山失败 → 阿里）
  const attempts = []
  let hit = null
  for (const p of providers) {
    const r = p === 'volc'
      ? await eraseByVolc(imageUrl, { scene: ev.scene, area: ev.area })
      : await eraseByAli(imageUrl)
    attempts.push({ provider: p, ok: r.ok, msg: r.msg || '', code: r.code || '' })
    if (r.ok) { hit = r; break }
  }

  if (!hit) {
    const last = attempts[attempts.length - 1] || {}
    console.error('[imageErase] 全部供应商失败:', JSON.stringify(attempts).slice(0, 500))
    // 没处理成功不扣次数
    if (quotaId) await refundQuota(quotaId)
    return {
      code: -5,
      msg: last.msg || '去水印失败',
      attempts,
      quota: quota ? { used: Math.max(0, quota.used - 1), left: quota.left + 1, limit: quota.limit } : null,
      fnVersion: FN_VERSION
    }
  }

  // 4. 结果图转存云存储（两家链接都只有 24 小时有效期）
  const ext = /\.png(\?|$)/i.test(hit.url) ? 'png' : 'jpg'
  try {
    const buf = await downloadBuffer(hit.url)
    const up = await cloud.uploadFile({
      cloudPath: 'erase/' + Date.now() + '-' + Math.floor(Math.random() * 10000) + '.' + ext,
      fileContent: buf
    })
    const t = await cloud.getTempFileURL({ fileList: [up.fileID] })
    const previewUrl = (t.fileList && t.fileList[0] && t.fileList[0].tempFileURL) || ''
    console.log(
      '[imageErase] 完成 provider=' + hit.provider,
      'size=' + buf.length,
      '今日已用=' + (quota ? quota.used + '/' + quota.limit : '未统计'),
      up.fileID
    )
    return {
      code: 0,
      data: {
        fileID: up.fileID,
        url: previewUrl,
        provider: hit.provider,
        costMs: hit.costMs || 0
      },
      quota,
      attempts,
      fnVersion: FN_VERSION
    }
  } catch (e) {
    console.error('[imageErase] 转存失败:', e.message)
    // 转存失败也把结果链接给前端，至少能先看效果
    return {
      code: 0,
      data: { fileID: '', url: hit.url, provider: hit.provider },
      quota,
      attempts,
      fnVersion: FN_VERSION
    }
  }
}
