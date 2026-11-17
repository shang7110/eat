/**
 * 行情速览云函数 v3 —— 真实数据，零依赖，无需任何密钥
 *
 * 数据源 1（行情）：新浪财经 hq.sinajs.cn（免费，必须带 Referer）
 *   已实测：A股三大指数 sh000001/sz399001/sz399006
 *           COMEX黄金 hf_GC / 白银 hf_SI
 *           美元兑人民币 fx_susdcny
 *           国际原油 hf_CL 纽约原油(WTI) / hf_OIL 布伦特原油
 * 数据源 2（国内油价）：qiyoujiage.com 各省油价页（实测 31 省全部可抓，含调价窗口预告）
 *   例：http://www.qiyoujiage.com/beijing.shtml
 *       <dt>北京92#汽油</dt><dd>8.89</dd> …
 *       下次油价11月12日24时调整 / 目前预计上调油价90元/吨(0.07元/升-0.08元/升)
 *
 * 缓存：行情 5 分钟、各省油价 60 分钟（成品油每 10 个工作日才调一次，无需高频抓）
 * 合规：仅展示公开行情，不做荐股/交易；前端必须展示"仅供参考"免责声明
 *
 * 说明：国内成品油是"政府指导价"，每 10 个工作日调整一次，因此不是秒级变动的；
 *      国际原油（WTI/布伦特）才是实时跳动价格，两者一起展示。
 */
const cloud = require('../lib/wx-shim')
const db = cloud.database()
const https = require('https')
const http = require('http')
const zlib = require('zlib')

const QUOTE_TTL = 5 * 60 * 1000       // 行情缓存 5 分钟
const OIL_TTL = 60 * 10 * 1000        // 油价缓存 60 分钟

/** 省份白名单：slug 与 qiyoujiage.com 路径严格对应（陕西是 shanxi-3，山西是 shanxi） */
const PROVINCES = {
  beijing: '北京', shanghai: '上海', guangdong: '广东', jiangsu: '江苏',
  zhejiang: '浙江', shandong: '山东', henan: '河南', sichuan: '四川',
  hubei: '湖北', hunan: '湖南', hebei: '河北', fujian: '福建',
  anhui: '安徽', jiangxi: '江西', tianjin: '天津', chongqing: '重庆',
  liaoning: '辽宁', jilin: '吉林', heilongjiang: '黑龙江', shanxi: '山西',
  'shanxi-3': '陕西', neimenggu: '内蒙古', guangxi: '广西', hainan: '海南',
  guizhou: '贵州', yunnan: '云南', xizang: '西藏', gansu: '甘肃',
  qinghai: '青海', ningxia: '宁夏', xinjiang: '新疆'
}
const DEFAULT_PROVINCE = 'beijing'

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9'
}

/** 通用 GET：支持 https/http、302 跳转、gzip 解压，返回 utf8 文本 */
function request(url, headers, timeout = 10000, redirects = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.indexOf('https:') === 0 ? https : http
    const req = mod.get(url, { headers, timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume()
        let next
        try {
          next = new URL(res.headers.location, url).href
        } catch (e) {
          reject(new Error('跳转地址异常'))
          return
        }
        resolve(request(next, headers, timeout, redirects + 1))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error('HTTP ' + res.statusCode))
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let buf = Buffer.concat(chunks)
        const enc = String(res.headers['content-encoding'] || '').toLowerCase()
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf)
          else if (enc === 'deflate') buf = zlib.inflateSync(buf)
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf)
        } catch (e) { /* 解压失败就用原始内容 */ }
        resolve(buf.toString('utf8'))
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('请求超时')))
  })
}

/* ------------------------------ 行情 ------------------------------ */

function fetchQuote() {
  return request('https://hq.sinajs.cn/list=sh000001,sz399001,sz399006,hf_GC,hf_SI,hf_CL,hf_OIL,fx_susdcny', {
    'User-Agent': BROWSER_HEADERS['User-Agent'],
    'Referer': 'https://finance.sina.com.cn' // 新浪行情接口必须带 Referer，否则 403
  })
}

