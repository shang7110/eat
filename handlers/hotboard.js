/**
 * hotboard 云函数：热榜（抖音热榜 / 百度热搜，双源互备）
 * - douyin：https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/  （50 条，词+热度，无摘要）
 * - baidu ：https://top.baidu.com/board?tab=realtime                     （30 条，词+热度+摘要）
 * 均为免费无密钥公开接口；单源失败自动切另一源，并回退各自上一次真实缓存（stale 标记），绝不编造数据
 */
const cloud = require('../lib/wx-shim')

const db = cloud.database()

const CACHE_TTL = 10 * 60 * 1000 // 10 分钟
const CACHE_KEYS = { douyin: 'hotboard_dy_v1', baidu: 'hotboard_bd_v1' }
const MAX_ITEMS = 30

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function fetchText(url, ua) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('https') : require('http')
    const req = mod.get(url, { headers: { 'User-Agent': ua, Accept: '*/*' }, timeout: 12000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode))
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve(body))
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
  })
}

/** 解码 JSON 字符串转义（\uXXXX 等） */
function jstr(s) {
  try {
    return JSON.parse('"' + s + '"')
  } catch (e) {
    return s || ''
  }
}

/** 抖音热榜：标准 JSON 的 word_list */
function parseDouyin(body) {
  const d = JSON.parse(body)
  const list = (d && d.word_list) || []
  return list.slice(0, MAX_ITEMS).map((w) => ({
    word: w.word || '',
    hot: Number(w.hot_value) || 0,
    desc: ''
  })).filter((x) => x.word)
}

/** 百度热搜：HTML 内嵌条目对象（每条含 word/desc/hotScore） */
function parseBaidu(html) {
  const items = []
  const re = /\{[^{}]*"word":[^{}]*\}/g
  let m
  while ((m = re.exec(html)) !== null) {
    const obj = m[0]
    const wm = obj.match(/"word":"((?:[^"\\]|\\.)*)"/)
    if (!wm) continue
    const word = jstr(wm[1])
    if (!word || items.some((x) => x.word === word)) continue
    const dm = obj.match(/"desc":"((?:[^"\\]|\\.)*)"/)
    const hm = obj.match(/"hotScore":"?(\d+)"?/)
    items.push({
      word,
      desc: dm ? jstr(dm[1]).slice(0, 120) : '',
      hot: hm ? Number(hm[1]) : 0
    })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

async function readCache(source) {
  try {
    const c = await db.collection('app_config').where({ key: CACHE_KEYS[source] }).limit(1).get()
    return (c.data && c.data[0]) || null
  } catch (e) {
    console.warn('读热榜缓存失败（app_config 未建？）:', e.message)
    return null
  }
}

async function writeCache(source, data) {
  try {
    const c = await db.collection('app_config').where({ key: CACHE_KEYS[source] }).limit(1).get()
    if (c.data && c.data[0]) {
      await db.collection('app_config').doc(c.data[0]._id).update({ data: { ts: Date.now(), value: data } })
    } else {
      await db.collection('app_config').add({ data: { key: CACHE_KEYS[source], ts: Date.now(), value: data } })
    }
  } catch (e) {
    console.warn('写热榜缓存失败:', e.message)
  }
}

/** 抓单个源；成功返回 data，失败返回 null 并记下 stale 缓存 */
async function fetchSource(source) {
  const doc = await readCache(source)
  if (doc && doc.value && doc.ts && Date.now() - doc.ts < CACHE_TTL) {
    return { data: doc.value, cached: true }
  }
  const stale = doc && doc.value ? doc.value : null

  try {
    let items
    if (source === 'douyin') {
      items = parseDouyin(await fetchText('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/', UA))
    } else {
      items = parseBaidu(await fetchText('https://top.baidu.com/board?tab=realtime', UA_PC))
    }
    if (!items.length) throw new Error('未解析到条目')
    const data = {
      source,
      items,
      updatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    }
    await writeCache(source, data)
    return { data, cached: false }
  } catch (e) {
    console.warn('抓取失败[' + source + ']:', e.message)
    if (stale) return { data: stale, cached: true, stale: true }
    return null
  }
}

exports.main = async (event) => {
  const want = event && event.source === 'baidu' ? 'baidu' : 'douyin'
  const other = want === 'douyin' ? 'baidu' : 'douyin'

  // 1. 首选源
  const r1 = await fetchSource(want)
  if (r1) return { code: 0, data: r1.data, cached: r1.cached, stale: r1.stale === true }

  // 2. 首选挂了，尝试另一源（页面会以 source 字段提示实际来源）
  const r2 = await fetchSource(other)
  if (r2) return { code: 0, data: r2.data, cached: r2.cached, stale: r2.stale === true, fallback: true }

  return { code: -1, msg: '热榜数据获取失败，请稍后重试' }
}
