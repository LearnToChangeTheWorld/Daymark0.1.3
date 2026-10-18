"""Explicit one-time setup: restart official Weixin, capture and verify a local key.

SHA-512 locator: wechat_vendor/sha512-key.js (MIT). Only a DPAPI encrypted key is
persisted; no key is printed or passed in a process argument. No message sending.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import frida
import win32crypt
from wechat_database import atomic_json, validate_raw_key
from wechat_login import enter_saved_login
from wechat_environment import ClientIssue, find_client, storage_candidates


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--source-root')
    args = parser.parse_args()
    destination = Path(args.data_dir)
    status_file = destination / 'setup-status.json'
    def state(phase, message):
        atomic_json(status_file, {'phase': phase, 'message': message, 'at': time.time()})
    state('starting', '正在启动本机消息读取初始化')
    session, device, pid = None, None, None
    try:
        client = find_client()
        roots = storage_candidates(args.source_root)
        pages = []
        for root in dict.fromkeys(roots):
            path = root / 'contact/contact.db'
            if path.exists():
                with path.open('rb') as source:
                    pages.append((root, source.read(4096)))
        if not pages:
            state('error', '未找到可校验的本机微信数据。请先进入电脑微信并检查连接；数据迁移到自定义目录时可设置 WECHAT_DATA_ROOT 为 xwechat_files 的实际位置。')
            return 1
        executable = Path(client['path'])
        device = frida.get_local_device()
        # Called only by the explicit initialization button, never a poll/retry.
        subprocess.run(['taskkill', '/IM', 'Weixin.exe', '/F'], capture_output=True,
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
        pid = device.spawn([str(executable)], stdio='pipe')
        session = device.attach(pid)
        seen, captured, locator_error = set(), [], []
        def on_message(message, _data):
            if message.get('type') == 'error':
                locator_error.append(True)
                return
            payload = message.get('payload', '')
            if not isinstance(payload, str):
                return
            if payload.startswith('ERR:'):
                locator_error.append(True)
                return
            if not payload.startswith('KEY:'):
                return
            value = payload[4:]
            if value in seen:
                return
            seen.add(value)
            try:
                key = bytes.fromhex(value)
                for root, page in pages:
                    if not validate_raw_key(key, page):
                        continue
                    encrypted = win32crypt.CryptProtectData(key, 'Student Inbox WeChat local database', None, None, None, 0)
                    atomic_json(destination / (root.parent.name + '.dpapi.json'), {
                        'account': root.parent.name, 'kind': 'raw',
                        'protectedKey': base64.b64encode(encrypted).decode('ascii')})
                    captured.append(root.parent.name)
            except Exception:
                locator_error.append(True)
        script = session.create_script(Path(__file__).with_name('wechat_vendor').joinpath('sha512-key.js').read_text(encoding='utf-8'))
        script.on('message', on_message)
        script.load()
        device.resume(pid)
        state('waiting_login', '微信已打开，正在等待数据库解锁。请完成扫码或手机确认。')
        deadline = time.monotonic() + 180
        next_enter, entered = time.monotonic() + 2, False
        while time.monotonic() < deadline and not captured and not locator_error:
            if not entered and time.monotonic() >= next_enter:
                entered = enter_saved_login(destination, pid)
                next_enter = time.monotonic() + 5
            time.sleep(.2)
        if captured:
            state('completed', '本机密钥已验证并加密保存，可选择群聊开始采集。')
            return 0
        state('error', '初始化未完成：未读到可校验的密钥。请确认已进入电脑微信；客户端版本变化时可能需要更新读取组件。')
        return 1
    except ClientIssue as error:
        state('error', error.message)
        return 1
    except Exception:
        state('error', '初始化失败：无法附加官方微信或当前微信版本的读取方式尚未适配。请让微信与 Daymark 使用同一用户和相同权限运行；无需反复扫码，原消息已保留。')
        return 1
    finally:
        if session:
            try:
                session.detach()
            except Exception:
                pass
        if device and pid:
            try:
                device.resume(pid)
            except Exception:
                pass


if __name__ == '__main__':
    raise SystemExit(main())
