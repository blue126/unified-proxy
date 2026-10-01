#!/usr/bin/env python3
"""Build a native Apple Shortcut; keep generated credential-bearing files private."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import uuid


def uid():
    return str(uuid.uuid4()).upper()


def token_string(*parts):
    text, attachments = '', {}
    for part in parts:
        if isinstance(part, dict):
            # Shortcuts uses UTF-16 ranges, including when the prompt is Chinese.
            position = len(text.encode('utf-16-le')) // 2
            attachments[f'{{{position}, 1}}'] = part['Value']
            text += '\ufffc'
        else:
            text += str(part)
    value = {'string': text}
    if attachments:
        value['attachmentsByRange'] = attachments
    return {'Value': value, 'WFSerializationType': 'WFTextTokenString'}


def variable(name):
    return {'Value': {'Type': 'Variable', 'VariableName': name},
            'WFSerializationType': 'WFTextTokenAttachment'}


def dictionary(values):
    items = []
    for key, value in values.items():
        nested = isinstance(value, dict) and 'WFSerializationType' not in value
        items.append({'WFKey': token_string(key), 'WFItemType': 1 if nested else 0,
                      'WFValue': dictionary(value) if nested else
                      (value if isinstance(value, dict) else token_string(value))})
    return {'Value': {'WFDictionaryFieldValueItems': items},
            'WFSerializationType': 'WFDictionaryFieldValue'}


class Shortcut:
    def __init__(self, repository, actor, credential):
        self.actions = []
        self.repository = repository
        self.actor = actor
        self.api = f'https://api.github.com/repos/{repository}/actions'
        self.workflow = 'server-maintenance.yml'
        self.action('comment', WFCommentActionText=(
            'Claude 重新认证：开始授权 → 浏览器授权 → 提交完整 code#state。\n'
            '会话有效 15 分钟，重复开始会使旧授权码失效。\n'
            '使用现有 main 分支 Server maintenance Actions。\n'
            '本快捷指令含个人 GitHub 凭证，请仅通过自己的 iCloud 同步，不要分享或导出。'))
        if credential is None:
            source = self.action('ask', WFAskActionPrompt='输入 GitHub token（仅本次运行使用）',
                                 WFInputType='Text', WFAskActionMultiline=False)
        else:
            source = self.action('gettext', WFTextActionText=credential)
        self.setvar('GitHubToken', source)
        placeholder = self.conditional(variable('GitHubToken'), 'GITHUB_TOKEN_REPLACE_LOCALLY')
        self.alert('尚未配置 GitHub 凭证', '这是无凭证预览。请在配置 token 后使用，或生成每次运行询问 token 的版本。')
        self.stop('尚未配置 GitHub 凭证')
        self.endif(placeholder)

    def action(self, name, **parameters):
        action_id = uid()
        parameters['UUID'] = action_id
        self.actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + name,
                             'WFWorkflowActionParameters': parameters})
        return {'Value': {'Type': 'ActionOutput', 'OutputUUID': action_id,
                          'OutputName': 'Result'},
                'WFSerializationType': 'WFTextTokenAttachment'}

    def setvar(self, name, value):
        self.action('setvariable', WFVariableName=name, WFInput=value)

    def text(self, *parts):
        return self.action('gettext', WFTextActionText=token_string(*parts))

    def http(self, url, body=None):
        p = {'WFURL': token_string(url) if isinstance(url, str) else url,
             'WFHTTPMethod': 'POST' if body else 'GET', 'ShowHeaders': True,
             'WFHTTPHeaders': dictionary({
                 'Accept': 'application/vnd.github+json',
                 'Authorization': token_string('Bearer ', variable('GitHubToken')),
                 'X-GitHub-Api-Version': '2022-11-28',
             })}
        if body:
            p.update(WFHTTPBodyType='JSON', WFJSONValues=dictionary(body))
        return self.action('downloadurl', **p)

    def key(self, value, key):
        return self.action('getvalueforkey', WFInput=value, WFDictionaryKey=key)

    def first(self, value):
        return self.action('getitemfromlist', WFInput=value, WFItemSpecifier='First Item')

    def conditional(self, value, equals=None):
        group = uid()
        if equals is not None:
            # Dictionary values can be inferred as numbers. Comparing Text also
            # makes run IDs use the same condition/value fields as statuses.
            value = self.text(value)
        p = {'GroupingIdentifier': group, 'WFControlFlowMode': 0,
             'WFInput': {'Type': 'Variable', 'Variable': value},
             'WFCondition': 100 if equals is None else 4}
        if equals is not None:
            p['WFConditionalActionString'] = equals if isinstance(equals, dict) else token_string(equals)
        self.action('conditional', **p)
        return group

    def otherwise(self, group):
        self.action('conditional', GroupingIdentifier=group, WFControlFlowMode=1)

    def endif(self, group):
        self.action('conditional', GroupingIdentifier=group, WFControlFlowMode=2)

    def repeat(self, count):
        group = uid()
        self.action('repeat.count', GroupingIdentifier=group, WFControlFlowMode=0,
                    WFRepeatCount=count)
        return group

    def endrepeat(self, group):
        self.action('repeat.count', GroupingIdentifier=group, WFControlFlowMode=2)

    def alert(self, title, *parts):
        self.action('alert', WFAlertActionTitle=title,
                    WFAlertActionMessage=token_string(*parts), WFAlertActionCancelButtonShown=False)

    def stop(self, *parts):
        self.action('output', WFOutput=token_string(self.text(*parts)))

    def latest(self):
        response = self.http(f'{self.api}/workflows/{self.workflow}/runs'
                             f'?event=workflow_dispatch&branch=main&actor={self.actor}&per_page=1')
        return self.first(self.key(response, 'workflow_runs'))

    def failure(self, message, run_url=None):
        self.alert('Claude 认证未完成', message,
                   '\n可选择“查看最近结果”打开 Actions。不要重复提交同一授权码。')
        if run_url:
            self.action('openurl', WFInput=run_url)
        self.stop('未完成')

    def dispatch_and_wait(self, operation, code=None):
        self.setvar('PreviousRunID', self.key(self.latest(), 'id'))
        inputs = {'operation': operation}
        if code:
            inputs['authorization_code'] = code
        self.http(f'{self.api}/workflows/{self.workflow}/dispatches',
                  {'ref': 'main', 'inputs': inputs})
        self.setvar('RunID', self.text('pending'))
        self.setvar('RunFinished', self.text('no'))
        discover = self.repeat(12)
        exists = self.conditional(variable('RunID'), 'pending')
        self.action('delay', WFDelayTime=5)
        self.setvar('CandidateRun', self.latest())
        candidate_id = self.key(variable('CandidateRun'), 'id')
        same = self.conditional(candidate_id, token_string(variable('PreviousRunID')))
        self.otherwise(same)
        self.setvar('RunID', candidate_id)
        self.setvar('RunURL', self.key(variable('CandidateRun'), 'html_url'))
        self.endif(same)
        self.endif(exists)
        self.endrepeat(discover)
        found = self.conditional(variable('RunID'), 'pending')
        self.failure('GitHub 未在 60 秒内返回新的维护运行。请先检查 Actions。')
        self.endif(found)
        poll = self.repeat(36)
        finished = self.conditional(variable('RunFinished'), 'yes')
        self.otherwise(finished)
        self.setvar('Run', self.http(token_string(self.api, '/runs/', variable('RunID'))))
        status = self.key(variable('Run'), 'status')
        done = self.conditional(status, 'completed')
        self.setvar('RunFinished', self.text('yes'))
        self.otherwise(done)
        self.action('delay', WFDelayTime=10)
        self.endif(done)
        self.endif(finished)
        self.endrepeat(poll)
        done = self.conditional(variable('RunFinished'), 'yes')
        self.otherwise(done)
        self.failure('维护仍在排队或运行，请稍后查看最近结果。', variable('RunURL'))
        self.endif(done)
        success = self.conditional(self.key(variable('Run'), 'conclusion'), 'success')
        self.otherwise(success)
        self.failure('GitHub Actions 报告维护失败，请查看日志后重新开始授权。', variable('RunURL'))
        self.endif(success)

    def build(self):
        menu = uid()
        choices = ['开始浏览器授权', '提交授权码', '查看最近结果']
        self.action('choosefrommenu', GroupingIdentifier=menu, WFControlFlowMode=0,
                    WFMenuItems=choices, WFMenuPrompt='Claude 重新认证')
        self.action('choosefrommenu', GroupingIdentifier=menu, WFControlFlowMode=1,
                    WFMenuItemTitle=choices[0])
        self.dispatch_and_wait('claude-login-start')
        logs = self.http(token_string(self.api, '/runs/', variable('RunID'), '/logs'))
        files = self.action('unzip', WFArchive=logs)
        text = self.action('detect.text', WFInput=files)
        matches = self.action('text.match', WFMatchTextPattern=r'https://claude\.ai/oauth/authorize\?[^\s<>]+',
                              text=token_string(text))
        has_url = self.conditional(matches)
        self.otherwise(has_url)
        self.failure('维护成功，但日志中未找到 Claude 授权链接。', variable('RunURL'))
        self.endif(has_url)
        self.alert('请在浏览器完成授权',
                   '浏览器即将打开。完成后复制完整 code#state，再运行本快捷指令并选择“提交授权码”。\n'
                   '请在 15 分钟内完成，期间不要再次选择“开始浏览器授权”。')
        self.action('openurl', WFInput=self.first(matches))
        self.stop('已打开 Claude 授权页面')
        self.action('choosefrommenu', GroupingIdentifier=menu, WFControlFlowMode=1,
                    WFMenuItemTitle=choices[1])
        code = self.action('ask', WFAskActionPrompt='粘贴浏览器返回的完整 code#state（不要添加空格或换行）',
                           WFInputType='Text', WFAskActionMultiline=False)
        valid = self.action('text.match', WFMatchTextPattern=r'^[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$',
                            text=token_string(code))
        correct = self.conditional(valid)
        self.otherwise(correct)
        self.failure('授权码格式不正确。需要完整的一行 code#state。')
        self.endif(correct)
        self.dispatch_and_wait('claude-login-complete', self.first(valid))
        self.alert('Claude 重新认证成功', '凭证已保存，服务已启动，Claude 实际推理验证通过。')
        self.stop('Claude 重新认证成功；实际推理验证通过')
        self.action('choosefrommenu', GroupingIdentifier=menu, WFControlFlowMode=1,
                    WFMenuItemTitle=choices[2])
        self.setvar('LatestRun', self.latest())
        status = self.key(variable('LatestRun'), 'status')
        result = self.key(variable('LatestRun'), 'conclusion')
        self.alert('最近一次维护运行', '状态：', status, '\n结果：', result,
                   '\n将打开该次 Actions 运行。只有 claude-login-complete 成功才表示推理验证通过。')
        self.action('openurl', WFInput=self.key(variable('LatestRun'), 'html_url'))
        self.stop('已打开最近维护结果')
        self.action('choosefrommenu', GroupingIdentifier=menu, WFControlFlowMode=2)
        return {'WFWorkflowName': 'Claude 重新认证', 'WFWorkflowMinimumClientVersion': 900,
                'WFWorkflowMinimumClientVersionString': '900', 'WFWorkflowClientVersion': '5037.0.19',
                'WFWorkflowIcon': {'WFWorkflowIconStartColor': 4251333119,
                                   'WFWorkflowIconGlyphNumber': 59511},
                'WFWorkflowActions': self.actions, 'WFWorkflowTypes': ['WFWorkflowTypeShowInSearch'],
                'WFWorkflowInputContentItemClasses': [], 'WFWorkflowOutputContentItemClasses': [],
                'WFWorkflowImportQuestions': [], 'WFQuickActionSurfaces': [],
                'WFWorkflowHasOutputFallback': False, 'WFWorkflowHasShortcutInputVariables': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', default='blue126/unified-proxy')
    parser.add_argument('--actor', default='blue126')
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--from-gh', action='store_true', help='Read and save the configured gh credential without printing it')
    source.add_argument('--ask-token', action='store_true', help='Ask for a token on every run instead of saving it')
    parser.add_argument('--output', type=Path, required=True, help='Private unsigned .shortcut output outside the repository')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    output = args.output.resolve()
    if output.is_relative_to(root):
        parser.error('Generated shortcuts must be saved outside the repository, because they may contain credentials.')
    try:
        credential = subprocess.check_output(['gh', 'auth', 'token'], text=True).strip() if args.from_gh else None if args.ask_token else 'GITHUB_TOKEN_REPLACE_LOCALLY'
    except subprocess.CalledProcessError:
        parser.error('No GitHub credential is available. Run gh auth login, or use --ask-token.')
    if args.from_gh and not credential:
        parser.error('No GitHub credential is configured.')
    workflow = Shortcut(args.repo, args.actor, credential).build()
    # O_EXCL prevents overwriting an existing credential-bearing shortcut.
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as target:
        plistlib.dump(workflow, target, fmt=plistlib.FMT_XML)
    print(f'Created {output} ({len(workflow["WFWorkflowActions"])} native actions; credential not printed).')


if __name__ == '__main__':
    main()
