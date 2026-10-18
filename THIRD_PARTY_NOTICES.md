# 第三方组件与参考

Daymark 自有代码采用根目录的 [MIT License](LICENSE)。以下组件保留各自的许可证；Daymark 的 MIT 授权不改变它们的条款。

| 组件 | 使用方式 | 版本 / 固定来源 | 许可证位置 |
| --- | --- | --- | --- |
| [Tabler](https://github.com/tabler/tabler) | 仓库只内置官方 CSS，用于按钮与表单等样式 | `@tabler/core` 1.6.1；包校验与 CSS 摘要见 [SOURCE.json](public/vendor/tabler/SOURCE.json) | [MIT](public/vendor/tabler/LICENSE)，The Tabler Authors |
| [wechat-decrypt](https://github.com/tzwkb/wechat-decrypt) | 内置 SHA-512 入口定位脚本与已提交 WAL 快照读取代码 | `f0b3f9f95dda2d954ee3dbe1d139fb1944a5ecfd` | [MIT](collector/wechat_vendor/LICENSE)，2026 cocofeng；[来源说明](collector/wechat_vendor/README.md) |
| [Node.js](https://nodejs.org/) | 完整包内置 Windows x64 运行环境；源码版首次启动下载 | v22.23.3；SHA-256 见 [版本锁](tools/runtime-lock.json) | 随运行环境保留 `runtimes/node/LICENSE`，含 MIT 和第三方说明 |
| [Python](https://www.python.org/) | 完整包内置 Windows x64 embeddable 便携环境；不安装到系统 | 3.10.11；SHA-256 见版本锁 | 随运行环境保留 `runtimes/python/LICENSE.txt`，PSF 及附带第三方许可 |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | 未修改的官方 QQ 运行组件；完整包包含，源码版首次启动下载 | v4.18.38；下载摘要见 [vendor/README.md](vendor/README.md) | [Limited Redistribution License for NapCat](vendor/NapCat.LICENSE)，2024 Mlikiowa；包含非商用限制 |

源码仓库不提交上述大型运行文件。完整包保留上游许可证、版权和来源说明；包含 NapCatQQ 的完整包及其使用受上游非商用限制约束，不能因为 Daymark 使用 MIT 就将其中 NapCatQQ 按 MIT 授权。没有修改或公开分发修改后的 NapCatQQ 代码。

## Python 运行依赖

`tools/setup-runtime.ps1` 按 [版本锁](tools/runtime-lock.json) 从 PyPI 下载固定 wheel，核验 SHA-256 后解压到便携 Python 的 `Lib/site-packages/`。完整包也包含这些依赖；源码仓库和源码发布包不包含 wheel 或运行环境。各包原有的 `.dist-info/`、许可证及版权文件保留在运行环境中：

`pywinauto==0.6.9`、`comtypes==1.4.17`、`six==1.17.0`、`pywin32==312`、`Pillow==12.0.0`、`pycryptodome==3.23.0`、`frida==17.8.0`、`zstandard==0.25.0`、`typing_extensions==4.15.0`。

Frida 二进制使用其附带的 wxWindows Library Licence 3.1 及二进制分发例外，完整条款保留在 `frida-17.8.0.dist-info/licenses/COPYING`。其他包以各自随附许可为准；不能删除这些许可文件再分发。

官方 Windows 微信、QQ 和 Microsoft Edge 不随项目分发，仍需用户自行安装；用户自行完成扫码、登录及平台要求的验证。

## 设计与协议参考

- [shadcn/ui](https://github.com/shadcn-ui/ui)：参考 Tasks 和 Sidebar 的布局思路，未复制 React 组件；页面样式由 Daymark 自行实现。
- [Xuexitong-mcp](https://github.com/DanMo661/Xuexitong-mcp)：学习通登录与只读接口研究参考，本项目使用独立 Node.js 客户端，未打包其 Python 项目。
- [pywechat](https://github.com/Hello-Mr-Crab/pywechat)：早期 Windows 控件兼容性研究，未导入或分发该包。
- [wxauto](https://github.com/cluic/wxauto/blob/main/wxauto/wxauto.py)：参考微信 3.9 的主窗口、会话及消息控件名称，使用项目自有的 pywinauto 适配实现；未打包该库。

其他探索记录位于 `docs/`，只作当时的选型记录，不表示相关项目是运行依赖或获得其官方支持。
