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
window.fetch = (url, options = {}) => {
  const request = { url, options, body: options.body && JSON.parse(options.body) };
  requests.push(request);
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
const frame = (source, value) => source.onmessage({ data: JSON.stringify(value) });
const snapshot = (source, sequence = 0, busy = false, turn) => frame(source, { type: 'turn_snapshot', version: 1, sequence, busy, turn });
const root = createRoot(document.getElementById('root'));
const render = (workspaceId) => act(async () => { root.render(<StrictMode><AgentPanel workspaceId={workspaceId} /></StrictMode>); await tick(); });
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
  const staleMessage = sources[0].onmessage;
  const staleError = sources[0].onerror;
  await send('old prompt');
  assert(prompts()[0].body.clientId === second.body.clientId, 'prompt lacks active lease');
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
  return 'PASS: actual React StrictMode, pending-start unmount, pagehide idempotence, BFCache restore, stale callbacks/prompts, streaming and stop failures';
}
run().then((message) => { document.getElementById('result').textContent = message; }).catch((error) => { document.getElementById('result').textContent = `FAIL: ${error.stack}`; });
