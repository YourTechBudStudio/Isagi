// The desktop loader's render script. Plain script, no imports: the loader must paint before anything else exists.
// State arrives in the query string (built by apps/desktop/src/main/loader-url.ts); Open logs and Quit go through the
// preload's `window.isagiLoader` bridge.
'use strict';

// Approved copy (phase 02). Titles and bodies carry no humour; the whisper shows only while loading.
const copy = {
  starting: { status: 'Starting the runtime…' },
  slow: { status: 'Still starting the runtime…' },
  // Reused verbatim from the web `connecting` view so the handoff reads as one screen.
  whisper: '// gathering the facts before opening the door',
  openLogs: 'Open logs',
  quit: 'Quit Isagi',
  failed: {
    not_started: {
      title: "The runtime couldn't be started.",
      body: "Isagi couldn't launch its runtime. The logs should say why. Quit and reopen Isagi to try again.",
    },
    readiness_timeout: {
      title: "The runtime didn't start in time.",
      body: 'Isagi started its runtime, but it never reported ready. The logs should show what it was stuck on. Quit and reopen Isagi to try again.',
    },
    exited_before_ready: {
      title: 'The runtime stopped while starting.',
      body: 'It exited before it was ready, so there is nothing to open yet. The logs have its last output. Quit and reopen Isagi to try again.',
    },
    exited_after_ready: {
      title: 'The runtime stopped.',
      body: 'It was running, then exited while Isagi was open. The logs have its last output. Quit and reopen Isagi to start it again.',
    },
    page_load_failed: {
      title: "The workspace page didn't load.",
      body: "The runtime is running, but this window couldn't load its page. The logs may say why. Quit and reopen Isagi to try again.",
    },
  },
};

// Every failure reason the main process can send, onto the copy above. Unknown reasons read as "couldn't be started".
const failureCopyKey = {
  launch_configuration_invalid: 'not_started',
  stage_invalid: 'not_started',
  spawn_failed: 'not_started',
  readiness_malformed: 'not_started',
  readiness_timeout: 'readiness_timeout',
  health_check_failed: 'readiness_timeout',
  exited_before_ready: 'exited_before_ready',
  process_error: 'exited_before_ready',
  exited_after_ready: 'exited_after_ready',
  page_load_failed: 'page_load_failed',
};

/** How long `starting` waits before it says it is still starting; the readiness timeout is 15 s. */
const slowAfterMs = 8000;

const params = new URLSearchParams(location.search);
const pick = (key, allowed) => (allowed.includes(params.get(key)) ? params.get(key) : allowed[0]);
const theme = pick('theme', ['dark', 'light']);
const state = pick('state', ['starting', 'slow', 'failed']);
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.state = state;

const column = document.getElementById('column');
const track = document.getElementById('track');
const below = document.getElementById('below');
const whisper = document.getElementById('whisper');
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

if (state === 'failed') {
  const reason = params.get('reason') ?? '';
  const text = copy.failed[failureCopyKey[reason] ?? 'not_started'];
  column.dataset.compact = '';
  column.dataset.wide = '';
  column.dataset.reason = reason;
  track.remove();
  const detail = el('div', 'detail');
  detail.append(el('h1', 'title', text.title), el('p', 'body', text.body));
  const lines = [];
  if (params.get('message')) lines.push(params.get('message'));
  if (params.get('exitCode')) lines.push(`exit code ${params.get('exitCode')}`);
  if (params.get('signal')) lines.push(`signal ${params.get('signal')}`);
  if (lines.length > 0) detail.append(el('p', 'chip', lines.join('\n')));
  const actions = el('div', 'actions');
  for (const [variant, label, action] of [
    ['primary', copy.openLogs, 'openLogs'],
    ['secondary', copy.quit, 'quit'],
  ]) {
    const button = el('button', 'button', label);
    button.type = 'button';
    button.dataset.variant = variant;
    button.dataset.action = action;
    button.addEventListener('click', () => void window.isagiLoader?.[action]?.());
    actions.append(button);
  }
  detail.append(actions);
  below.append(detail);
} else {
  // Same fill as the web `connecting` beat: the runtime is not reachable yet.
  const fill = document.getElementById('fill');
  fill.style.width = '17%';
  const clip = el('span', 'ray-clip');
  clip.append(el('span', 'ray'));
  fill.append(clip, el('span', 'tip'));
  const status = el('div', 'status');
  const line = el('p', null, copy[state].status);
  status.append(line);
  below.append(status);
  whisper.textContent = copy.whisper;
  whisper.hidden = false;
  if (state === 'starting') {
    setTimeout(() => {
      line.textContent = copy.slow.status;
      document.documentElement.dataset.state = 'slow';
    }, slowAfterMs);
  }
}
