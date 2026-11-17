const cloud = require('../lib/wx-shim')

/**
 * 登录云函数：获取 openid 并生成/绑定本应用 UID
 * 返回：{ code:0, data:{ openid, uid, isNew } }
 *
 * action=getConfig：返回工具页展示开关（读 app_config 集合 doc "tools_switch"）
 * 控制方式：云开发控制台 → 数据库 → app_config → 新建/编辑文档 _id="tools_switch"：
 *   { "isShow": false, "lottery": false, "md5": false }
 *   改为 true 即展示对应入口（无需发版，前端下次进工具页生效）
 * 默认（文档不存在/读取失败）全部 false，保证审核安全
 */
const DEFAULT_SWITCHES = { isShow: false, lottery: false, md5: false }

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const db = cloud.database()

  // 工具页展示开关（云端可配）
  if (event.action === 'getConfig') {
    try {
      const r = await db.collection('app_config').doc('tools_switch').get()
      const d = r.data || {}
      return {
        code: 0,
        data: {
          isShow: d.isShow === true,
          lottery: d.lottery === true,
          md5: d.md5 === true
        }
      }
    } catch (e) {
      // 文档不存在 → 默认全关
      return { code: 0, data: { ...DEFAULT_SWITCHES } }
    }
  }

  const users = db.collection('users')

  try {
    const existed = await users.where({ openid: OPENID }).limit(1).get()
    if (existed.data.length > 0) {
      const u = existed.data[0]
      return { code: 0, data: { openid: OPENID, uid: u.uid, isNew: false } }
    }

    // 新用户：生成 UID（U + 时间戳后6位 + 2位随机）
    const uid = 'U' + String(Date.now()).slice(-6) + Math.floor(Math.random() * 90 + 10)
    await users.add({
      data: {
        openid: OPENID,
        uid,
        createdAt: Date.now(),
        inviteBy: event.inviteBy || ''   // 邀请关系绑定（分享 path 带 uid 参数时）
      }
    })
    return { code: 0, data: { openid: OPENID, uid, isNew: true } }
  } catch (err) {
    return { code: -1, msg: '登录失败：' + (err.message || '数据库异常，请确认已创建 users 集合') }
  }
}
