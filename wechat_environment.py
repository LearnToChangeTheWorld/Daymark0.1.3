"""Windows installation discovery, shared with the QQ adapter. Never launches clients."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import winreg


class ClientIssue(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def discover_client(platform='WeChat'):
    label = 'QQ' if platform == 'QQ' else '微信'
    variable = 'STUDENT_INBOX_QQ_PATH' if platform == 'QQ' else 'STUDENT_INBOX_WECHAT_PATH'
    shell = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    script = Path(__file__).resolve().parents[1] / 'tools/windows-client.ps1'
    try:
        result = subprocess.run([str(shell), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                                 '-File', str(script), '-Platform', platform], capture_output=True,
                                creationflags=subprocess.CREATE_NO_WINDOW, timeout=12, check=True)
        found = json.loads(result.stdout.decode('utf-8-sig'))
    except Exception:
        raise ClientIssue('discovery_failed', f'无法检查{label}安装位置。请确认系统 PowerShell 可用；也可在启动前设置 {variable} 为程序完整路径。') from None
    if not found.get('found'):
        if found.get('reason') == 'override_invalid':
            raise ClientIssue('client_path_invalid', f'指定的{label}路径不存在或不是有效程序。请修正 {variable}。')
        raise ClientIssue('client_missing', f'未找到{label}安装位置。若已安装到自定义目录，请先打开客户端再检查，或设置 {variable} 为程序完整路径。')
    return found['client']


def find_client(allow_legacy=False):
    client = discover_client()
    if client.get('kind') == 'wechat3':
        if allow_legacy:
            return client
        raise ClientIssue('legacy_client', '已检测到旧版微信，使用界面读取，无需初始化数据库。')
    if client.get('architecture') != 'x64':
        raise ClientIssue('client_unsupported', '已找到微信，但当前读取组件适用于 x64 客户端；此客户端架构尚未适配。')
    return client


def storage_candidates(source_root=None):
    """Candidates for key validation only, never for choosing the active account."""
    roots = [Path(source_root)] if source_root else []
    bases = []
    if os.environ.get('WECHAT_DATA_ROOT'):
        bases.append(Path(os.environ['WECHAT_DATA_ROOT']))
    # Uses Windows' redirected Documents location (including OneDrive), not a
    # hard-coded home/Documents path. Registry fallback supports older systems.
    buffer = ctypes.create_unicode_buffer(32768)
    if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buffer) == 0 and buffer.value:
        bases.append(Path(buffer.value) / 'xwechat_files')
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Tencent\Weixin') as key:
            value, _ = winreg.QueryValueEx(key, 'FileSavePath')
            if value and value != 'MyDocument:':
                base = Path(os.path.expandvars(value))
                bases.extend([base, base / 'xwechat_files'])
    except OSError:
        pass
    bases.append(Path.home() / 'Documents/xwechat_files')
    for base in dict.fromkeys(bases):
        if base.name.casefold() == 'db_storage':
            roots.append(base)
        elif base.is_dir():
            roots.extend(base.glob('*/db_storage'))
            roots.extend(base.glob('xwechat_files/*/db_storage'))
    return list(dict.fromkeys(roots))
