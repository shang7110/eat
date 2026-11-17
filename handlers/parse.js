const cloud = require('../lib/wx-shim')
const https = require('https')
const http = require('http')

/**
 * 解析云函数 v5 —— 2026-11-06 实测通过的抖音提取链路 + 生产化增强
 *
 * 已本地验证的核心流程：
 * 1. 请求分享短链（手机 UA）跟随 302，记录重定向后的"裸路径"
 *    （去掉 did/share_sign 等查询参数——带这些参数会返回无数据壳页）
 * 2. GET 裸路径 → 响应 Set-Cookie 发放 ttwid
 * 3. GET 裸路径（带 ttwid）→ window._ROUTER_DATA
 *    → loaderData["video_(id)/page"].videoInfoRes.item_list[0]
 * 4. 提取 play_addr → playwm 转 play → 无水印 mp4（实测 200 video/mp4）
 * 5. 视频转存云存储（解决正式版 downloadFile 域名白名单限制）
 *
 * 生产化增强（本次新增）：
 * A. ttwid 缓存复用（app_config 集合）：ttwid 长期有效，复用可显著降低触发风控的概率
 * B. 解析失败自动刷新 ttwid 重试一次
 * C. 可选第三方解析接口兜底：在云函数配置里加环境变量 PARSE_API_URL（如
 *    https://api.xxx.com/parse?url=），配置后优先调用，失败再走内置抓取。
 *    抖音风控持续收紧时这是最稳的生产方案，密钥只放云端。
 *
 * 平台结构再调整时：本地跑 node test-local.js "链接" 定位哪一步变化。
 * ⚠️ 云函数超时设 20~60 秒（config.json 已带 timeout: 60）
 */

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
const MAX_REDIRECT = 5
const MAX_VIDEO_SIZE = 50 * 1024 * 1024 // 50MB 上限：云函数内存有限（建议控制台把内存调到 512M），过大的视频直接放弃转存
const TTWID_MAX_AGE = 30 * 24 * 3600 * 1000 // ttwid 缓存 30 天

/** 请求页面/资源，跟随重定向并沿途收集 Cookie，返回 { body, cookie, bareUrl } */
function fetchPage(url, depth = 0, cookies = []) {
  return new Promise((resolve, reject) => {
    if (depth > MAX_REDIRECT) return reject(new Error('重定向次数过多'))
    const mod = url.startsWith('https') ? https : http
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    }
    if (cookies.length) headers['Cookie'] = cookies.join('; ')
    const req = mod.get(url, {
      headers,
      timeout: 15000
    }, (res) => {
      const setc = (res.headers['set-cookie'] || []).map(c => c.split(';')[0])
      setc.forEach(c => { if (!cookies.includes(c)) cookies.push(c) })
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        return resolve(fetchPage(next, depth + 1, cookies).then(r =>
          Object.assign(r, { bareUrl: r.bareUrl || next.split('?')[0] })))
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ body, cookie: cookies.join('; '), bareUrl: url.split('?')[0] }))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('请求超时')))
  })
}

/** 下载二进制资源（重定向 + 大小上限），返回 Buffer */
function fetchBuffer(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > MAX_REDIRECT) return reject(new Error('重定向次数过多'))
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://www.iesdouyin.com/' },
      timeout: 30000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        return resolve(fetchBuffer(next, depth + 1))
      }
      if (res.statusCode !== 200) return reject(new Error('资源响应码 ' + res.statusCode))
      const chunks = []
      let size = 0
      res.on('data', c => {
        size += c.length
        if (size > MAX_VIDEO_SIZE) { req.destroy(); return reject(new Error('文件过大')) }
        chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('下载超时')))
  })
}

function unescapeUrl(u) {
  return String(u).replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&')
}

function pickUrl(u) {
  if (!u) return ''
  if (typeof u === 'string') return unescapeUrl(u)
  const list = u.url_list || []
  const raw = list.length ? list[list.length - 1] : (u.url || '')
  return unescapeUrl(raw)
}