/** 从 var hq_str_xxx="..." 中取引号内内容 */
function extract(body, key) {
  const i = body.indexOf(key)
  if (i < 0) return ''
  const s = body.indexOf('"', i)
  if (s < 0) return ''
  const e = body.indexOf('"', s + 1)
  if (e < 0) return ''
  return body.slice(s + 1, e)
}

/** A股指数：[0]名称(GBK乱码弃用) [1]今开 [2]昨收 [3]最新价 */
function buildIndex(raw, name) {
  if (!raw) return null
  const f = raw.split(',')
  if (f.length < 4) return null
  const prev = parseFloat(f[2])
  const cur = parseFloat(f[3])
  if (!isFinite(prev) || !isFinite(cur) || prev <= 0) return null
  const chg = cur - prev
  return {
    name,
    price: +cur.toFixed(2),
    change: +chg.toFixed(2),
    pct: +(chg / prev * 100).toFixed(2),
    up: chg > 0 ? 1 : (chg < 0 ? -1 : 0)
  }
}

/** 1 金衡盎司 = 31.1034768 克 */
const OZ_TO_GRAM = 31.1034768

/** 外盘商品：[0]最新 [4]最高 [5]最低 [6]时间 [7]昨结 [8]开盘 */
function buildMetal(raw, name, unit) {
  if (!raw) return null
  const f = raw.split(',')
  const cur = parseFloat(f[0])
  const prev = parseFloat(f[7])
  if (!isFinite(cur) || !isFinite(prev) || prev <= 0) return null
  const chg = cur - prev
  return {
    name,
    unit,
    price: +cur.toFixed(2),
    change: +chg.toFixed(2),
    pct: +(chg / prev * 100).toFixed(2),
    up: chg > 0 ? 1 : (chg < 0 ? -1 : 0),
    high: isFinite(parseFloat(f[4])) ? +parseFloat(f[4]).toFixed(2) : null,
    low: isFinite(parseFloat(f[5])) ? +parseFloat(f[5]).toFixed(2) : null
  }
}

/** 折算人民币/克：USD/盎司 × 美元兑人民币 ÷ 31.1034768（国际行情折算价，非金店零售价） */
function toCnyPerGram(metal, usdcny) {
  if (!metal || !isFinite(usdcny) || usdcny <= 0) return null
  const g = metal.price * usdcny / OZ_TO_GRAM
  return +g.toFixed(g < 100 ? 2 : 1)
}

/** 美元兑人民币：[8]最新价 */
function buildForex(raw) {
  if (!raw) return null
  const f = raw.split(',')
  const cur = parseFloat(f[8])
  if (!isFinite(cur)) return null
  return { name: '美元兑人民币', unit: 'CNY', price: +cur.toFixed(4) }
}

async function getMarket() {
  const body = await fetchQuote()
  if (!body || body.indexOf('hq_str_sh000001') < 0) throw new Error('行情数据源无有效返回')

  const forex = buildForex(extract(body, 'fx_susdcny'))
  const usdcny = forex ? forex.price : 0
  const gold = buildMetal(extract(body, 'hq_str_hf_GC'), 'COMEX黄金', '美元/盎司')
  const silver = buildMetal(extract(body, 'hq_str_hf_SI'), 'COMEX白银', '美元/盎司')
  if (gold) gold.cnyPerGram = toCnyPerGram(gold, usdcny)
  if (silver) silver.cnyPerGram = toCnyPerGram(silver, usdcny)

  const data = {
    indices: [
      buildIndex(extract(body, 'hq_str_sh000001'), '上证指数'),
      buildIndex(extract(body, 'hq_str_sz399001'), '深证成指'),
      buildIndex(extract(body, 'hq_str_sz399006'), '创业板指')
    ].filter(Boolean),
    gold,
    silver,
    forex,
    // 国际原油（实时、盘中跳动）
    crudes: [
      buildMetal(extract(body, 'hq_str_hf_CL'), '纽约原油 WTI', '美元/桶'),
      buildMetal(extract(body, 'hq_str_hf_OIL'), '布伦特原油', '美元/桶')
    ].filter(Boolean),
    updatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  }
  if (!data.indices.length) throw new Error('行情数据解析失败，数据源结构可能已调整')
  return data
}

