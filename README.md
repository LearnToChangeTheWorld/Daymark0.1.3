# Daymark

把分散在群聊和学习平台里的要求，整理成可以处理、完成和回查的事项。

**当前是 Windows 本地运行的预览版，没有线上网站，也不支持 iPhone 远程访问。** 软件和数据放在自己的电脑上，不需要服务器或域名。网站接入与同步接口已保留，尚未完成公网部署验证。

## 能做什么

- **待办**：明确的作业、提交和填写要求自动加入；按原消息日期分组，截止时间另行标注。
- **待确认**：只保留可能需要行动的候选，确认或归档；支持批量归档。
- **通知**：直接显示完整正文，可按作业、考试、课程安排等主题筛选。
- **记录**：回查原消息、普通聊天、已完成和已归档事项，支持搜索与恢复。

微信和 QQ 自动识别学习相关群，无需先逐个勾选；可以纠正识别结果。默认使用本机文字规则，没有大模型 API 费用。明确的事项自动加入待办，普通闲聊不会堆进待确认。

**当前仓库新增可选大模型整理**：在“设置 → 大模型整理”填写自己的 API Key，可使用 DeepSeek 或其他 OpenAI 兼容服务。提供连接测试、Windows 加密保存、新消息自动整理、历史消息勾选预览及每日用量上限；任务详情保留原文依据，日期与事项变更需要核对时进入待确认。默认关闭，启用后文字会发送给所选服务，可能产生服务商费用。已有 0.1.3 安装包不包含此功能。详见 [大模型使用说明](docs/llm.md)。

### 平台支持情况

| 来源 | 当前能力 | 边界 |
| --- | --- | --- |
| 微信 | 4.x 使用本机数据库；3.x 自动尝试界面读取；学习群自动识别 | 4.1.15.53 已实机验证；旧版适配有合成测试、待实机验证；7 天缓存补读限数据库模式 |
| QQ | NTQQ 使用随包 NapCatQQ；经典 QQ 自动尝试独立实验性界面读取 | NTQQ 已验证本机登录、历史和重启恢复；经典 QQ 待实机验证，无历史补读 |
| 学习通 | 手机号密码登录；课程、未提交作业、近 7 天通知；保存账号后恢复 | 可能需要本人在 Edge 验证；暂不支持扫码 |
| 雨课堂 | 已预留来源和适配位置 | **采集器尚未实现** |
| 中南大学教务系统 | 学校原生窗口登录；采集站内教务通知，接入大模型整理 | 当前仓库新增；验证码由用户完成；已完成真实账号采集及大模型整理联调；[使用说明](docs/csu.md) |

## 开始使用

需要 **Windows 10/11 64 位**。推荐下载 Release 附件 **`Daymark-0.1.3-Setup.exe`**，双击后点“安装”。组件已全部包含，安装后使用桌面或开始菜单中的 **Daymark** 快捷方式，无需输入命令或另装 Python、Node、聊天插件。

不想安装时，可下载 **`windows-x64.zip` 完整便携包**，全部解压后双击 **`Daymark.exe`**。不能只复制这个 EXE，它需要同文件夹中的网页和运行组件。

打开后显示状态窗口并自动打开浏览器；首次使用点状态窗口中的“查看访问码”，在页面填写即可。关闭状态窗口或网页后，程序仍在系统托盘运行；右键托盘图标可打开界面、查看访问码或**退出程序**。启动失败会显示图形提示，数据继续保存在原目录。

旧版命令行入口保留供排查使用。使用和构建说明见 [桌面 EXE](docs/desktop.md)、[快速开始](QUICKSTART.md) 和 [新旧客户端兼容说明](docs/compatibility.md)。安装位置会自动识别，不要求微信、QQ 安装在 C 盘；Python 使用随包隔离环境。

### 下载的是仓库源码？

GitHub 的 **Code → Download ZIP** 下载的是源码，不带大型运行组件。解压后同样双击 `Start-Daymark.cmd`：首次启动自动联网下载、校验并准备组件，以后直接使用。首次准备可能较慢；若网络无法访问下载源，请使用 Release 完整包。程序使用自己的便携运行环境，不更改系统 Python、Node 或 PATH。

开发者也可在已有 Node.js 22+ 的环境中，只运行核心事项服务：

```powershell
node server.mjs
```