/** 解析 _ROUTER_DATA（兼容 videoInfoRes / video_info_res 两种命名） */
function extractItem(html) {
  const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)
  if (!m) return null
  let router
  try { router = JSON.parse(m[1]) } catch (e) { return null }
  const loader = router.loaderData || {}
  for (const key of Object.keys(loader)) {
    const v = loader[key]
    if (!v || typeof v !== 'object') continue
    const res = v.videoInfoRes || v.video_info_res || v.note_info_res || v.noteInfoRes
    const item = res && res.item_list && res.item_list[0]
    if (item) return item
  }
  return null
}

/** 旧版正则兜底 */
function parseLegacy(html) {
  const pm = html.match(/"playAddr":\s*\[\{[^}]*"src":\s*"([^"]+)"/i)
        || html.match(/"play_addr":\s*\{[^}]*"url_list":\s*\[\s*"([^"]+)"/i)
        || html.match(/(https?:\\?\/\\?\/[^"']+playwm[^"']*)/i)
  if (!pm) return null
  const videoUrl = unescapeUrl(pm[1]).replace('playwm', 'play')
  let cover = ''
  const cm = html.match(/"cover":\s*\{[^}]*"url_list":\s*\[\s*"([^"]+)"/i) || html.match(/"cover":\s*"([^"]+)"/i)
  if (cm) cover = unescapeUrl(cm[1])
  let title = ''
  const tm = html.match(/"desc":\s*"([^"]{1,120})"/i)
  if (tm) title = tm[1]
  let author = ''
  const am = html.match(/"nickname":\s*"([^"]+)"/i)
  if (am) author = am[1]
  return { type: 'video', title, author, cover, videoUrl, images: [] }
}

/** 快手 photoUrl 兜底 */
function parseKuaishou(html) {
  const tm = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const vm = html.match(/"photoUrl":\s*"([^"]+\.mp4[^"]*)"/i)
  if (!vm) return null
  return { type: 'video', title: tm ? tm[1].trim() : '', author: '', cover: '', videoUrl: unescapeUrl(vm[1]), images: [] }
}

/* ---------- ttwid 缓存（app_config 集合，doc id: ttwid） ---------- */
async function getCachedTtwid() {
  try {
    const doc = await cloud.database().collection('app_config').doc('ttwid').get()
    const d = doc.data
    if (d && d.value && d.updatedAt && Date.now() - d.updatedAt < TTWID_MAX_AGE) return d.value
  } catch (e) { /* 不存在或集合未建 */ }
  return ''
}

async function saveTtwid(ttwid) {
  try {
    const db = cloud.database()
    const coll = db.collection('app_config')
    try {
      await coll.doc('ttwid').update({ data: { value: ttwid, updatedAt: Date.now() } })
    } catch (e) {
      await coll.doc('ttwid').set({ data: { value: ttwid, updatedAt: Date.now() } })
    }
  } catch (e) { /* 缓存失败不影响主流程 */ }
}

/** 请求一次裸分享页换新 Cookie：返回 { ttwid, cookies }（cookies 为全套，实测比只带 ttwid 过风控更稳） */
async function fetchFreshCookies(bareUrl) {
  try {
    const r = await fetchPage(bareUrl)
    const cookies = r.cookie ? r.cookie.split('; ').filter(Boolean) : []
    const tc = cookies.find(c => c.startsWith('ttwid=')) || ''
    return { ttwid: tc.slice(6), cookies }
  } catch (e) { return { ttwid: '', cookies: [] } }
}

/** 远端资源转存云存储，返回 { fileID, tempUrl }；失败返回 null */
async function rehostFile(url, ext) {
  try {
    const buf = await fetchBuffer(url)
    if (!buf || buf.length < 10 * 1024) return null
    const cloudPath = 'parse/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + (ext || 'mp4')
    const up = await cloud.uploadFile({ cloudPath, fileContent: buf })
    const tmp = await cloud.getTempFileURL({ fileList: [up.fileID] })
    return { fileID: up.fileID, tempUrl: (tmp.fileList && tmp.fileList[0] && tmp.fileList[0].tempFileURL) || '' }
  } catch (e) {
    console.warn('转存失败:', e.message)
    return null
  }
}

/** item → 标准返回结构（desc 为完整原始文案，供"文案提取"使用；title 截断 120 字用于展示） */
function buildResult(item) {
  const fullDesc = String(item.desc || '').trim()
  const title = fullDesc.slice(0, 120) || '未命名作品'
  const author = (item.author && item.author.nickname) || '未知作者'
  const isImages = Array.isArray(item.images) && item.images.length > 0
  if (isImages) {
    const images = item.images.map(img => pickUrl(img.url_list ? img : img)).filter(Boolean).slice(0, 20)
    return { type: 'images', title, author, cover: images[0] || '', videoUrl: '', videoFileID: '', images, desc: fullDesc }
  }
  const playAddr = item.video && item.video.play_addr
  let playUrl = pickUrl(playAddr)
  if (playUrl.includes('playwm')) playUrl = playUrl.replace('playwm', 'play')
  const cover = pickUrl(item.video && (item.video.origin_cover || item.video.cover))
  return { type: 'video', title, author, cover, videoUrl: playUrl, videoFileID: '', images: [], desc: fullDesc }
}

/** 可选：第三方解析接口兜底（环境变量 PARSE_API_URL，含 {url} 占位符或拼接 ?url=） */
async function parseViaThirdParty(url) {
  const base = process.env.PARSE_API_URL
  if (!base) return null
  try {
    const api = base.includes('{url}') ? base.replace('{url}', encodeURIComponent(url)) : base + (base.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(url)
    const r = await fetchPage(api)
    const data = JSON.parse(r.body)
    const d = data.data || data
    if (d && (d.videoUrl || d.video_url || (d.images && d.images.length))) {
      return {
        type: d.type || (d.videoUrl || d.video_url ? 'video' : 'images'),
        title: d.title || '未命名作品',
        author: d.author || d.authorName || '未知作者',
        cover: d.cover || d.coverUrl || '',
        videoUrl: d.videoUrl || d.video_url || '',
        videoFileID: '',
        images: d.images || []
      }
    }
  } catch (e) { /* 第三方失败，走内置 */ }
  return null
}

/** 内置抓取流程（ttwid 缓存 + 刷新重试），dbg 记录各步状态便于排查 */
async function parseByFetch(url, rehost) {
  const dbg = []
  // 第 1 步：跟短链拿裸路径
  const first = await fetchPage(url)
  const bareUrl = first.bareUrl || url.split('?')[0]
  let item = extractItem(first.body)
  let html = first.body
  dbg.push('p1:' + first.body.length + (first.body.includes('_ROUTER_DATA') ? 'R' : ''))

  if (!item) {
    // 第 2 步：带缓存 ttwid 请求裸路径（无缓存则先现场取全套 Cookie）
    let ttwid = await getCachedTtwid()
    if (ttwid && !ttwid.startsWith('ttwid=')) ttwid = 'ttwid=' + ttwid
    let cookies = ttwid ? [ttwid] : []
    if (!ttwid) {
      const fresh = await fetchFreshCookies(bareUrl)
      dbg.push('fresh:' + (fresh.ttwid ? '1' : '0'))
      if (fresh.ttwid) {
        await saveTtwid(fresh.ttwid)
        ttwid = fresh.ttwid
        cookies = fresh.cookies
      }
    }
    dbg.push('p2:ck' + cookies.length)
    const withCookie = await fetchPage(bareUrl, 0, cookies)
    html = withCookie.body
    item = extractItem(html)
    dbg.push('p2:' + html.length + (html.includes('_ROUTER_DATA') ? 'R' : '') + (item ? '✓' : 'x'))

    // 第 3 步：失败 → 刷新全套 Cookie 重试一次
    if (!item) {
      const fresh = await fetchFreshCookies(bareUrl)
      dbg.push('fresh2:' + (fresh.ttwid ? '1' : '0'))
      if (fresh.ttwid && fresh.ttwid !== ttwid) {
        await saveTtwid(fresh.ttwid)
        const retry = await fetchPage(bareUrl, 0, fresh.cookies)
        html = retry.body
        item = extractItem(html)
        dbg.push('p3:' + html.length + (item ? '✓' : 'x'))
      }
    }
  }

  if (item) return buildResult(item)

  const legacy = parseLegacy(html) || parseKuaishou(html)
  if (legacy) return legacy
  const err = new Error('提取失败 ' + dbg.join('|'))
  err.debug = dbg.join('|')
  throw err
}

async function parseOne(url, opts) {
  // rehost 默认关闭：转存视频要下载+上传大文件，会占住并发槽 10~40 秒，
  // 连续调用时触发平台 -501000 排队超时（实测 493）。改由前端保存时按需调 action=rehost。
  const { rehost } = opts || {}

  let base = null
  // 优先第三方接口（配置了 PARSE_API_URL 时），失败走内置抓取
  const third = await parseViaThirdParty(url)
  if (third) {
    base = third
  } else {
    base = await parseByFetch(url, rehost)
  }

  if (!base) {
    return { code: -1, msg: '未能识别该链接的作品内容：可能被风控限流（稍后重试），或页面结构已调整（本地跑 test-local.js 定位）' }
  }
  if (base.type !== 'video' || !base.videoUrl) {
    return { code: 0, data: base }
  }

  // 仅显式要求时同步转存（当前主流程不再走这里）
  if (rehost) {
    const saved = await rehostFile(base.videoUrl, 'mp4')
    if (saved) {
      base.videoUrl = saved.tempUrl || base.videoUrl
      base.videoFileID = saved.fileID
    }
  }
  return { code: 0, data: base }
}

exports.main = async (event) => {
  // 自检模式：前端「云环境自检」调用，返回云函数版本与数据库集合状态
  if (event.action === 'ping') {
    const checks = {}
    for (const coll of ['app_config', 'parse_records', 'users']) {
      try {
        await cloud.database().collection(coll).limit(1).get()
        checks[coll] = 'ok'
      } catch (e) {
        checks[coll] = 'missing'
      }
    }
    return { code: 0, data: { version: 'v6', env: process.env.TCB_ENV || '', checks } }
  }

  // 按需转存：前端保存相册时对单条资源调用（把抖音 CDN 资源转存云存储，
  // 返回 cloud:// fileID，真机 wx.cloud.downloadFile 不受域名白名单限制）
  if (event.action === 'rehost' && event.url) {
    const saved = await rehostFile(event.url, event.ext || 'mp4')
    if (saved) return { code: 0, data: saved }
    return { code: -1, msg: '转存失败，资源可能已失效，请重新解析' }
  }

  const urls = event.urls && event.urls.length ? event.urls : [event.url]
  if (!urls[0]) return { code: -1, msg: '缺少 url 参数' }

  const results = []
  for (const raw of urls.slice(0, 10)) {
    try {
      const r = await parseOne(raw, { rehost: false }) // 转存已拆分到 action=rehost，避免长执行占并发
      results.push(r)
      if (r.code === 0) {
        try {
          cloud.database().collection('parse_records').add({
            data: { url: raw, result: r.data, createdAt: Date.now() }
          })
        } catch (e) { /* 记录失败不影响主流程 */ }
      }
    } catch (err) {
      results.push({ code: -1, msg: '解析异常：' + (err.message || '网络错误') })
    }
  }
  return results.length === 1 ? results[0] : { code: 0, data: results }
}