/* ------------------------- 历史日K（折线图） ------------------------- */

const KLINE_TTL = 30 * 60 * 1000 // 日K缓存 30 分钟（盘中最新点是实时价，不能缓存太久）

/** target -> { type, name, sym }（2026-11-10 全部实测通过） */
const KLINE_TARGETS = {
  sh000001: { type: 'index', name: '上证指数', sym: 'sh000001' },
  sz399001: { type: 'index', name: '深证成指', sym: 'sz399001' },
  sz399006: { type: 'index', name: '创业板指', sym: 'sz399006' },
  hf_GC: { type: 'futures', name: 'COMEX黄金', sym: 'GC' },
  hf_SI: { type: 'futures', name: 'COMEX白银', sym: 'SI' },
  hf_CL: { type: 'futures', name: 'WTI原油', sym: 'CL' },
  hf_OIL: { type: 'futures', name: '布伦特原油', sym: 'OIL' },
  fx_susdcny: { type: 'forex', name: '美元汇率', sym: 'fx_susdcny' }
}

/** 剥掉 jsonp 壳：var t=( ... ); → 中间内容 */
function stripJsonp(text) {
  const a = text.indexOf('(')
  const b = text.lastIndexOf(')')
  if (a < 0 || b <= a) throw new Error('日K数据格式异常')
  return text.slice(a + 1, b)
}

/** A股指数日K：JSON 数组（旧→新），datalen 直接可控 */
async function fetchIndexKline(sym, days) {
  const url = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData'
    + '?symbol=' + sym + '&scale=240&ma=no&datalen=' + (days + 2)
  const text = await request(url, {
    'User-Agent': BROWSER_HEADERS['User-Agent'],
    'Referer': 'https://finance.sina.com.cn'
  })
  const arr = JSON.parse(text)
  if (!Array.isArray(arr) || !arr.length) throw new Error('指数日K无数据')
  return arr.map((x) => ({ d: x.day, v: parseFloat(x.close) })).filter((x) => isFinite(x.v))
}

/** 外盘期货日K（黄金/白银/原油）：全量历史 JSONP（旧→新），取尾部 N 条 */
async function fetchFuturesKline(sym, days) {
  const url = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t%3D/'
    + 'GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=' + sym
  const text = await request(url, {
    'User-Agent': BROWSER_HEADERS['User-Agent'],
    'Referer': 'https://finance.sina.com.cn'
  })
  const arr = JSON.parse(stripJsonp(text))
  if (!Array.isArray(arr) || !arr.length) throw new Error('外盘日K无数据')
  return arr.slice(-days).map((x) => ({ d: x.date, v: parseFloat(x.close) })).filter((x) => isFinite(x.v))
}

/** 外汇日K：jsonp 字符串 "日期,开,低,高,收|..."（旧→新），取尾部 N 条 */
async function fetchForexKline(sym, days) {
  const url = 'https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/var%20t%3D/'
    + 'NewForexService.getDayKLine?symbol=' + sym
  const text = await request(url, {
    'User-Agent': BROWSER_HEADERS['User-Agent'],
    'Referer': 'https://finance.sina.com.cn'
  })
  const inner = stripJsonp(text)
  const raw = inner.replace(/^"|"$/g, '')
  const rows = raw.split('|').filter(Boolean)
  if (!rows.length) throw new Error('外汇日K无数据')
  return rows.slice(-days).map((r) => {
    const f = r.split(',')
    return { d: f[0], v: parseFloat(f[4]) } // [0]日期 [4]收盘
  }).filter((x) => isFinite(x.v))
}