无需安装 Node 运行依赖或编译前端。网页地址为 [http://127.0.0.1:4317](http://127.0.0.1:4317)。

请从启动入口或上述本机地址进入，不要直接打开 `public/index.html`；直接打开网页文件会显示启动说明，事项功能需要本地服务运行。

首次运行的数据默认保存在 `%LOCALAPPDATA%\StudentInbox`，包括访问码、事项库及加密账号文件。可以通过 `STUDENT_INBOX_DATA_DIR` 指定其他目录。建议把数据目录放在源码目录之外，升级时沿用原目录。

### 接入平台

**官方 Windows 微信、QQ 客户端仍需自己安装**；学习通验证可能需要 Microsoft Edge。完整包已经包含聊天读取组件，启动入口也会为源码版自动准备，普通使用者不用执行下列命令。若开发者只想单独准备某个组件，可执行：

```powershell
# 只安装微信读取组件
powershell -ExecutionPolicy Bypass -File tools/setup-chat.ps1 -Component WeChat

# 只安装 QQ 组件
powershell -ExecutionPolicy Bypass -File tools/setup-chat.ps1 -Component QQ
```

所有下载按 [版本锁定文件](tools/runtime-lock.json) 核验 SHA-256。大型运行组件放在本机 `runtimes/`，不提交进源码仓库；Release 完整包包含它们。NapCatQQ 保留其独立的**非商用**许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。

在网页点击“接入账号”，选择微信、QQ 或学习通；中南大学教务系统从左侧“中南教务”进入。微信首次初始化会明确提示并重启一次客户端；以后静默尝试恢复，不反复弹出微信窗口。登录由对应客户端管理，需要扫码或手机确认时仍须本人操作。

具体步骤、成功提示、采集范围及常见问题见 [安装与平台接入](docs/platform-setup.md)。

## 使用范围

- **本地运行需要联网采集**；已有事项可在本机服务运行时离线查看。默认仅监听 `127.0.0.1`，不开放校园网、局域网或公网访问。
- **保存登录不等于永不掉线**。客户端退出、平台验证、密钥变化或升级都可能需要重新连接，界面会显示状态。
- **补读只覆盖能够取得的历史**。微信限电脑已缓存的数据，QQ 限组件返回的数据；不能保证所有消息绝不遗漏。
- **图片、语音、附件正文暂未理解**，文字规则也可能误判或漏判。可以人工新增、纠正或排除事项。
- **没有系统到期推送或开机自启**。可用 EXE 安装版或便携版，托盘运行期间持续采集；待办会保留到完成或归档，不代表已经实现定时提醒。
- 学习通作业在平台提交后，已导入待办暂不会自动标为完成。

## 项目结构

```text
server.mjs       本机事项服务、访问限制及 API
public/          浏览器界面和本地静态资源
collector/       平台连接、只读采集与耐久队列
shared/          事件格式、分类规则和运行配置
test/            使用合成数据的回归测试
tools/           组件安装、验证和源码发布工具
runtimes/        本机便携组件，源码仓库不包含
docs/            平台接入、设计与接口文档
```

界面参考 [shadcn/ui Tasks](https://ui.shadcn.com/examples/tasks) 和 [Sidebar](https://ui.shadcn.com/docs/components/sidebar) 的组织方式，使用原生 JavaScript 和本地 Tabler 样式实现，不依赖 CDN。

- [网站接口与后续扩展](docs/website-interfaces.md)
- [界面与信息组织方案](docs/product-redesign.md)
- [参与开发及验证](CONTRIBUTING.md)
- [GitHub 发布步骤](docs/publishing.md)
- [数据与安全说明](SECURITY.md)
- [版本记录](CHANGELOG.md)

## 验证与发布

```powershell
node --test test/*.test.mjs
node tools/release-check.mjs
powershell -ExecutionPolicy Bypass -File tools/prepare-release.ps1

# 另外生成包含 Python、Node 和 NapCatQQ 的 Windows 完整包
powershell -ExecutionPolicy Bypass -File tools/prepare-windows-release.ps1
```

源码工具只导出经过检查的源码。Windows 打包工具在新目录中解压校验过的原始组件，保留第三方许可证，生成逐文件校验清单；两者都不复制本机账号、密钥、聊天数据或登录缓存，不删除本机数据。生成的 ZIP 位于 `artifacts/releases/`，详细流程见 [发布步骤](docs/publishing.md)。

## 许可证

Daymark 自有代码使用 [MIT](LICENSE)。Tabler、微信读取所复用的代码及外部 NapCat 组件各自保留上游许可；项目的 MIT 不覆盖这些许可。版本与来源见 [第三方说明](THIRD_PARTY_NOTICES.md)。
