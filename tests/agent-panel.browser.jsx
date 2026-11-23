import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import AgentPanel from '../app/components/AgentPanel';

// Bundled only by agent-panel.test.ts; never talks to a workspace or model.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const requests = [];
const sources = [];
const warnings = [];
console.warn = (...args) => warnings.push(args.join(' '));
const assert = (value, message) => { if (!value) throw new Error(message); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let stopFailure = false;
let historyMode = 'prod';
window.fetch = (url, options = {}) => {
  const request = { url, options, body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body };
  requests.push(request);
  if (url.includes('/session?') && historyMode === 'prod') {
    return Promise.resolve(Response.json({ apiVersion: 'v1', supported: false }));
  }
  if (url.endsWith('/stop')) {
    if (stopFailure) return Promise.reject(new Error('SECRET transport detail'));
    return Promise.resolve({ ok: false, status: 503 });
  }
  return new Promise((resolve, reject) => Object.assign(request, { resolve, reject }));
};
window.EventSource = class {
  constructor(url) { this.url = url; this.closed = false; sources.push(this); }
  close() { this.closed = true; }
};
const starts = () => requests.filter((r) => r.url.endsWith('/start'));
const stops = () => requests.filter((r) => r.url.endsWith('/stop'));
const prompts = () => requests.filter((r) => r.url.endsWith('/prompt'));
const cancels = () => requests.filter((r) => r.url.endsWith('/cancel'));
const histories = () => requests.filter((r) => r.url.includes('/session?'));
const sessionActions = () => requests.filter((r) => r.url.endsWith('/session') && r.options.method === 'POST');
const frame = (source, value) => source.onmessage({ data: JSON.stringify(value) });
const revision = '00000000-0000-4000-8000-000000000001';
const snapshot = (source, sequence = 0, busy = false, turn, sessionRevision = revision, switching = false, uncertain = false) =>
  frame(source, { type: 'turn_snapshot', version: 1, sequence, busy, turn, revision: sessionRevision, switching, uncertain });
const root = createRoot(document.getElementById('root'));
const render = (workspaceId) => act(async () => { root.render(<StrictMode><AgentPanel workspaceId={workspaceId} maxFileBytes={1024} /></StrictMode>); await tick(); });
const page = (type, persisted = false) => act(async () => { window.dispatchEvent(new PageTransitionEvent(type, { persisted })); await tick(); });
const resolve = (request, ok = true) => act(async () => { request.resolve({ ok, status: ok ? 200 : 500 }); await tick(); });
async function send(text) {
  await act(async () => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick(); });
}
async function run() {
  await render('test-workspace');
  assert(starts().length === 2, 'StrictMode must activate twice');
  const [first, second] = starts();
  assert(first.body.clientId !== second.body.clientId, 'StrictMode reused lease');
  assert(first.options.signal.aborted && stops().length === 1, 'StrictMode must abort and release first start');
  assert(stops()[0].body.clientId === first.body.clientId, 'StrictMode released wrong lease');
  assert(Number.isFinite(first.body.issuedAt), 'start lacks issuedAt');
  await send('not ready');
  assert(prompts().length === 0, 'prompt sent before current start was ready');
  await page('pageshow', false);
  assert(starts().length === 2, 'ordinary pageshow activated an extra lease');
  await resolve(first);
  assert(sources.length === 0, 'late first start subscribed');
  await resolve(second);
  assert(sources[0].url.endsWith(`?clientId=${second.body.clientId}`), 'events missing lease');
  await act(async () => { snapshot(sources[0]); });
  async function selectFile(file) {
    await act(async () => {
      const input = document.querySelector('input[type=file]');
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
    });
  }
  const uploads = () => requests.filter((request) => request.url.includes('/files/'));
  const remove = (name) => act(async () => { document.querySelector(`button[aria-label="移除附件 ${name}"]`).click(); await tick(); });
  assert(document.body.textContent.includes('1,024 字节'), 'configured limit not shown');
  await selectFile(new File([new Uint8Array(1025)], 'large.txt'));
  assert(uploads().length === 0 && document.body.textContent.includes('1,025 字节') && document.body.textContent.includes('1,024 字节'), 'local size failure was not shown');
  await remove('large.txt');
  await selectFile(new File(['data'], 'gateway.txt'));
  await act(async () => { uploads().at(-1).resolve(new Response('<html>413</html>', { status: 413, headers: { 'Content-Type': 'text/html' } })); await tick(); });
  assert(document.body.textContent.includes('服务器或网关拒绝了请求（413）'), 'gateway size failure was not shown');
  await remove('gateway.txt');
  await selectFile(new File(['data'], 'total.txt'));
  await act(async () => { uploads().at(-1).resolve(new Response(JSON.stringify({ error: { code: 'WORKSPACE_TOTAL_TOO_LARGE', message: '工作区总大小超过上限。' } }), { status: 413, headers: { 'Content-Type': 'application/json' } })); await tick(); });
  assert(document.body.textContent.includes('工作区总大小超过上限'), 'server error reason was not shown');
  await remove('total.txt');
  await selectFile(new File(['data'], 'offline.txt'));
  await act(async () => { uploads().at(-1).reject(new Error('private detail')); await tick(); });
  assert(document.body.textContent.includes('网络连接失败') && !document.body.textContent.includes('private detail'), 'network failure was not safely shown');
  await remove('offline.txt');
  const file = new File([new Uint8Array([0, 255, 128, 65])], '图片 1.png', { type: 'image/png' });
  await selectFile(file);
  const upload = uploads().at(-1);
  assert(upload && upload.options.headers['Content-Type'] === 'application/octet-stream', 'upload did not use raw bytes');
  assert(upload.body instanceof File && upload.body.name === file.name, 'upload changed the selected file');
  assert(Array.from(new Uint8Array(await upload.body.arrayBuffer())).join(',') === '0,255,128,65', 'upload corrupted binary data');
  const segments = new URL(upload.url, window.location.origin).pathname.split('/').slice(-2).map(decodeURIComponent);
  assert(segments[0] === '.attachments' && segments[1].endsWith('-图片 1.png'), 'upload encoded the path as one segment');
  await resolve(upload);
  assert(!document.body.textContent.includes('上传失败'), 'successful upload shown as failed');
  const staleMessage = sources[0].onmessage;
  const staleError = sources[0].onerror;
  await send('old prompt');
  assert(prompts()[0].body.clientId === second.body.clientId, 'prompt lacks active lease');
  assert(prompts()[0].body.message.includes(`.attachments/${segments[1]}`), 'prompt omitted the uploaded attachment');
  await page('visibilitychange');
  assert(stops().length === 1, 'visibility change released lease');
  await page('pagehide', true);
  assert(sources[0].closed && second.options.signal.aborted, 'pagehide did not close/abort');
  assert(stops().length === 2 && stops()[1].options.keepalive, 'pagehide missing keepalive stop');
  assert(stops()[1].body.issuedAt === second.body.issuedAt, 'stop changed lease timestamp');
  await page('pagehide', true);
  assert(stops().length === 2, 'pagehide not idempotent');
  await page('pageshow', true);
  const third = starts()[2];
  assert(third.body.clientId !== second.body.clientId, 'BFCache reused lease');
  await resolve(third);
  await act(async () => { snapshot(sources[1]); });
  await send('new prompt');
  assert(prompts()[1].body.clientId === third.body.clientId, 'restored prompt used old lease');
  await act(async () => {
    staleMessage({ data: JSON.stringify({ type: 'agent_end' }) });
    staleMessage({ data: JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'STALE' } }) });
    staleError();
    prompts()[0].reject(new Error('old prompt failed'));
    await tick();
  });
  assert(document.body.textContent.includes('正在处理'), 'stale response cleared new busy state');
  assert(!document.body.textContent.includes('STALE') && !document.body.textContent.includes('消息发送失败'), 'stale callbacks changed messages');
  const turnId = prompts()[1].body.turnId;
  assert(turnId && document.body.textContent.includes('停止'), 'active turn must expose stop before text');
  await act(async () => {
    snapshot(sources[1], 1, true, { id: turnId, text: '', phase: 'running', activities: [] });
    frame(sources[1], { type: 'turn_event', version: 1, sequence: 2, turnId, event: { kind: 'text', delta: '正常回复' } });
    frame(sources[1], { type: 'turn_event', version: 1, sequence: 3, turnId, event: { kind: 'activity', activity: { id: 'tool-1', name: 'bash', status: 'running' } } });
    frame(sources[1], { type: 'turn_event', version: 1, sequence: 4, turnId, event: { kind: 'phase', phase: 'retrying' } });
  });
  assert(document.body.textContent.includes('正常回复') && document.body.textContent.includes('正在重试'), 'stream/retry behavior regressed');
  assert(document.body.textContent.includes('执行命令') && document.body.textContent.includes('进行中'), 'tool activity missing');
  await act(async () => {
    [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '停止').click();
    await tick();
  });
  assert(cancels().length === 1 && cancels()[0].body.turnId === turnId, 'stop did not request the active turn');
  assert(document.body.textContent.includes('正在停止'), 'pending stop not visible');
  await act(async () => {
    snapshot(sources[1], 5, false, { id: turnId, text: '正常回复', phase: 'stopped', activities: [{ id: 'tool-1', name: 'bash', status: 'done' }] });
  });
  assert(document.body.textContent.includes('等待输入') && document.body.textContent.includes('已停止'), 'terminal snapshot did not finish turn');
  await resolve(cancels()[0]);
  await send('after stop');
  assert(prompts().length === 3, 'cannot send another prompt after stopping');
  await page('pagehide');
  await act(async () => { root.unmount(); await tick(); });
  assert(stops().length === 3, 'unmount double-released hidden lease');
  const count = starts().length;
  await page('pageshow', true);
  assert(starts().length === count, 'unmounted pageshow listener leaked');
  assert(stops().every((r) => r.options.headers['Content-Type'] === 'application/json'), 'stop must use JSON');
  assert(warnings.some((w) => w.includes('503')), 'non-2xx stop unobserved');

  const otherRoot = createRoot(document.getElementById('root'));
  await act(async () => { otherRoot.render(<AgentPanel workspaceId="pending" />); await tick(); });
  const pending = starts().at(-1);
  stopFailure = true;
  await act(async () => { otherRoot.unmount(); await tick(); });
  assert(pending.options.signal.aborted, 'unmount failed to abort pending start');
  await resolve(pending);
  assert(sources.length === 2, 'unmounted late start subscribed');
  assert(warnings.some((w) => w.includes('request failed')) && !warnings.join('').includes('SECRET'), 'async stop failure leaked or was not observed');

  historyMode = 'manual';
  const historyRoot = createRoot(document.getElementById('root'));
  await act(async () => { historyRoot.render(<AgentPanel workspaceId="restore-a" />); await tick(); });
  await resolve(starts().at(-1));
  const historySource = sources.at(-1);
  const beforeHistory = histories().length;
  await act(async () => { snapshot(historySource, 1, true); await tick(); });
  assert(histories().length === beforeHistory, 'history loaded during another page turn');
  await act(async () => { snapshot(historySource, 2, false); await tick(); });
  const oldHistory = histories().at(-1);
  assert(histories().length === beforeHistory + 1, 'idle session not requested');
  const beforePrompt = prompts().length;
  await send('not ready');
  assert(prompts().length === beforePrompt, 'prompt sent before history restored');
  await act(async () => { snapshot(historySource, 3, true); snapshot(historySource, 4, false); await tick(); });
  await act(async () => {
    oldHistory.resolve(Response.json({ apiVersion: 'v1', supported: true, revision, canRestore: true, sequence: 2, messages: [{ id: 'old', role: 'user', text: 'stale history' }] }));
    await tick();
  });
  assert(!document.body.textContent.includes('stale history'), 'stale history overwrote newer turn');
  const freshHistory = histories().at(-1);
  assert(freshHistory !== oldHistory, 'stale history was not retried');
  await act(async () => {
    freshHistory.resolve(Response.json({ apiVersion: 'v1', supported: true, revision, canRestore: true, sequence: 4, messages: [
      { id: '1', role: 'user', text: 'restored question' }, { id: '2', role: 'agent', text: 'restored answer' },
    ] }));
    await tick();
  });
  assert(document.body.textContent.includes('restored question') && document.body.textContent.includes('restored answer'), 'history not rendered');
  await act(async () => { snapshot(historySource, 5, true); snapshot(historySource, 6, false); await tick(); });
  const updatedHistory = histories().at(-1);
  assert(updatedHistory !== freshHistory, 'other page completion did not refresh history');
  await act(async () => {
    updatedHistory.resolve(Response.json({ apiVersion: 'v1', supported: true, revision, canRestore: true, sequence: 6, messages: [
      { id: '1', role: 'user', text: 'restored question' }, { id: '2', role: 'agent', text: 'restored answer' },
      { id: '3', role: 'agent', text: 'other page answer' },
    ] }));
    await tick();
  });
  assert(document.body.textContent.includes('other page answer'), 'other page conversation was not recovered');
  await act(async () => { historySource.onerror(); snapshot(historySource, 7, false); await tick(); });
  const reconnectedHistory = histories().at(-1);
  assert(reconnectedHistory !== updatedHistory, 'reconnect did not reload history');
  await act(async () => {
    reconnectedHistory.resolve(Response.json({ apiVersion: 'v1', supported: true, revision, canRestore: true, sequence: 7, messages: [
      { id: '1', role: 'user', text: 'restored question' }, { id: '2', role: 'agent', text: 'restored answer' },
    ] }));
    await tick();
  });
  assert(document.body.textContent.split('restored question').length === 2, 'reconnect duplicated messages');
  const newButton = document.querySelector('button[aria-label="新建会话"]');
  const restoreButton = document.querySelector('button[aria-label="恢复上次会话"]');
  assert(newButton && restoreButton && !newButton.textContent.trim() && !restoreButton.textContent.trim(), 'session controls must be icon-only');
  assert(newButton.title && restoreButton.title.includes('24 小时'), 'session control hover descriptions missing');
  assert(document.body.textContent.includes('仅可恢复最近 24 小时内的上次会话'), '24-hour notice missing');
  await act(async () => { newButton.click(); await tick(); });
  const create = sessionActions().at(-1);
  assert(create.body.action === 'new' && create.body.revision === revision, 'new session omitted revision');
  const nextRevision = '00000000-0000-4000-8000-000000000002';
  await act(async () => { snapshot(historySource, 8, true, undefined, nextRevision, true); await tick(); });
  assert(!document.body.textContent.includes('restored question') && newButton.disabled, 'switch did not invalidate old chat');
  await act(async () => { create.resolve(Response.json({ cancelled: false })); snapshot(historySource, 9, false, undefined, nextRevision); await tick(); });
  const emptyHistory = histories().at(-1);
  await act(async () => { emptyHistory.resolve(Response.json({ supported: true, revision: nextRevision, canRestore: true, sequence: 9, messages: [] })); await tick(); });
  assert(!restoreButton.disabled, 'previous session should be available after new session');
  await act(async () => { restoreButton.click(); await tick(); });
  const restore = sessionActions().at(-1);
  assert(restore.body.action === 'restore' && restore.body.revision === nextRevision, 'restore omitted current revision');
  const restoredRevision = '00000000-0000-4000-8000-000000000003';
  await act(async () => { snapshot(historySource, 10, true, undefined, restoredRevision, true); restore.resolve(Response.json({ cancelled: false })); snapshot(historySource, 11, false, undefined, restoredRevision); await tick(); });
  const restoredHistory = histories().at(-1);
  await act(async () => { restoredHistory.resolve(Response.json({ supported: true, revision: restoredRevision, canRestore: false, sequence: 11, messages: [{ id: '1', role: 'user', text: 'restored question' }] })); await tick(); });
  assert(document.body.textContent.includes('restored question') && restoreButton.disabled, 'restored session or consumed target incorrect');
  await act(async () => { historyRoot.render(<AgentPanel workspaceId="restore-b" />); await tick(); });
  assert(!document.body.textContent.includes('restored question'), 'previous workspace history leaked');
  await act(async () => { historyRoot.unmount(); await tick(); });
  return 'PASS: actual React StrictMode, pending-start unmount, BFCache, streaming, latest session restore and stale history';
}
run().then((message) => { document.getElementById('result').textContent = message; }).catch((error) => { document.getElementById('result').textContent = `FAIL: ${error.stack}`; });