async function getKline(target, daysInput) {
  const conf = KLINE_TARGETS[target]
  if (!conf) return { code: -1, msg: '不支持的走势品种' }
  const days = [7, 15, 30].indexOf(Number(daysInput)) >= 0 ? Number(daysInput) : 30
  const cacheKey = 'kline_cache_v1_' + target + '_' + days

  // 1. 缓存（30 分钟；过期数据留作抓取失败兜底）
  let stale = null
  try {
    const c = await db.collection('app_config').where({ key: cacheKey }).limit(1).get()
    const doc = c.data && c.data[0]
    if (doc && doc.value) {
      if (doc.ts && Date.now() - doc.ts < KLINE_TTL) return { code: 0, data: doc.value, cached: true }
      stale = doc.value
    }
  } catch (e) { /* 集合不存在不阻塞 */ }

  // 2. 按类型实抓
  try {
    let points
    if (conf.type === 'index') points = await fetchIndexKline(conf.sym, days)
    else if (conf.type === 'futures') points = await fetchFuturesKline(conf.sym, days)
    else points = await fetchForexKline(conf.sym, days)

    if (points.length < 2) throw new Error('日K数据点不足')
    points = points.slice(-days)
    const first = points[0].v
    const last = points[points.length - 1].v
    const chg = last - first
    const data = {
      target,
      name: conf.name,
      days,
      unit: conf.type === 'futures' ? (target === 'hf_GC' || target === 'hf_SI' ? '美元/盎司' : '美元/桶')
        : (conf.type === 'forex' ? 'CNY' : '点'),
      points,
      first,
      last,
      chg: +chg.toFixed(2),
      pct: +(chg / first * 100).toFixed(2),
      up: chg > 0 ? 1 : (chg < 0 ? -1 : 0),
      updatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    }

    try {
      const c = await db.collection('app_config').where({ key: cacheKey }).limit(1).get()
      if (c.data && c.data[0]) {
        await db.collection('app_config').doc(c.data[0]._id).update({ data: { ts: Date.now(), value: data } })
      } else {
        await db.collection('app_config').add({ data: { key: cacheKey, ts: Date.now(), value: data } })
      }
    } catch (e) { /* 缓存失败不阻塞 */ }
    return { code: 0, data }
  } catch (e) {
    if (stale) return { code: 0, data: stale, cached: true, stale: true }
    return { code: -1, msg: '走势数据获取失败（' + String(e.message || '').slice(0, 60) + '）' }
  }
}

/* ---------------------------- 国内油价 ---------------------------- */

