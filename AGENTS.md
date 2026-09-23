# Jev AI 归屿维护指南

## 项目定位

这是一个本机运行的文件、文件夹、照片和视频整理工具。React + Vite 负责界面，Node.js 负责本机 API、文件扫描、路径校验、移动、日志和撤销。媒体元数据由 macOS Swift helper 读取，TypeSafe AI 只用于普通文件和文件夹的分类建议。

## 目录职责

- `ui/`：React 页面、表格行组件、浏览器状态和样式。
- `src/server.js`：本地 HTTP 服务、会话令牌、接口校验和静态资源服务。
- `src/organizer.js`：扫描、文件身份校验、目标目录创建、移动、回滚、恢复和撤销。
- `src/inbox-store.js`：收件箱配置和独立分类体系的持久化。
- `src/pending-store.js`：跨重启待处理项目、分类建议和源身份失效状态。
- `src/classifier.js`：TypeSafe SDK 分类适配；只发送普通项目元数据。
- `src/media-scanner.js`、`src/media-rules.js`：媒体识别、Live Photo 成组、日期和地点规则。
- `src/media-native.js`、`native/MediaMetadata/`：Swift helper 的构建、JSON 协议和 macOS 媒体元数据读取。
- `public/media-paths.js`：浏览器和服务端共用的媒体目标路径校验规则。
- `test/`：Node 单元、HTTP、媒体和安全回归测试。
- `e2e/`：Playwright 浏览器流程测试。

## 开发命令

```sh
npm install
npm run dev       # 启动 Node API
npm run dev:ui    # 启动 Vite 前端
npm run build     # 构建 dist/
npm run check     # Node 语法检查和前端构建
npm test          # 完整 Node 测试
npm run test:e2e  # Playwright 测试
```

生产启动前先构建前端。若已删除开发依赖，使用 `node --env-file-if-exists=.env src/server.js` 启动，不要再次执行会调用 Vite 的 `npm start`。

## 修改原则

- 新功能先写能失败的测试，再实现最小行为；不要为了测试重构无关模块。
- 优先复用现有 API、路径规则、Organizer 日志和 React 状态模式。
- 不要把文件移动逻辑放到浏览器；所有文件操作必须由 `Organizer` 执行。
- 移动前必须重新校验扫描快照、文件身份、真实路径、符号链接和目标冲突。
- 不覆盖目标文件。部分失败要回滚，无法确认时记录为 `uncertain`，不能假装成功。
- 收件箱新项目先生成建议并进入待处理列表，必须用户确认后才移动。
- 收件箱分类体系彼此独立，支持最多三级；分类路径和自定义目标目录都必须经过路径安全校验。
- 待处理建议跨重启保存；源文件身份变化后建议必须失效。
- 用户手动修改和明确规则优先于历史、媒体规则和 AI 建议。

## 隐私和平台边界

- 不读取或上传普通文件内容、媒体像素、音轨或缩略图。
- TypeSafe 请求只包含普通项目的名称、类型、扩展名、大小和有限目录样本；不要发送绝对路径。
- GPS 地点解析默认关闭，只有用户明确允许时才调用 Apple；原始坐标不返回浏览器。
- 服务只监听 `127.0.0.1`，不要改成公网监听或绕过 Host、Origin 和会话 token 校验。
- Swift helper 通过受校验的 JSON stdin/stdout 协议通信，并保留超时和输出大小限制。

## 验证要求

提交修改前至少运行：

```sh
npm run check
npm test
```

涉及页面交互、扫描、移动、收件箱或撤销时还要运行 `npm run test:e2e`。涉及 macOS 媒体 helper 时运行 `npm run build:native` 和对应媒体测试。报告测试受端口、浏览器或 macOS 沙箱限制时的实际结果，不要把未运行写成通过。

## 文档和生成文件

- `README.md` 和 `CONTEXT.md` 是保留的项目说明文件；修改领域术语或行为时同步更新。
- `dist/`、`.data/`、`node_modules/` 和 Playwright 测试产物不是手工编辑的源码。
- 不要提交 `.env`、个人路径、媒体文件、操作日志或 Swift 编译缓存。
