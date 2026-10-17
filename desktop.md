# Windows 桌面 EXE

## 使用

推荐从 Releases 下载 `Daymark-0.1.3-Setup.exe`，双击安装后使用桌面快捷方式。安装器包含完整程序与运行环境，不联网下载依赖，不要求管理员权限。

便携版全部解压后双击 `Daymark.exe`，同样不显示命令行。图形窗口提供打开网页、查看访问码、退出程序；关闭窗口隐藏到系统托盘，右键托盘仍可操作。关闭网页后继续采集，退出程序时停止采集并保存。

界面继续在本机浏览器中显示，未改成另一套客户端。服务固定使用本机 `127.0.0.1:4317`；重复双击唤起已有的桌面入口。若旧版命令行窗口还在运行，请先退出旧版，端口占用时会明确提示。

## 文件与数据

安装位置为当前用户的 `%LOCALAPPDATA%\Programs\Daymark`，不写系统目录。已有账号与事项在 `%LOCALAPPDATA%\StudentInbox` 沿用，也保留原 `STUDENT_INBOX_DATA_DIR` 自定义配置。安装器升级先检查 Daymark 是否运行，将旧程序保留为 `Daymark.previous-时间`，替换失败则恢复原目录。

EXE 便携入口需要同目录的 server.mjs、public、collector 和 runtimes 等文件，不能单独拷贝。单文件安装 EXE 才包含全部内容。官方微信、QQ 不随包分发；系统到期推送、开机自启仍未实现。

当前安装器没有系统卸载条目或自动更新。退出后删除程序目录和快捷方式即可移除程序，个人数据目录默认保留。升级备份可在确认新版正常后自行移除。

## 构建

使用 Windows 自带的 .NET Framework C# 编译器生成 WinForms GUI 子系统 EXE；无需安装 .NET SDK、Electron 或前端编译器。完整包仍使用已经锁定并校验的便携 Node/Python/NapCat。源码中的 C# 文件及构建脚本一并公开。

```powershell
# 仅编译桌面入口，实际使用仍须完整运行环境
powershell -ExecutionPolicy Bypass -File tools/build-desktop.ps1

# 生成含 Daymark.exe 的干净完整 ZIP
powershell -ExecutionPolicy Bypass -File tools/prepare-windows-release.ps1 -Offline

# 用上一步生成的完整 ZIP 制作单文件安装 EXE
powershell -ExecutionPolicy Bypass -File tools/build-installer.ps1 -BundleZip '完整包实际路径.zip'
```

安装 EXE 内嵌完整 ZIP 及长度、SHA-256 摘要。安装前先核验摘要，解压拒绝越界路径。构建产物不放进 Git 源码；源码仓库保留完整可重建代码，安装 EXE 和完整 ZIP 放 Releases 附件。许可证均随组件保留，NapCatQQ 的独立非商用限制继续适用。

测试入口 `--no-browser --exit-after=毫秒` 只供隔离测试。安装器 `--verify-install=临时父目录` 安装到测试父目录、跳过快捷方式与自动打开，不改变正常安装位置。测试不可使用真实用户的账号数据目录。
