# 发布到 GitHub

发布分为 **源码仓库** 和 **Windows 完整包**。普通使用者下载完整包，解压后双击启动；开发者下载源码。当前仍是 Windows 本地预览版，没有线上网址，不支持手机远程访问；平台网站接入和后续同步接口保留。

## 生成 Windows 完整包

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File tools/prepare-windows-release.ps1
```

第一次构建需要联网下载固定版本；下载缓存默认在 `artifacts/runtime-downloads/`。缓存齐全后，可加 `-Offline` 完全离线构建，也可以用 `-DownloadCache 'D:\DaymarkDownloads'` 指定缓存。

生成的 `daymark-0.1.3-windows-x64-时间.zip` 包含源码、双击启动入口、Node.js、Python 3.10、全部微信读取依赖和 NapCatQQ。它在新的发布目录中解压经过 SHA-256 核验的原始下载文件，保留许可证；**不复制正在使用的组件目录、账号或聊天数据**。文件清单分别在 `source-manifest.json` 和 `runtime-manifest.json`，ZIP 旁另有 `.sha256` 校验文件。构建前后不会登录、启动或退出你的微信、QQ。

完整包体积较大，放在 GitHub **Releases** 附件里；不要将 `runtimes/`、Python 安装包或 NapCat 压缩包直接提交进源码仓库。这样用户依然能一次下载齐全，源码仓库也方便查看与更新。GitHub 自动生成的 “Source code (zip)” 只有源码，不是完整包。

## 生成安装 EXE

完整 ZIP 生成后执行（替换实际文件路径）：

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-installer.ps1 -BundleZip 'artifacts/releases/实际的windows-x64包.zip'
```

生成 `Daymark-0.1.3-Setup.exe` 和对应 `.sha256`，优先发给普通使用者。安装器内嵌完整依赖，自动创建快捷方式；便携 ZIP 中的入口为 `Daymark.exe`。源码内包含 C# 代码和构建工具，详见 [桌面 EXE](desktop.md)。

## 手动发布 Release

1. 先把下方生成的干净源码更新到仓库。打开仓库首页 → **Releases → Draft a new release**（首次可点 **Create a new release**）。
2. 创建标签 `v0.1.3`，目标选更新后的 `main`；标题填 `Daymark 0.1.3 — Windows 本地预览版`。如果已有这个标签，请按实际版本递增，不覆盖已有发布。
3. 在附件区域选择 **`Daymark-0.1.3-Setup.exe` 安装包**、**`windows-x64...zip` 便携包**和对应 `.sha256` 文件。源码 ZIP 可以另外附上。不要把完整包解压后再逐个上传。
4. 说明里写：`Windows 10/11 x64；双击 Setup.exe 安装后使用桌面快捷方式，或解压便携版双击 Daymark.exe。已包含 Node.js、Python 3.10 和 NapCatQQ，无需手动配置环境；官方微信/QQ 客户端需自行安装并扫码登录。仅本机运行。NapCatQQ 受其独立非商用许可约束。`
5. 这是预览版，可勾选 **Set as a pre-release**。等待附件上传完成，再点 **Publish release**。

发布由仓库所有者自行操作；本地打包脚本不会自动创建 Release、上传文件或推送代码。发布后，请让使用者下载你上传的 Windows 完整包附件。

## 生成干净源码包

在项目根目录执行：

```powershell
node --test test/*.test.mjs
node tools/release-check.mjs
powershell -ExecutionPolicy Bypass -File tools/prepare-release.ps1
```

检查通过后，在 `artifacts/releases/` 生成源码目录、ZIP 和 SHA-256 校验文件。只导出检查通过的源码，不删除或更改本机账号、聊天记录、数据库和运行组件。没有 Git 仓库的源码解压目录也可以执行发布检查；在 Git 仓库中会同时检查已跟踪文件，避免忽略规则掩盖已经加入版本库的私人文件。

工具会拒绝运行数据目录、密钥文件、可疑凭据、符号链接和未知顶层目录，并验证本地 Tabler 资源校验值。它只检查当前文件，不能替代人工检查或清除 Git 历史中已经泄漏的数据。不要直接压缩正在使用的整个项目文件夹。

## 创建仓库并上传

建议仓库名 `daymark`。可直接使用的英文简介：

> A Windows-local student inbox and task manager for WeChat, QQ and learning platforms. No hosted service; future website sync interfaces are retained.

在 GitHub 新建空仓库，选择公开或私有；上传已有源码时，不勾选自动创建 README、许可证或 .gitignore，避免重复初始化。

### 用 Git 上传（推荐）

在检查通过的本地项目目录操作；如果是解压的发布包，先运行 `git init -b main`。下面的示例地址必须换成自己新建仓库页面提供的地址：

```powershell
git add .
git diff --cached --stat
git commit -m "Prepare Daymark local preview"
git remote add origin https://github.com/YOUR_USERNAME/daymark.git
git push -u origin main
```

提交前查看文件列表，确认没有 `data/`、`artifacts/`、`runtimes/`、`.venv-wechat/`、`vendor/napcat/`、登录缓存或实际账号配置。Git 第一次提交如果要求身份，按提示设置自己的提交姓名和邮箱；使用 GitHub 提供的隐私邮箱可以避免公开个人邮箱。登录通过 GitHub 或凭据管理器完成，不把 Token 写进远程地址或代码。

### 不使用 Git

解压 **`source...zip` 源码包**，将其中源码文件夹的**内容**上传到仓库，包含 `.github/`、`.gitignore`、`.env.example` 等配置文件。不要用 Windows 完整包来更新源码。若网页不能拖文件夹，使用 GitHub Desktop 保留文件夹层级。不要只上传 ZIP 作为仓库全部内容，否则 GitHub 不会直接展示代码或运行自动检查。

## 上传后检查

- 首页能看到 README，并明确写着仅本机运行；MIT 及第三方说明都在。
- Actions 中的 Windows / Node 22、24 检查通过。工作流已经配置，首次远程执行结果以 GitHub 页面为准。
- 下载完整包到新目录，双击启动；另外检查源码包首次启动能够下载依赖。不要依赖开发电脑已有的运行组件。
- 示例、Issue、截图和 Release 附件不含真实账号、访问码、聊天内容和学生信息。

已发布安装包标记为 `0.1.3` 本地预览。当前仓库源码新增大模型整理及中南大学教务系统适配，已有安装包不包含这些新增功能；发布新安装包时应递增版本并重新构建。雨课堂采集、手机远程访问和系统提醒仍未实现。完整包包含未修改的官方 NapCat 运行组件及其许可证；Daymark 的 MIT 许可不改变它的独立非商用限制。

