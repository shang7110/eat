/**
 * 服务端本地自测（不启 HTTP，直接调 handler）
 * 运行：node test-local.js
 */
process.env.SECCHECK_MODE = process.env.SECCHECK_MODE || 'pass';
process.env.DATA_DIR = require('path').join(__dirname, 'data-test');
process.env.FILES_DIR = require('path').join(__dirname, 'data-test', 'files');

const shim = require('./lib/wx-shim');
const { readSize, fitSize } = require('./lib/image');

const OPENID = 'test_openid_001';
const ctx = { openid: OPENID, appid: 'tt_test' };

function call(name, body) {
  const h = require('./handlers/' + name);
  return shim.runWithContext(ctx, () => h.main(body, {}));
}

function line(t) { console.log('\n───── ' + t + ' ─────'); }

(async () => {
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 200) : '')); }
  };

  /* 1. 图片尺寸解析 */
  line('尺寸解析');
  // 构造一个最小 JPEG 头（SOI + SOF0）验证解析
  // 结构：FFD8 | FFC0 | len(2) | precision(1) | height(2) | width(2)
  const jpeg = Buffer.alloc(30);
  jpeg[0] = 0xff; jpeg[1] = 0xd8;
  jpeg[2] = 0xff; jpeg[3] = 0xc0;
  jpeg.writeUInt16BE(17, 4);    // 段长度
  jpeg[6] = 8;                  // 精度
  jpeg.writeUInt16BE(1920, 7);  // 高
  jpeg.writeUInt16BE(1080, 9);  // 宽
  const sz = readSize(jpeg);
  check('JPEG 1080x1920 解析正确', sz && sz.width === 1080 && sz.height === 1920, sz);

  const fit = fitSize(1080, 1920, 2560, 1440);
  check('1080x1920 缩放后高≤1440', fit && fit.height <= 1440, fit);
  check('2560x1440 无需缩放', fitSize(2560, 1440, 2560, 1440) === null);

  /* 2. login */
  line('login');
  const lg = await call('login', { action: 'login' });
  check('返回 openid', lg.code === 0 && lg.data && lg.data.openid === OPENID, lg);
  check('返回 uid', lg.code === 0 && /^U/.test(lg.data.uid || ''), lg.data);

  const cfg = await call('login', { action: 'getConfig' });
  check('getConfig 默认全关', cfg.code === 0 && cfg.data.isShow === false, cfg);

  /* 3. seccheck 跳过 */
  line('seccheck（SECCHECK_MODE=pass）');
  const sc = await call('seccheck', { action: 'checkImage' });
  check('返回 skipped', sc.code === 0 && sc.data && sc.data.skipped === true, sc);

  /* 4. imageErase 各分支 */
  line('imageErase');
  const ping = await call('imageErase', { action: 'ping' });
  check('ping 有 fnVersion', ping.code === 0 && ping.data.fnVersion, ping);

  const q = await call('imageErase', { action: 'quota' });
  check('quota 初始 left=3', q.code === 0 && q.data.left === 3, q);

  const qBefore = (await call('imageErase', { action: 'quota' })).data.left;
  const noKey = await call('imageErase', { action: 'erase', imageBase64: 'aGVsbG8=' });
  check('无密钥返回 -2', noKey.code === -2, noKey);

  const q2 = await call('imageErase', { action: 'quota' });
  check('失败后额度未被扣减', q2.code === 0 && q2.data.left === qBefore, { before: qBefore, after: q2.data.left });

  const noParam = await call('imageErase', { action: 'erase' });
  check('缺参数返回 1', noParam.code === 1, noParam);

  /* 5. hotboard（需外网） */
  line('hotboard（需外网，失败不算致命）');
  try {
    const hb = await call('hotboard', { source: 'douyin' });
    check('返回列表', hb.code === 0 && Array.isArray(hb.data.items) && hb.data.items.length > 0,
      { code: hb.code, n: hb.data && hb.data.items && hb.data.items.length });
  } catch (e) {
    console.log('  ⚠️ 外网不可用，跳过:', e.message);
  }

  /* 6. market（需外网） */
  line('market oil（需外网）');
  try {
    const mk = await call('market', { action: 'oil', province: '北京' });
    check('返回省份油价', mk.code === 0 && mk.data && mk.data.prices && mk.data.prices.length > 0,
      { code: mk.code, msg: mk.msg });
  } catch (e) {
    console.log('  ⚠️ 外网不可用，跳过:', e.message);
  }

  /* 汇总 */
  console.log('\n══════════════════════════════');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('══════════════════════════════');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
