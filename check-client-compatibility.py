"""Synthetic compatibility checks; never starts, restarts, or reads a real client."""
import base64
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import sys
import sqlite3
from contextlib import closing

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collector'))
import wechat_environment as environment
import wechat_database as database
import wechat_bridge as bridge
import qq_legacy


class CompatibilityChecks(unittest.TestCase):
    def client_response(self, kind='wechat4', arch='x64'):
        return SimpleNamespace(stdout=json.dumps({'found': True, 'client': {
            'path': 'D:/自定义安装/Weixin.exe', 'kind': kind, 'architecture': arch, 'version': '4.1.15.53'
        }}).encode('utf-8'))

    def test_custom_install_path_is_used_and_old_wechat_selects_ui(self):
        with patch.object(environment.subprocess, 'run', return_value=self.client_response()):
            self.assertEqual(environment.find_client()['path'], 'D:/自定义安装/Weixin.exe')
        with patch.object(environment.subprocess, 'run', return_value=self.client_response('wechat3', 'x86')):
            with self.assertRaises(environment.ClientIssue) as issue:
                environment.find_client()
            self.assertEqual(issue.exception.code, 'legacy_client')
            self.assertEqual(environment.find_client(allow_legacy=True)['kind'], 'wechat3')

    def test_redirected_documents_and_migrated_data_root_are_found(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            account = root / 'OneDrive/Documents/xwechat_files/synthetic/db_storage'
            migrated = root / '其他盘/迁移目录/synthetic/db_storage'
            account.mkdir(parents=True); migrated.mkdir(parents=True)
            def documents(_hwnd, _kind, _token, _flags, buffer):
                buffer.value = str(root / 'OneDrive/Documents')
                return 0
            with patch.object(environment.ctypes.windll.shell32, 'SHGetFolderPathW', side_effect=documents), patch.dict(os.environ, {'WECHAT_DATA_ROOT': str(migrated.parent.parent)}):
                candidates = environment.storage_candidates()
                self.assertIn(account, candidates)
                self.assertIn(migrated, candidates)

    def test_permission_failure_is_specific_and_stale_account_is_not_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            reader = database.DatabaseReader(directory)
            reader.root, reader.raw = Path('synthetic-old-account'), b'old'
            with patch.object(database, 'active_storage', side_effect=environment.ClientIssue('process_access', '权限不同')):
                state = reader.status()
            self.assertEqual(state['errorCode'], 'process_access')
            self.assertFalse(state['readable'])
            self.assertIsNone(reader.root)

    def test_custom_account_root_comes_only_from_verified_active_handles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / '聊天迁移目录/synthetic/db_storage'
            contact = root / 'contact/contact.db'; contact.parent.mkdir(parents=True)
            contact.write_bytes(b'synthetic ciphertext')
            reader = database.DatabaseReader(Path(directory) / 'private')
            database.atomic_json(reader.directory / 'synthetic.dpapi.json', {'protectedKey': base64.b64encode(b'synthetic').decode()})
            with patch.object(database, 'active_storage', return_value=([str(root)], True)), patch.object(database.win32crypt, 'CryptUnprotectData', return_value=('', b'synthetic')), patch.object(database, 'validate_raw_key', return_value=True), patch.object(database, 'find_client') as find:
                self.assertTrue(reader.status()['readable'])
                self.assertEqual(reader.root, root)
                find.assert_not_called()

    def test_legacy_wechat_dispatch_never_initializes_or_restarts_database_reader(self):
        reader = SimpleNamespace(status=lambda: {'errorCode': 'legacy_client'})
        with patch.object(bridge, 'legacy_dispatch', return_value={'mode': 'uia', 'supportsHistory': False}) as dispatch:
            self.assertEqual(bridge.dispatch('read', {'groups': ['课程群']}, reader)['mode'], 'uia')
            dispatch.assert_called_once_with('read', {'groups': ['课程群']})

    def test_wechat3_profile_session_and_message_controls_are_read_without_launch(self):
        def control(name, kind='Button'):
            return SimpleNamespace(window_text=lambda: name, element_info=SimpleNamespace(automation_id='', runtime_id=[1], control_type=kind))
        item = control('请提交作业', 'ListItem')
        messages = control('消息', 'List')
        messages.children = lambda **_: [item]
        sessions = control('会话', 'List')
        sessions.children = lambda **_: [control('课程群\n新消息', 'ListItem')]
        def descendants(control_type=None, **_):
            return {'Button': [control('合成账号'), control('聊天'), control('通讯录')], 'Edit': [control('课程群', 'Edit')], 'List': [sessions, messages], 'ListItem': []}.get(control_type, [])
        main = SimpleNamespace(element_info=SimpleNamespace(class_name='WeChatMainWndForPC', process_id=123), window_text=lambda: '微信', descendants=descendants)
        with patch.object(bridge, 'windows', return_value=[main]), patch.object(bridge.subprocess, 'Popen') as launch:
            state = bridge.status()
            self.assertTrue(state['readable'])
            self.assertEqual(state['accountId'], 'uia:123:合成账号')
            self.assertEqual(bridge.groups()['groups'][0]['name'], '课程群')
            self.assertEqual(bridge.read_groups({'groups': ['课程群']})['chats'][0]['messages'][0]['text'], '请提交作业')
            launch.assert_not_called()

    def test_classic_qq_rejects_ambiguous_identity_and_private_chat_account_text(self):
        def text(value):
            return SimpleNamespace(element_info=SimpleNamespace(control_type='Text'), window_text=lambda: value)
        def window(title, labels):
            return SimpleNamespace(window_text=lambda: title, descendants=lambda **_: [text(value) for value in labels])
        with patch.object(qq_legacy, 'windows', return_value=[window('私人聊天', ['QQ号：12345678'])]):
            self.assertEqual(qq_legacy.status()['loginState'], 'unreadable')
        with patch.object(qq_legacy, 'windows', return_value=[window('QQ', ['QQ号：12345678'])]):
            state = qq_legacy.status()
            self.assertTrue(state['readable']); self.assertFalse(state['supportsHistory'])
            self.assertEqual(state['accountId'], '12345678')
        with patch.object(qq_legacy, 'windows', return_value=[window('QQ', ['QQ号：12345678', 'QQ号：87654321'])]):
            self.assertFalse(qq_legacy.status()['readable'])

    def test_contact_optional_fields_and_unknown_required_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            contact = root / 'contact.db'
            with closing(sqlite3.connect(contact, isolation_level=None)) as connection:
                connection.execute('CREATE TABLE contact (username TEXT, is_in_chat_room INT)')
                connection.execute('INSERT INTO contact VALUES (?,1)', ('synthetic@chatroom',))
            reader = database.DatabaseReader(root / 'private')
            reader.root = root
            def open_connection(_):
                connection = sqlite3.connect(contact)
                connection.row_factory = sqlite3.Row
                return connection
            with patch.object(reader, 'status', return_value={'readable': True}), patch.object(reader, 'connection', side_effect=open_connection):
                self.assertEqual(reader.groups()['groups'][0]['id'], 'synthetic@chatroom')
                with closing(sqlite3.connect(contact, isolation_level=None)) as connection:
                    connection.execute('DROP TABLE contact')
                    connection.execute('CREATE TABLE contact (unknown_format TEXT)')
                with self.assertRaises(environment.ClientIssue) as issue:
                    reader.groups()
                self.assertEqual(issue.exception.code, 'database_layout')


if __name__ == '__main__':
    unittest.main()
