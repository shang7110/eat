# 秒去水印 · 抖音云后端

微信云函数迁移过来的 Node HTTP 服务，部署在**抖音云**，由小程序通过 `tt.createCloud().callContainer()` 调用。

## 平台硬性要求（不满足会发布失败）

| 要求 | 说明 |
|---|---|
| 只监听 **8000** 端口 | 其他端口会报 `Function cold start timeout` |
| 必须实现 `GET /v1/ping` 返回 200 | 平台靠它判断实例存活 |
| 服务必须无状态 | 不能依赖本地落盘数据，容器回收即丢 |

## 目录结构

```
├── index.js            Express 入口：路由分发 + 健康检查
├── handlers/           业务处理，一个文件对应原微信一个云函数
│   ├── parse.js        视频/图集解析
│   ├── login.js        登录 + 云端配置（工具开关）
│   ├── market.js       行情 / 油价
│   ├── hotboard.js     热榜
│   ├── imageErase.js   图片去水印（火山为主、阿里兜底、每日限额）
│   └── seccheck.js     内容安全检测（抖音端默认跳过）
├── lib/
│   ├── wx-shim.js      wx-server-sdk 替身（AsyncLocalStorage 传 openid）
│   ├── db.js           JSON 文档库（可换 MongoDB）
│   ├── storage.js      本地文件 + 公网 URL
│   └── image.js        按供应商限制重绘尺寸
├── run.sh              容器启动脚本（需 chmod a+x）
├── Dockerfile          自定义镜像用；模板部署时平台自动生成
└── test-local.js       本地自测（14 项断言）
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `PUBLIC_BASE_URL` | 是 | 服务外网域名，AI 服务靠它拉图 |
| `VOLC_API_KEY` | 是 | 火山引擎 AI MediaKit Key（去水印主通道） |
| `DASHSCOPE_API_KEY` | 否 | 阿里百炼 Key，兜底通道 |
| `ERASE_PROVIDER` | 否 | `volc` / `ali` 强制通道 |
| `ERASE_DAILY_LIMIT` | 否 | 每日免费张数，默认 3 |
| `SECCHECK_MODE` | 否 | `pass` 跳过检测 / `strict` 强制 |
| `ALLOW_BODY_OPENID` | 否 | 上线设 `false`，否则前端可伪造 openid 刷额度 |
| `TZ` | 否 | 建议 `Asia/Shanghai`，仅影响日志时间 |

## 本地运行

```bash
npm install
node test-local.js            # 14 项断言，不需要启服务
node index.js                 # 监听 8000
curl http://127.0.0.1:8000/v1/ping
```

## 部署

1. 抖音云「服务设置」开启**模版部署**：Node.js 18 lts，启动命令 `npm start`
2. 本仓库作为代码来源，分支 `main`
3. 部署到 DEV → 验证 `/v1/ping` 返回 200 → 上线到线上
4. 环境变量改完需**重新发布**才生效

详细说明见上一级目录的 `README.md` 与 `迁移报告.md`。