/** 抓取某省油价页：https 优先，失败回落 http（部分网络环境 https 握手失败） */
async function fetchOilPage(slug) {
  const headers = Object.assign({}, BROWSER_HEADERS, { 'Referer': 'http://www.qiyoujiage.com/' })
  const hosts = ['https://www.qiyoujiage.com', 'http://www.qiyoujiage.com']
  let lastErr = null
  for (let i = 0; i < hosts.length; i++) {
    try {
      const html = await request(hosts[i] + '/' + slug + '.shtml', headers, 12000)
      if (html && html.indexOf('<dt>') >= 0) return html
      lastErr = new Error('页面内容异常')
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('油价页面获取失败')
}

/**
 * 主数据源：公开油价接口（省级，含 89/92/95/98/0# 五个油品）
 * 实测 2026-11-13：31 省全部可用，时间戳为当日，与各省发改委调价公告一致
 * （山东 92# 8.33 / 95# 8.94 / 0# 7.96，与山东省发改委 11-12 24 时公告完全吻合）
 * ⚠️ 汽油价格网（qiyoujiage）调价后滞后 12~24 小时未刷新，故降为兜底源
 */
async function fetchOilApi(provinceName) {
  const url = 'https://api.qqsuu.cn/api/dm-oilprice?prov=' + encodeURIComponent(provinceName)
  const txt = await request(url, Object.assign({}, BROWSER_HEADERS, { 'Referer': 'https://api.qqsuu.cn/' }), 8000)
  const j = JSON.parse(txt)
  if (!j || j.code !== 200 || !j.data) throw new Error('接口返回异常')
  const d = j.data
  if (d.prov !== provinceName) throw new Error('省份不匹配：' + d.prov)

  const defs = [
    ['g92', '92# 汽油', d.p92],
    ['g95', '95# 汽油', d.p95],
    ['g98', '98# 汽油', d.p98],
    ['d0', '0# 柴油', d.p0],
    ['g89', '89# 汽油', d.p89]
  ]
  const prices = []
  defs.forEach((item) => {
    const n = parseFloat(item[2])
    if (isFinite(n) && n > 0) prices.push({ key: item[0], name: item[1], price: +n.toFixed(2), unit: '元/升' })
  })
  if (!prices.length) throw new Error('接口无有效价格')
  return { prices, dataTime: d.time || '' }
}

/** 以北京时间取"现在"（云函数运行在 UTC，日期推算必须偏移 8 小时） */
function cnNow() {
  return new Date(Date.now() + 8 * 3600 * 1000)
}

/** 解析「11月12日24时」→ 北京时间 Date（按当年/次年就近匹配） */
function parseAdjustDate(str) {
  const m = /([0-9]{1,2})月([0-9]{1,2})日/.exec(str || '')
  if (!m) return null
  const now = cnNow()
  const mo = Number(m[1]) - 1
  const day = Number(m[2])
  let d = new Date(Date.UTC(now.getUTCFullYear(), mo, day, 24, 0, 0))
  // 若比"今天"早半年以上，视为明年的窗口
  if (d.getTime() - now.getTime() < -180 * 86400000) d = new Date(Date.UTC(now.getUTCFullYear() + 1, mo, day, 24, 0, 0))
  return d
}

/** 把「生效时刻」格式化为「X月X日24时」（24 时生效 = 次日 0 点，故日期回退一天） */
function fmtAdjustDate(instant) {
  const d = new Date(instant - 86400000)
  return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日24时'
}

/**
 * 推算调价窗口：
 * - 站点给的"下次调价时间"若还没到 → 直接用它
 * - 若已过 → 该窗口即"上次调价"，下个窗口按 +14 天估算（约 10 个工作日）
 */
function resolveAdjustWindow(pageNext) {
  const out = { nextAdjustAt: '', lastAdjustAt: '', executed: false }
  if (!pageNext) return out
  const d = parseAdjustDate(pageNext)
  if (!d) { out.nextAdjustAt = pageNext; return out }

  const now = cnNow()
  const effectAt = d.getTime() + 0 // 24 时即次日 0 点，已体现在 Date 构造里
  if (effectAt > now.getTime()) {
    out.nextAdjustAt = pageNext
    return out
  }
  out.lastAdjustAt = pageNext
  out.nextAdjustAt = fmtAdjustDate(new Date(effectAt + 14 * 86400000))
  out.executed = (now.getTime() - effectAt) <= 72 * 3600000 // 3 天内视为"本轮刚调价"
  return out
}

/** 从页面解析「下次油价11月12日24时调整」 */
function parseNextAdjust(html) {
  const nm = /下次油价\s*([0-9]{1,2}月[0-9]{1,2}日[0-9]{1,2}时)\s*调整/.exec(html || '')
  return nm ? nm[1] : ''
}

/** 解析省内 4 个油品价格 + 下次调价窗口时间 */
function parseOil(html, provinceName) {
  // 只截取油价区域，避免抓到页面上其他 dl（加油站列表等）
  let area = html
  const a = html.indexOf('id="youjia"')
  if (a >= 0) {
    const b = html.indexOf('下次油价', a)
    area = html.slice(a, b > a ? b : a + 3000)
  }

  const prices = []
  const re = /<dt>([^<]*)<\/dt>\s*<dd>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/dd>/g
  let m
  while ((m = re.exec(area)) !== null) {
    const label = m[1] || ''
    const price = parseFloat(m[2])
    if (!isFinite(price) || price <= 0) continue
    let key = ''
    let name = ''
    if (label.indexOf('92') >= 0) { key = 'g92'; name = '92# 汽油' }
    else if (label.indexOf('95') >= 0) { key = 'g95'; name = '95# 汽油' }
    else if (label.indexOf('98') >= 0) { key = 'g98'; name = '98# 汽油' }
    else if (label.indexOf('柴油') >= 0 || label.indexOf('0#') >= 0) { key = 'd0'; name = '0# 柴油' }
    else continue
    if (prices.some((p) => p.key === key)) continue
    prices.push({ key, name, price: +price.toFixed(2), unit: '元/升' })
  }

  // 下次调价窗口：如「下次油价11月12日24时调整」
  let nextAdjustAt = ''
  const nm = html.match(/下次油价\s*([0-9]{1,2}月[0-9]{1,2}日[0-9]{1,2}时)\s*调整/)
  if (nm) nextAdjustAt = nm[1]

  // ⚠️ 不再采用该站的"目前预计上调/下调"文字：
  // 2026-11-10 实测该站仍写"预计上调90元/吨"，而权威媒体（央视网/光明网 11-09）
  // 均为"预计下调280~300元/吨"——该站预测滞后于国际油价暴跌，属错误信息，弃用。
  // 调价方向改为 calcAdjustForecast() 按国际油价日K自行推算。

  return {
    province: provinceName,
    slug: '',
    prices,
    nextAdjustAt,
    nextAdjustTip: '',
    perLiter: '',
    trend: 'flat'
  }
}

/**
 * 自算调价方向（近似"原油变化率"）：
 * 布伦特近 10 个交易日均价 ÷ 再前 10 个交易日均价 - 1
 * 变化率 ≤ -1% 视为预计下调、≥ +1% 预计上调、其间视为不作调整（搁浅）。
 * 注：发改委用的是官方一揽子原油与上轮调价基准价，此处只能近似方向，幅度不可推算。
 */
function calcAdjustForecast() {
  return fetchFuturesKline('OIL', 25).then((pts) => {
    const closes = pts.map((p) => p.v)
    if (closes.length < 21) return null
    const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length
    const recent = avg(closes.slice(-10))
    const prev = avg(closes.slice(-20, -10))
    const rate = recent / prev - 1
    let trend = 'flat'
    if (rate <= -0.01) trend = 'down'
    else if (rate >= 0.01) trend = 'up'

    // 粗略估算调价幅度（元/吨）：
    // 官方机制锚点（2026-11-09 央视网等报道：变化率 -5.10% ↔ 下调 280 元/吨）
    // 反推敏感度 ≈ 55 元/吨 per 1%，隐含基准价约 5500 元/吨（不含税出厂口径）。
    // 1 吨 92# 汽油约 1350 升（密度 0.74kg/L），用于折算元/升。
    // ⚠️ 仅为方向一致的粗估（误差可到 ±20%），精确幅度以发改委公告为准。
    let magnitude = ''
    if (trend !== 'flat') {
      const tonAdj = Math.round(Math.abs(rate) * 100 * 55) // 元/吨
      const literAdj = (tonAdj / 1350).toFixed(2)          // 元/升
      magnitude = '约 ' + tonAdj + ' 元/吨（约 ' + literAdj + ' 元/升）'
      // 变化率超过 ±10% 属异常波动：本估算敏感度是线性外推，误差会显著放大，需强化免责
      if (Math.abs(rate) > 0.1) {
        magnitude += '（本轮国际油价波动异常大，此估算误差较高，请以发改委公告为准）'
      }
    }

    return {
      trend,
      rate: +(rate * 100).toFixed(2),
      tip: trend === 'down' ? '近期国际油价走低，预计下调'
        : trend === 'up' ? '近期国际油价走高，预计上调'
        : '近期国际油价波动不大，预计不作调整',
      magnitude
    }
  })
}

async function getOil(provinceInput) {
  const slug = PROVINCES[provinceInput] ? provinceInput : DEFAULT_PROVINCE
  const provinceName = PROVINCES[slug]
  const cacheKey = 'oil_cache_v4_' + slug // v4：主源换为省级油价接口（调价后即时更新），v3 旧缓存作废

  // 1. 读缓存（60 分钟内直接用；过期的先留着，抓取失败时兜底）
  let stale = null
  try {
    const c = await db.collection('app_config').where({ key: cacheKey }).limit(1).get()
    const doc = c.data && c.data[0]
    if (doc && doc.value) {
      if (doc.ts && Date.now() - doc.ts < OIL_TTL) {
        return { code: 0, data: doc.value, cached: true }
      }
      stale = doc.value
    }
  } catch (e) {
    console.warn('读油价缓存失败:', e.message)
  }

  // 2. 实抓：主源（省级接口）与兜底源（汽油价格网，用于调价窗口）并行
  try {
    const results = await Promise.all([
      fetchOilApi(provinceName).catch((e) => { console.warn('油价接口失败:', e.message); return null }),
      fetchOilPage(slug).catch((e) => { console.warn('油价页失败:', e.message); return null })
    ])
    const api = results[0]
    const html = results[1]

    let data = null
    if (api) {
      data = {
        province: provinceName,
        slug,
        prices: api.prices,
        dataTime: api.dataTime,
        source: 'api',
        trend: 'flat',
        nextAdjustTip: ''
      }
    } else if (html) {
      data = parseOil(html, provinceName)
      data.slug = slug
      data.source = 'site'
      data.dataTime = ''
    }
    if (!data || !data.prices.length) throw new Error('未获取到油价数据')

    // 调价窗口：站点给"上次/下次调价"，已执行则推算下一轮
    const pageNext = html ? parseNextAdjust(html) : ''
    const win = resolveAdjustWindow(pageNext)
    data.nextAdjustAt = win.nextAdjustAt
    data.lastAdjustAt = win.lastAdjustAt
    data.executed = win.executed

    data.updatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

    // 调价方向：本轮刚执行则不再预测（滚动的 10 日均价对比在调价后会失真）
    if (win.executed) {
      data.trend = 'executed'
      if (data.source === 'api') {
        data.nextAdjustTip = '本轮调价已于 ' + win.lastAdjustAt + ' 执行，当前为调价后新价格'
      } else {
        // 兜底源（汽油价格网）调价后常滞后 12~24 小时，不能谎称已是新价
        data.unsynced = true
        data.nextAdjustTip = '本轮调价已于 ' + win.lastAdjustAt + ' 执行；备用数据源尚未同步新价，以下可能仍为调价前价格，请以加油站标价为准'
      }
    } else {
      try {
        const fc = await calcAdjustForecast()
        if (fc) {
          data.trend = fc.trend
          data.nextAdjustTip = fc.tip + (fc.magnitude ? fc.magnitude : '')
            + '（按国际油价测算 ' + (fc.rate >= 0 ? '+' : '') + fc.rate + '%）'
        }
      } catch (e) {
        console.warn('调价方向推算失败:', e.message)
      }
    }

    try {
      const c = await db.collection('app_config').where({ key: cacheKey }).limit(1).get()
      if (c.data && c.data[0]) {
        await db.collection('app_config').doc(c.data[0]._id).update({ data: { ts: Date.now(), value: data } })
      } else {
        await db.collection('app_config').add({ data: { key: cacheKey, ts: Date.now(), value: data } })
      }
    } catch (e) {
      console.warn('写油价缓存失败:', e.message)
    }
    return { code: 0, data, cached: false }
  } catch (e) {
    // 抓取失败：有上次真实数据就返回（标记 stale），绝不返回编造数据
    if (stale) return { code: 0, data: stale, cached: true, stale: true }
    return { code: -1, msg: '油价数据获取失败，请稍后重试（' + String(e.message || '').slice(0, 60) + '）' }
  }
}

/* ------------------------------ 汇率（货币换算） ------------------------------ */

/** 新浪外汇接口实测支持的 11 个币种（韩元/加元符号曾探测失败者已剔除，加元 fx_scadcny 实测可用） */
const FX_LIST = [
  { sym: 'fx_susdcny', name: '美元' },
  { sym: 'fx_seurcny', name: '欧元' },
  { sym: 'fx_sjpycny', name: '日元' },
  { sym: 'fx_sgbpcny', name: '英镑' },
  { sym: 'fx_shkdcny', name: '港币' },
  { sym: 'fx_ssgdcny', name: '新加坡元' },
  { sym: 'fx_saudcny', name: '澳元' },
  { sym: 'fx_scadcny', name: '加元' },
  { sym: 'fx_schfcny', name: '瑞士法郎' },
  { sym: 'fx_sthbcny', name: '泰铢' },
  { sym: 'fx_snzdcny', name: '新西兰元' }
]
const FX_TTL = 10 * 60 * 1000 // 汇率缓存 10 分钟

async function getFx() {
  const cacheKey = 'fx_cache_v1'

  // 1. 读缓存
  try {
    const c = await db.collection('app_config').where({ key: cacheKey }).limit(1).get()
    const doc = c.data && c.data[0]
    if (doc && doc.ts && Date.now() - doc.ts < FX_TTL && doc.value) {
      return { code: 0, data: doc.value, cached: true }
    }
  } catch (e) { /* 集合不存在等，忽略走实抓 */ }

  // 2. 实抓（rate = 1 单位外币兑人民币）
  try {
    const syms = FX_LIST.map((x) => x.sym).join(',')
    const body = await request('https://hq.sinajs.cn/list=' + syms, {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Referer': 'https://finance.sina.com.cn' // 必带 Referer
    })
    const rates = []
    for (const item of FX_LIST) {
      const raw = extract(body, item.sym)
      if (!raw) continue
      const f = raw.split(',')
      const rate = parseFloat(f[1])
      if (!isFinite(rate) || rate <= 0) continue
      rates.push({ code: item.sym.replace('fx_s', '').replace('cny', '').toUpperCase(), name: item.name, rate: +rate })
    }
    if (rates.length < 3) throw new Error('汇率解析数量不足')
    const data = {
      base: 'CNY',
      rates,
      updatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    }
    try {
      const c = await db.collection('app_config').where({ key: cacheKey }).limit(1).get()
      if (c.data && c.data[0]) {
        await db.collection('app_config').doc(c.data[0]._id).update({ data: { ts: Date.now(), value: data } })
      } else {
        await db.collection('app_config').add({ data: { key: cacheKey, ts: Date.now(), value: data } })
      }
    } catch (e) { /* 缓存失败不影响返回 */ }
    return { code: 0, data, cached: false }
  } catch (e) {
    // 3. 兜底：上次真实汇率（标 stale），绝不编造
    try {
      const c = await db.collection('app_config').where({ key: cacheKey }).limit(1).get()
      const doc = c.data && c.data[0]
      if (doc && doc.value) return { code: 0, data: doc.value, cached: true, stale: true }
    } catch (e2) { /* 无缓存 */ }
    return { code: -1, msg: '汇率获取失败，请稍后重试（' + String(e.message || '').slice(0, 60) + '）' }
  }
}

/* ------------------------------ 入口 ------------------------------ */

exports.main = async (event) => {
  const action = (event && event.action) || 'market'
  if (action === 'oil') return getOil(event && event.province)
  if (action === 'kline') return getKline(event && event.target, event && event.days)
  if (action === 'fx') return getFx()

  // 行情：走 5 分钟缓存，抓取失败时退回上次真实数据（stale）
  let staleQuote = null
  try {
    const cache = await db.collection('app_config').where({ key: 'market_cache_v3' }).limit(1).get()
    const doc = cache.data && cache.data[0]
    if (doc && doc.value) {
      if (doc.ts && Date.now() - doc.ts < QUOTE_TTL) {
        return { code: 0, data: doc.value, cached: true }
      }
      staleQuote = doc.value
    }
  } catch (e) {
    console.warn('读缓存失败（app_config 集合可能未创建）:', e.message)
  }

  try {
    const data = await getMarket()
    try {
      const cache = await db.collection('app_config').where({ key: 'market_cache_v3' }).limit(1).get()
      if (cache.data && cache.data[0]) {
        await db.collection('app_config').doc(cache.data[0]._id).update({ data: { ts: Date.now(), value: data } })
      } else {
        await db.collection('app_config').add({ data: { key: 'market_cache_v3', ts: Date.now(), value: data } })
      }
    } catch (e) {
      console.warn('写缓存失败:', e.message)
    }
    return { code: 0, data, cached: false }
  } catch (e) {
    if (staleQuote) return { code: 0, data: staleQuote, cached: true, stale: true }
    return { code: -1, msg: '行情数据获取失败，请稍后重试（' + String(e.message || '').slice(0, 60) + '）' }
  }
}
