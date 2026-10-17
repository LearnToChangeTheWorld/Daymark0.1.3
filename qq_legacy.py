"""Experimental read-only UI adapter for classic Windows QQ.

Uses the bundled pywinauto UIA backend. No client injection, message sending,
automatic chat switching, or invented protocol/history support.
"""
import base64
import io
from pathlib import Path
import re
import subprocess
import time

from pywinauto import Desktop
import win32api
import win32con
import win32gui
import win32process
from wechat_environment import discover_client

COMMON = {'mode': 'uia', 'supportsHistory': False, 'readable': False}


def windows():
    handles = []
    def visit(hwnd, _):
        if win32gui.GetClassName(hwnd) != 'TXGuiFoundation':
            return
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        process = None
        try:
            process = win32api.OpenProcess(win32con.PROCESS_QUERY_INFORMATION | win32con.PROCESS_VM_READ, False, pid)
            if Path(win32process.GetModuleFileNameEx(process, 0)).name.casefold() == 'qq.exe':
                handles.append(hwnd)
        except Exception:
            pass
        finally:
            if process:
                process.Close()
    win32gui.EnumWindows(visit, None)
    desktop = Desktop(backend='uia')
    return [desktop.window(handle=hwnd) for hwnd in handles]


def message_list(window):
    return next((control for control in window.descendants(depth=9)
                 if control.element_info.control_type in ('List', 'Document')
                 and control.window_text() in ('消息', '消息记录', '聊天记录', 'Messages')), None)


def group_windows():
    groups = []
    for window in windows():
        title = window.window_text().strip()
        if not title or title in ('QQ', 'QQ登录', '腾讯QQ'):
            continue
        # A title alone cannot distinguish group windows from private chats.
        labels = [item.window_text() for item in window.descendants(control_type='Button', depth=6)]
        if not any(label in ('群资料', '群设置', '群成员', '查看群资料') for label in labels):
            continue
        if message_list(window) is not None:
            groups.append((title, window))
    return groups


def status():
    owned = windows()
    if not owned:
        return {**COMMON, 'loginState': 'not_running', 'message': '请打开旧版 QQ，使用客户端的二维码登录。'}
    accounts = set()
    login = False
    if sum(window.window_text().strip() in ('QQ', 'QQ登录', '腾讯QQ') for window in owned) > 1:
        return {**COMMON, 'loginState': 'unreadable', 'errorCode': 'multiple_accounts', 'message': '检测到多个旧版 QQ 主窗口，无法唯一确认账号。请保留一个账号后检查连接。'}
    for window in owned:
        if window.window_text().strip() not in ('QQ', 'QQ登录', '腾讯QQ'):
            continue
        for control in window.descendants(depth=5):
            # Only explicit account labels count; message text/contacts are never
            # used to guess the current user's identity.
            if control.element_info.control_type not in ('Text', 'Button'):
                continue
            text = control.window_text().strip()
            match = re.fullmatch(r'(?:QQ号|QQ号码|QQ帐号|QQ账号)[:：\s]*(\d{5,12})', text)
            if match:
                accounts.add(match.group(1))
            login |= text in ('二维码登录', '扫码登录', '二维码已失效')
    if len(accounts) == 1:
        account = next(iter(accounts))
        return {**COMMON, 'readable': True, 'loginState': 'authenticated', 'accountId': account, 'account': account,
                'message': '旧版 QQ 界面读取已接入。仅发现有明确群标识且已打开的群窗口；无法补读 7 天历史，窗口须保持可读取。'}
    if login:
        return {**COMMON, 'loginState': 'waiting_scan', 'message': '请在旧版 QQ 客户端中切到二维码登录，用手机扫码确认。'}
    return {**COMMON, 'loginState': 'unreadable', 'errorCode': 'legacy_identity',
            'message': '已找到旧版 QQ，但暂未读取到唯一、明确的本机 QQ 账号。请在主窗口显示 QQ 号并保持窗口可访问；此版本尚需实机验证，当前未开始采集。'}


def dispatch(action, payload):
    if action in ('start', 'refresh') and not windows():
        client = discover_client('QQ')
        subprocess.Popen([client['path']], creationflags=subprocess.CREATE_NO_WINDOW)
        time.sleep(.8)
    state = status()
    if action in ('start', 'refresh') and state['loginState'] == 'waiting_scan':
        # Capture only a positively identified QQ login window, never a chat.
        for window in windows():
            if window.window_text() not in ('QQ', 'QQ登录', '腾讯QQ'):
                continue
            buttons = window.descendants(control_type='Button', depth=5)
            switch = next((item for item in buttons if item.window_text() in ('二维码登录', '扫码登录')), None)
            if switch is not None:
                switch.click_input()
                time.sleep(.3)
                output = io.BytesIO()
                window.capture_as_image().save(output, format='PNG')
                state['qrImage'] = base64.b64encode(output.getvalue()).decode('ascii')
                break
    if action == 'groups':
        return {**state, 'groups': [{'id': title, 'name': title} for title, _ in group_windows()] if state['readable'] else []}
    if action == 'read':
        chats, errors = [], []
        available = dict(group_windows()) if state['readable'] else {}
        for group in payload.get('groups', []):
            if group not in available:
                errors.append(group + '：旧版 QQ 群窗口未打开或缺少明确群标识，未读取')
                continue
            listing = message_list(available[group])
            items = listing.children(control_type='ListItem')
            if not items:
                errors.append(group + '：此版本未开放逐条消息控件，未推进采集位置')
                continue
            chats.append({'id': group, 'messages': [{'text': item.window_text().strip()[:12000]} for item in items if item.window_text().strip()]})
        return {**state, 'chats': chats, 'errors': errors}
    return state
