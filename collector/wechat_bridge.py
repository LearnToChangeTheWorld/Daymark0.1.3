"""Local Windows Weixin UI adapter; only login controls and selected chats are read.

UI element reference: Hello-Mr-Crab/pywechat (WeChatTools and Uielements).
No message sending, account logout, registry accessibility changes or hooks.
"""
import sys, json, os, time, base64, io, subprocess
from pathlib import Path
from datetime import datetime, timezone
# -I excludes the script directory in legacy virtual environments. Add only our
# own absolute directory, never the working directory or user package folders.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pywinauto import Desktop
from wechat_environment import ClientIssue, find_client

sys.stdout.reconfigure(encoding='utf-8')
sys.stdin.reconfigure(encoding='utf-8')
desktop = Desktop(backend='uia')

def windows():
    # Filter by the official client's process ID before inspecting any UI content.
    import win32gui, win32process
    handles = []
    def callback(hwnd, _):
        cls = win32gui.GetClassName(hwnd)
        if cls not in ('mmui::LoginWindow', 'mmui::MainWindow', 'WeChatMainWndForPC', 'WeChatLoginWndForPC') and not (cls.startswith('Qt') and cls.endswith('QWindowIcon')):
            return
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        try:
            import win32api, win32con
            proc = win32api.OpenProcess(win32con.PROCESS_QUERY_INFORMATION | win32con.PROCESS_VM_READ, False, pid)
            exe = win32process.GetModuleFileNameEx(proc, 0)
            proc.Close()
            if os.path.basename(exe).lower() in ('weixin.exe', 'wechat.exe'):
                handles.append(hwnd)
        except Exception:
            pass
    win32gui.EnumWindows(callback, None)
    return [desktop.window(handle=hwnd) for hwnd in handles]

def main_and_login():
    main, login = None, None
    for window in windows():
        try:
            cls = window.element_info.class_name
            if cls in ('mmui::LoginWindow', 'WeChatLoginWndForPC'):
                login = window
            if cls in ('mmui::MainWindow', 'WeChatMainWndForPC'):
                main = window
        except Exception:
            pass
    return main, login

def status():
    mains = [window for window in windows() if window.element_info.class_name in ('mmui::MainWindow', 'WeChatMainWndForPC')]
    if len(mains) > 1:
        return {'loginState': 'unreadable', 'readable': False, 'errorCode': 'multiple_accounts', 'message': '检测到多个微信主窗口，无法唯一确认账号。请保留一个账号后检查连接。'}
    main, login = main_and_login()
    if main:
        buttons = main.descendants(control_type='Button', depth=5)
        offline = any(x.window_text() in ('当前网络不可用', '网络连接已断开') for x in buttons)
        account = main.window_text()
        if main.element_info.class_name == 'WeChatMainWndForPC' and buttons:
            # Classic WeChat exposes the profile name on its first sidebar button.
            profile = buttons[0].window_text().strip()
            if profile and profile not in ('微信', 'WeChat', '聊天', '通讯录', '关闭', '最小化'):
                account = profile
        if account in ('微信', 'WeChat', ''):
            return {'loginState': 'unreadable', 'readable': False, 'errorCode': 'legacy_identity', 'message': '已找到旧版微信，但尚未读到明确账号名称。请保持主窗口可读取，当前未开始采集。'}
        # Process changes deliberately create a fresh UI baseline. UI snapshots
        # cannot prove the stable account identity that database reads provide.
        account_id = 'uia:' + str(main.element_info.process_id) + ':' + account
        return {'loginState': 'offline' if offline else 'authenticated', 'account': account, 'accountId': account_id,
                'readable': len(buttons) >= 3, 'message': '微信账号已登录' if len(buttons) >= 3 else '微信已登录，但客户端未开放消息读取权限；无法确认群消息采集可用'}
    if login:
        return {'loginState': 'waiting_scan', 'readable': False, 'message': '请使用手机微信扫描登录窗口二维码，并在手机上确认'}
    for window in windows():
        try:
            if window.is_visible() and window.element_info.class_name.startswith('Qt') and window.element_info.class_name.endswith('QWindowIcon'):
                return {'loginState': 'unreadable', 'readable': False, 'message': '已检测到微信窗口，但客户端未向系统开放内部消息控件，无法自动确认登录和读取群消息。若你已经登录，请勿重复扫码；当前界面读取方式不可用。'}
        except Exception:
            pass
    return {'loginState': 'not_running', 'readable': False, 'message': '微信客户端尚未启动，或窗口不可访问'}

def start(payload):
    current = status()
    if current['loginState'] == 'unreadable':
        return current
    main, login = main_and_login()
    if main:
        return status()
    if not login:
        path = find_client(allow_legacy=True)['path']
        subprocess.Popen([path])
        for _ in range(30):
            time.sleep(.3)
            main, login = main_and_login()
            if main or login:
                break
    if login:
        login.restore()
        # Switch only on the login page, never log out an already logged-in account.
        for label in ('切换账号', 'Switch Account', '切換賬號', '扫码登录'):
            candidate = login.child_window(title=label)
            if candidate.exists(timeout=.1):
                candidate.wrapper_object().click_input()
                time.sleep(.5)
                break
        result = status()
        # This is a real official login-window capture, not a fabricated QR code.
        output = io.BytesIO()
        login.capture_as_image().save(output, format='PNG')
        result['qrImage'] = base64.b64encode(output.getvalue()).decode('ascii')
        result['qrExpiresAt'] = datetime.fromtimestamp(time.time() + 240, timezone.utc).isoformat()
        return result
    return status()

