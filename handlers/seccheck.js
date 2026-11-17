/**
 * seccheck 云函数：用户上传图片的内容安全检测
 *
 * 流程（security.mediaCheckAsync 为异步接口）：
 *  1. 前端把图片传云存储，调用本云函数 action=checkImage（带 fileID）
 *  2. 本函数生成 trace_id → 临时链接 → 调 openapi.security.mediaCheckAsync 送检
 *  3. 微信异步推送审核结果（event.Event === 'wxa_media_check'）到本云函数
 *     ⚠️ 需在小程序后台「开发管理-消息推送」中启用并选择「云开发-云函数接收」，指定 seccheck
 *  4. 前端 action=getResult 按 traceId 轮询结果：pass 放行，risky 拦截并提示
 *
 * 结果落库：app_config 集合，doc _id = 'seccheck_' + traceId
 * 注：推送事件字段名（trace_id/result.suggest）以微信官方文档「安全检测 security.mediaCheckAsync」为准，
 *     官方文档：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/sec-center/sec-check/mediaCheckAsync.html
 */
const cloud = require('../lib/wx-shim')

const db = cloud.database()

const DOC_PREFIX = 'seccheck_'

// 云函数版本号：前端 Console 会打印它，用来确认云端跑的是不是最新代码
// （改了代码但没执行「上传并部署」，云端仍是旧版本，报错不会变化）
const FN_VERSION = 'v4-20261117'

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  // ===== 1. 微信异步审核结果推送（消息推送回调） =====
  // mediaCheckAsync 的检测结果以事件形式推送，事件名 wxa_media_check（字段名以官方文档核实）
  const ev = event || {}
  if (ev.Event === 'wxa_media_check' || ev.event === 'wxa_media_check') {
    const traceId = ev.trace_id || ev.traceId || ''
    const suggest = (ev.result && (ev.result.suggest || ev.result.Suggest)) || ''
    // 打日志：用于确认「云开发-设置-其他设置-消息推送」是否真的把结果推进来了
    console.log('[seccheck] 收到检测结果推送:', JSON.stringify(ev).slice(0, 800))
    if (!traceId) return { errCode: 0, errMsg: 'missing trace_id' }
    const status = String(suggest).toLowerCase() === 'risky' ? 'risky' : 'pass'
    try {
      await db.collection('app_config').doc(DOC_PREFIX + traceId).update({
        data: {
          status,
          suggest,
          detail: ev.result || {},
          checkedAt: Date.now()
        }
      })
    } catch (e) {
      // 记录不存在（可能已过期清理），忽略
      console.warn('seccheck 结果落库失败:', e.message)
    }
    return { errCode: 0, errMsg: 'ok' }
  }

  // 其他类型消息（如客服消息 text）若被绑定到本云函数，直接忽略并打日志，
  // 避免当成送检调用去处理（也便于发现「某个二元组被误绑到这里」）
  if (ev.MsgType) {
    console.log('[seccheck] 忽略非检测类消息推送:', ev.MsgType, ev.Event || '(无事件)')
    return { errCode: 0, errMsg: 'ignored' }
  }

  // ===== 2. 前端调用 =====
  const action = ev.action || 'checkImage'

  if (action === 'checkImage') {
    // ⚠️ 抖音平台没有微信的 security.mediaCheckAsync 等价接口（cloud.openapi 在抖音端不可用）。
    //    这里的处理由环境变量 SECCHECK_MODE 控制：
    //      pass   （默认）跳过检测、直接放行，返回 skipped 标记并打日志
    //      strict 直接拒绝，功能不可用（等接入抖音内容安全能力后再开）
    //    👉 上线前请务必确认抖音开放平台的内容安全要求，接入对应能力后改回 strict，
    //       详见 抖音小程序/README.md 的「内容安全」章节。
    const secMode = process.env.SECCHECK_MODE || 'pass'
    if (secMode !== 'strict') {
      const skipId = 'skipped_' + Date.now().toString(36)
      console.warn('[seccheck] 当前平台未接入内容安全接口，已跳过检测（SECCHECK_MODE=' + secMode + '）')
      return {
        code: 0,
        data: { traceId: skipId, skipped: true },
        unsupported: true,
        msg: '当前平台未接入内容安全检测，已跳过',
        fnVersion: 'v1-douyin-20261117'
      }
    }

    const fileID = ev.fileID
    if (!fileID) return { code: 1, msg: '缺少 fileID' }

    const traceId = 's' + Date.now().toString(36) + Math.floor(Math.random() * 100000).toString(36)

    // 云存储 → 临时外链（mediaCheckAsync 要求可访问的 url）
    let url = ''
    try {
      const res = await cloud.getTempFileURL({ fileList: [fileID] })
      url = res.fileList && res.fileList[0] && res.fileList[0].tempFileURL
    } catch (e) {
      return { code: 1, msg: '获取图片链接失败' }
    }
    if (!url) return { code: 1, msg: '获取图片链接失败' }

    // 任务落库放在送检成功之后，用「服务端返回的 trace_id」作为 _id
    //   （若用自造 traceId 而服务端返回的是它自己生成的，回调就对不上，结果永远查不到）

    // 官方必填参数：media_url / media_type / version / scene / openid
    //   scene 场景枚举：1 资料、2 评论、3 论坛、4 社交日志 —— 用户上传图片自行处理取 1
    // 命名风格：官方说明「云调用出入参和 HTTPS 调用相同」（下划线），但部分 wx-server-sdk 版本会做驼峰→下划线转换。
    // 两种风格报错都是 47001 data format error，无法从错误码区分，故先驼峰、失败再下划线各试一次。
    // traceId 32 位以内字母数字，便于回查推送结果。
    const payloadCamel = {
      mediaUrl: url,
      mediaType: 2,      // 2 = 图片
      version: 2,
      scene: 1,
      openid: OPENID,
      traceId
    }
    const payloadSnake = {
      media_url: url,
      media_type: 2,
      version: 2,
      scene: 1,
      openid: OPENID,
      trace_id: traceId
    }

    let lastErr = null
    let okRes = null
    let okStyle = ''
    const attempts = []
    for (const [style, payload] of [
      ['camel', payloadCamel],
      ['snake', payloadSnake],
      // 兜底：部分环境对 trace_id 校验较严，去掉它再试一次（此时用服务端返回的 trace_id 关联）
      ['camel-no-trace', { mediaUrl: url, mediaType: 2, version: 2, scene: 1, openid: OPENID }]
    ]) {
      try {
        okRes = await cloud.openapi.security.mediaCheckAsync(payload)
        okStyle = style
        break
      } catch (e) {
        lastErr = e
        const errMsg = e.errMsg || e.message || ''
        const item = {
          style,
          errCode: e.errCode || '',
          errMsg: errMsg.replace(/ rid: .*$/, '')   // 去掉 rid 便于对比
        }
        attempts.push(item)
        console.error('[seccheck] 失败', JSON.stringify(item),
          'urlHost=' + (url.split('/')[2] || ''),
          'urlLen=' + url.length,
          'openid=' + (OPENID ? OPENID.slice(0, 6) + '***' : 'EMPTY'),
          'traceId=' + traceId)
      }
    }

    // ===== 送检成功 =====
    if (okRes) {
      // 关键：以服务端返回的 trace_id 为准（异步推送里带的也是它），自造的 traceId 可能不被采用
      const effTraceId = (okRes && (okRes.trace_id || okRes.traceId)) || traceId
      console.log('[seccheck] 送检成功 style=' + okStyle, 'traceId=' + effTraceId, '返回=' + JSON.stringify(okRes))
      // 建 pending 记录，等消息推送回来更新为 pass/risky
      try {
        await db.collection('app_config').add({
          data: {
            _id: DOC_PREFIX + effTraceId,
            type: 'image',
            fileID,
            openid: OPENID,
            style: okStyle,
            status: 'pending',
            createdAt: Date.now()
          }
        })
      } catch (e) {
        // 已存在（推送比建库还快，或重复送检）——忽略，不覆盖已有状态
        console.warn('[seccheck] pending 记录已存在:', e.message)
      }
      return { code: 0, data: { traceId: effTraceId }, fnVersion: FN_VERSION, style: okStyle }
    }

    // 全部风格都失败：标记 fail，前端不放行；诊断信息随返回值带给前端打印
    {
      const e = lastErr || {}
      try {
        await db.collection('app_config').add({
          data: {
            _id: DOC_PREFIX + traceId,
            type: 'image',
            fileID,
            openid: OPENID,
            status: 'fail',
            errMsg: e.errMsg || e.message || '',
            checkedAt: Date.now(),
            createdAt: Date.now()
          }
        })
      } catch (e2) { /* ignore */ }
      return {
        code: -1,
        msg: e.errMsg || e.message || '送检失败',
        fnVersion: FN_VERSION,
        diag: {
          openid: OPENID ? OPENID.slice(0, 6) + '***' : 'EMPTY',
          urlHost: url.split('/')[2] || '',
          urlLen: url.length,
          hasScene: true,
          attempts
        }
      }
    }
  }

  if (action === 'getResult') {
    const traceId = ev.traceId
    if (!traceId) return { code: 1, msg: '缺少 traceId' }
    try {
      const r = await db.collection('app_config').doc(DOC_PREFIX + traceId).get()
      const d = r.data || {}
      return { code: 0, data: { status: d.status || 'pending', suggest: d.suggest || '' } }
    } catch (e) {
      return { code: 0, data: { status: 'pending' } }
    }
  }

  return { code: 1, msg: '未知 action: ' + action }
}
