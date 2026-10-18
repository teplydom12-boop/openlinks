"""Real MV3 integration, with fresh Chromium profile and synthetic vendor pages.

Unlike dialogs_ui_browser_test.py, this test does not replace any Chrome API or
inject the production reader manually. The unpacked manifest, worker, content
scripts, runtime messages and local storage must work together. All HTTP(S)
requests are intercepted; DNS is also disabled for external hosts.

Managed Chromium may forbid unpacked extensions. In that case the test reports
SKIP, never PASS. Set OPENLINKS_REQUIRE_MV3=1 to make an unavailable environment
fail CI. No enterprise policy is modified or bypassed.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect, TimeoutError as PlaywrightTimeout

ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / 'extension'
FIXTURE = (ROOT / 'tests/fixtures/dialogs-synthetic.html').read_text()
URLS = {
    '1688': 'https://air.1688.com/chat',
    'alibaba': 'https://onetalk.alibaba.com/message/weblite.htm',
    'mic': 'https://webim.made-in-china.com/super-tm/',
}
checks = 0


class UnsupportedEnvironment(Exception):
    pass


def passed(name):
    global checks
    checks += 1
    print('PASS ' + name, flush=True)


def blocked_by_managed_policy():
    for directory in ['/etc/chromium/policies/managed', '/etc/opt/chrome/policies/managed']:
        for path in Path(directory).glob('*.json'):
            try:
                policy = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if '*' in policy.get('ExtensionInstallBlocklist', []):
                return True
    return False


def command(ui, name, **payload):
    return ui.evaluate('(message)=>chrome.runtime.sendMessage(message)', {'type': name, **payload})


def command_ok(ui, name, **payload):
    result = command(ui, name, **payload)
    assert result and result.get('ok'), (name, result)
    return result


def probe(page):
    return page.evaluate('''() => ({url:location.href, draft:document.querySelector('textarea').value,
      history:document.querySelector('[data-message-history]').textContent,
      events:{...readerSideEffects}})''')


def run():
    manifest = json.loads((EXTENSION / 'manifest.json').read_text())
    assert manifest['manifest_version'] == 3
    assert (EXTENSION / manifest['background']['service_worker']).is_file()
    managed_block = blocked_by_managed_policy()
    with tempfile.TemporaryDirectory(prefix='openlinks-mv3-', dir='/tmp') as profile:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                profile,
                executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
                channel='chromium',
                headless=True,
                viewport={'width': 1440, 'height': 1000},
                timezone_id='Asia/Irkutsk',
                ignore_default_args=['--disable-extensions'],
                args=[
                    f'--disable-extensions-except={EXTENSION}',
                    f'--load-extension={EXTENSION}',
                    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
                ],
            )
            external_attempts = []
            ai_attempts = []
            page_errors = []
            vendor_pages = {}

            def intercept(route):
                url = route.request.url
                if url in URLS.values():
                    route.fulfill(status=200, content_type='text/html', body=FIXTURE)
                elif urlsplit(url).path == '/favicon.ico' and any(urlsplit(url).hostname == urlsplit(value).hostname for value in URLS.values()):
                    route.fulfill(status=204, body='')
                else:
                    external_attempts.append(url)
                    route.abort()

            context.route('http://**/*', intercept)
            context.route('https://**/*', intercept)
            context.on('request', lambda request: ai_attempts.append(request.url) if urlsplit(request.url).hostname == 'api.openai.com' else None)
            context.on('page', lambda page: page.on('pageerror', lambda error: page_errors.append(str(error))))
            try:
                workers = [worker for worker in context.service_workers if worker.url.endswith('/background.js')]
                if workers:
                    worker = workers[0]
                else:
                    try:
                        worker = context.wait_for_event('serviceworker', predicate=lambda item: item.url.endswith('/background.js'), timeout=10000)
                    except PlaywrightTimeout:
                        if managed_block:
                            raise UnsupportedEnvironment('managed ExtensionInstallBlocklist=["*"] prevented the unpacked MV3 worker from loading')
                        raise UnsupportedEnvironment('Chromium did not expose the unpacked extension worker; this build/headless environment did not validate MV3 loading')

                assert worker.url.startswith('chrome-extension://'), worker.url
                extension_id = urlsplit(worker.url).hostname
                ui = context.new_page()
                ui.goto(f'chrome-extension://{extension_id}/dialogs.html')
                expect(ui.locator('#dialogs-run-state')).to_have_text('Мониторинг остановлен')
                first = command_ok(ui, 'DIALOGS_GET')
                assert first['state']['running'] is False
                assert first['state']['mode'] == 'observe'
                assert first['ai'] == {'model': '', 'keyStored': False}
                assert command_ok(ui, 'GET')['state']['running'] is False
                assert ui.evaluate('chrome.runtime.getManifest().version') == manifest['version']
                passed('real unpacked MV3 worker and extension page load; both monitoring and outreach are initially paused')

                for platform, url in URLS.items():
                    page = context.new_page()
                    page.goto(url)
                    vendor_pages[platform] = page
                tabs = command_ok(ui, 'DIALOGS_LIST_TABS')['tabs']
                by_platform = {tab['platform']: tab for tab in tabs}
                assert set(by_platform) == set(URLS), tabs
                before = {platform: probe(page) for platform, page in vendor_pages.items()}
                for platform, tab in by_platform.items():
                    response = command_ok(ui, 'DIALOGS_BIND_TAB', platform=platform, tabId=tab['id'])
                    assert response['state']['bindings'][platform]['tabId'] == tab['id']
                # Manifest-installed content scripts must answer through real tabs.sendMessage.
                ui.wait_for_function('''async ids => {
                  try { const replies=await Promise.all(ids.map(tabId=>chrome.tabs.sendMessage(tabId,{type:'DIALOGS_SNAPSHOT'})));
                    return replies.every(reply=>reply?.status==='ready');
                  } catch { return false; }
                }''', arg=[tab['id'] for tab in by_platform.values()], timeout=10000)
                result = command_ok(ui, 'DIALOGS_SCAN')
                state = result['state']
                assert all(binding['status'] == 'ready' for binding in state['bindings'].values())
                conversations = list(state['conversations'].values())
                assert len(conversations) == 6, conversations
                histories = [conversation for conversation in conversations if conversation['messages']]
                previews = [conversation for conversation in conversations if not conversation['messages']]
                assert len(histories) == len(previews) == 3
                assert all(conversation['unanswered'] and conversation['messages'][-1]['direction'] == 'inbound' for conversation in histories)
                assert all(conversation['needsRead'] and not conversation['unanswered'] for conversation in previews)
                passed('real tab IDs, content-script isolation and worker messaging read all three synthetic inboxes without confusing previews with histories')

                saved = ui.evaluate("async()=>await chrome.storage.local.get(['openlinksDialogs','openlinksState'])")
                assert len(saved['openlinksDialogs']['conversations']) == 6
                assert saved['openlinksDialogs']['running'] is False
                assert saved['openlinksState']['running'] is False
                assert not saved['openlinksState']['queue']
                ui.reload()
                expect(ui.locator('.dialogs-thread')).to_have_count(6)
                restored = command_ok(ui, 'DIALOGS_GET')['state']
                assert restored['bindings'] == state['bindings']
                assert len(restored['conversations']) == 6
                passed('separate real chrome.storage.local state and bindings survive reopening the extension UI')

                command_ok(ui, 'DIALOGS_START', readUnread=False)
                alarms = ui.evaluate('async()=>await chrome.alarms.getAll()')
                assert any(alarm['name'] == 'openlinks-dialogs' and alarm['periodInMinutes'] == 0.5 for alarm in alarms), alarms
                command_ok(ui, 'DIALOGS_STOP')
                assert not any(alarm['name'] == 'openlinks-dialogs' for alarm in ui.evaluate('async()=>await chrome.alarms.getAll()'))
                assert command_ok(ui, 'GET')['state']['running'] is False
                passed('real Chrome alarms are installed and cleared without starting the outreach queue')

                tab_id = by_platform['1688']['id']
                job_id = ui.evaluate('''async () => {
                  const {initialState,parseList}=await import('./lib/core.js');
                  const state=initialState();state.queue=parseList('https://synthetic-store.1688.com/').jobs;
                  const job=state.queue[0];job.status='blocked';state.activeId=job.id;
                  await chrome.storage.local.set({openlinksState:state});return job.id;
                }''')
                rejected = command(ui, 'BIND_TAB', tabId=tab_id)
                assert not rejected['ok'] and 'мониторинг' in rejected['error'].lower(), rejected
                assert command_ok(ui, 'GET')['state']['running'] is False
                # A stale legacy reference must not make manual Skip close a reserved monitor tab.
                ui.evaluate('''async ({tabId,url}) => {
                  const {openlinksState:state}=await chrome.storage.local.get('openlinksState');
                  Object.assign(state.queue[0],{tabId,supplierTabId:tabId,boundTabUrl:url});
                  await chrome.storage.local.set({openlinksState:state});
                }''', {'tabId': tab_id, 'url': URLS['1688']})
                command_ok(ui, 'SKIP', id=job_id)
                remaining = ui.evaluate('(id)=>chrome.tabs.get(id)', tab_id)
                assert remaining['url'] == URLS['1688']
                assert command_ok(ui, 'GET')['state']['running'] is False
                assert command_ok(ui, 'DIALOGS_GET')['state']['bindings']['1688']['tabId'] == tab_id
                passed('legacy queue cannot bind or close a monitored tab, including a stale legacy tab reference')

                after = {platform: probe(page) for platform, page in vendor_pages.items()}
                assert after == before, (before, after)
                assert not ai_attempts, ai_attempts
                assert not external_attempts, external_attempts
                assert not page_errors, page_errors
                passed('fixture DOM, existing drafts and click/input/focus counters stay unchanged; no external or AI request is attempted')
            finally:
                context.close()


if __name__ == '__main__':
    try:
        run()
    except UnsupportedEnvironment as error:
        print(f'SKIP real MV3 extension integration: {error}. {checks} checks completed; unavailable checks are not counted as passed.', flush=True)
        sys.exit(1 if os.environ.get('OPENLINKS_REQUIRE_MV3') == '1' else 0)
    print(f'{checks} real MV3 extension integration checks passed', flush=True)