def groups():
    main, _ = main_and_login()
    if not main:
        return {'groups': [], **status()}
    values = []
    for item in main.descendants(control_type='ListItem', depth=8):
        auto_id = item.element_info.automation_id or ''
        if auto_id.startswith('session_item_'):
            name = auto_id[len('session_item_'):]
            if name and name not in values:
                values.append(name)
    # WeChat 3.x session items have no session_item_* automation ID.
    for listing in main.descendants(control_type='List', depth=6):
        if listing.window_text() not in ('会话', '聊天', 'Chats', '会話', '聊天列表'):
            continue
        for item in listing.children(control_type='ListItem'):
            name = item.window_text().split('\n')[0].strip()
            if name and name not in values:
                values.append(name)
    return {**status(), 'mode': 'uia', 'supportsHistory': False, 'groups': [{'id': n, 'name': n} for n in values], 'message': '旧版微信：仅能读取可访问的会话与已打开群窗口，不支持按日期补读历史。'}

def read_groups(payload):
    state = status()
    if state['loginState'] != 'authenticated' or not state['readable']:
        return {**state, 'chats': [], 'errors': [state['message']]}
    selected = payload.get('groups', [])
    chats, errors = [], []
    main, _ = main_and_login()
    for group in selected:
        # Only inspect already-open selected group windows. Opening via search is
        # deliberately explicit in the UI to avoid touching an unrelated chat.
        candidates = [main] + windows()
        found = False
        for window in candidates:
            try:
                inputs = window.descendants(control_type='Edit', depth=8)
                chat_input = next((x for x in inputs if x.window_text() == group and (x.element_info.automation_id == 'chat_input_field' or window.element_info.class_name == 'WeChatMainWndForPC')), None)
                title_match = window.window_text() == group
                if not title_match and chat_input is None:
                    # Chat title is a dedicated title Text, not text in message bodies.
                    titles = window.descendants(control_type='Text', depth=5)
                    title_match = any(x.window_text() == group and 'title' in (x.element_info.automation_id or '').lower() for x in titles)
                if not title_match and chat_input is None:
                    continue
                found = True
                lists = window.descendants(control_type='List', depth=9)
                messages = next((x for x in lists if x.window_text() in ('消息', 'Messages', '訊息')), None)
                if messages is None:
                    errors.append(group + '：未能读取消息列表，请保持该群独立聊天窗口打开')
                    break
                items = []
                for message in messages.children(control_type='ListItem'):
                    text = message.window_text().strip()
                    if text:
                        items.append({'text': text[:12000], 'runtimeId': list(message.element_info.runtime_id or [])})
                chats.append({'id': group, 'messages': items})
                break
            except Exception:
                continue
        if not found:
            errors.append(group + '：请在微信中双击该群，打开独立聊天窗口并保持打开')
    return {**state, 'chats': chats, 'errors': errors}

def legacy_dispatch(action, request):
    if action in ('start', 'refresh'):
        result = start(request)
    elif action == 'groups':
        result = groups()
    elif action == 'read':
        result = read_groups(request)
    elif action == 'initialize':
        result = status()
    else:
        result = status()
    return {**result, 'mode': 'uia', 'supportsHistory': False}


def dispatch(action, request, reader=None, platform='wechat'):
    if action == 'close':
        if reader and reader.setup_child and reader.setup_child.poll() is None:
            reader.setup_child.terminate()
        return {'closed': True}
    if platform == 'qq':
        from qq_legacy import dispatch as qq_dispatch
        return qq_dispatch(action, request)
    state = reader.status() if reader else None
    if state and state.get('errorCode') != 'legacy_client':
        if action in ('start', 'refresh', 'status'):
            result = state
            if action != 'status' and result['loginState'] in ('not_running', 'waiting_scan'):
                ui = start(request)
                result = reader.status()
                if ui.get('qrImage'):
                    result['qrImage'] = ui['qrImage']
                elif result['loginState'] == 'waiting_scan':
                    from wechat_login import login_image
                    image = login_image()
                    if image:
                        result['qrImage'] = base64.b64encode(image).decode('ascii')
            return result
        if action == 'initialize':
            return reader.initialize()
        if action == 'groups':
            return reader.groups()
        if action == 'read':
            return reader.read(request)
    return legacy_dispatch(action, request)


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir')
    parser.add_argument('--platform', choices=('wechat', 'qq'), default='wechat')
    args = parser.parse_args()
    reader = None
    if args.data_dir and args.platform == 'wechat':
        from wechat_database import DatabaseReader
        reader = DatabaseReader(args.data_dir)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            action = request.get('action')
            result = dispatch(action, request, reader, args.platform) if action in ('start', 'refresh', 'status', 'groups', 'read', 'initialize', 'close') else {'error': '不支持的操作'}
            print(json.dumps({'id': request.get('id'), 'result': result}, ensure_ascii=False), flush=True)
        except ClientIssue as error:
            print(json.dumps({'id': request.get('id') if isinstance(request, dict) else None,
                              'result': {'error': error.message, 'errorCode': error.code}}, ensure_ascii=False), flush=True)
        except Exception:
            # Exception strings may contain private UI text; keep them out of logs.
            print(json.dumps({'id': request.get('id') if isinstance(request, dict) else None,
                              'result': {'error': '微信读取失败。请检查客户端与 Daymark 是否使用同一用户和相同权限；若更新微信后出现，请反馈客户端版本。原消息与采集位置已保留。', 'errorCode': 'read_failed'}}), flush=True)


if __name__ == '__main__':
    main()
