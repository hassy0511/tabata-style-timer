'use strict';

// ===== 設定項目 =====
const FIELDS = [
  { key: 'prep',    label: '準備時間',     type: 'time',  min: 0, max: 60,  step: 1, def: 5 },
  { key: 'work',    label: '運動時間',     type: 'time',  min: 5, max: 600, step: 5, def: 20 },
  { key: 'rest',    label: '休憩時間',     sub: 'ラウンド間', type: 'time', min: 0, max: 600, step: 5, def: 10 },
  { key: 'rounds',  label: 'ラウンド数',   type: 'count', unit: '回',   min: 1, max: 50, step: 1, def: 8 },
  { key: 'sets',    label: 'セット数',     type: 'count', unit: 'セット', min: 1, max: 20, step: 1, def: 1 },
  { key: 'setRest', label: 'セット間休憩', type: 'time',  min: 0, max: 600, step: 5, def: 60 },
];

const PHASE_LABEL = { prep: '準備', work: '運動', rest: '休憩', setRest: 'セット間休憩', done: '完了！' };
const STORAGE_KEY = 'tabata-settings-v1';

// ===== ユーティリティ =====
const $ = (id) => document.getElementById(id);

function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function loadSettings() {
  const s = {};
  FIELDS.forEach((f) => { s[f.key] = f.def; });
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    FIELDS.forEach((f) => {
      const v = saved[f.key];
      if (Number.isFinite(v)) s[f.key] = Math.min(f.max, Math.max(f.min, v));
    });
  } catch (e) { /* 保存領域が使えなくても既定値で動かす */ }
  return s;
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* noop */ }
}

let settings = loadSettings();

// ===== タイムライン生成 =====
function buildSegments(s) {
  const segs = [];
  if (s.prep > 0) segs.push({ type: 'prep', dur: s.prep, set: 1, round: 1 });
  for (let set = 1; set <= s.sets; set++) {
    for (let r = 1; r <= s.rounds; r++) {
      segs.push({ type: 'work', dur: s.work, set, round: r });
      if (r < s.rounds && s.rest > 0) segs.push({ type: 'rest', dur: s.rest, set, round: r });
    }
    if (set < s.sets && s.setRest > 0) segs.push({ type: 'setRest', dur: s.setRest, set, round: s.rounds });
  }
  let t = 0;
  segs.forEach((seg) => { seg.start = t; t += seg.dur; seg.end = t; });
  return { segs, total: t };
}

// ===== 音（Web Audio）=====
// 'ambient' にすると音楽アプリを止めずに上から重ねて鳴らせる（iOS 17+ の Safari）。
function setAudioSessionType() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch (e) { /* noop */ }
}
setAudioSessionType();

let ctx = null;
let master = null;
// iOS は画面ロック等で音声出力を切り、復帰後も同じ AudioContext では鳴らないことがある。
// そのため一度バックグラウンドに回ったら「要作り直し」とし、次のタップで新しく作る。
let audioStale = false;

function audioOK() {
  return !!ctx && ctx.state === 'running' && !audioStale;
}

// ユーザーのタップ（click / touchend）の中で呼ぶこと
function ensureAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (ctx && (audioStale || ctx.state === 'interrupted' || ctx.state === 'closed')) {
    try { ctx.close(); } catch (e) { /* noop */ }
    ctx = null;
  }
  audioStale = false;
  setAudioSessionType();
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  }
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  // 無音を一瞬鳴らして iOS の音声出力を確実に有効化する
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch (e) { /* noop */ }
  updateAudioOverlay();
}

function tone(freq, dur, when = 0, vol = 0.8) {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.setValueAtTime(vol, t + dur - 0.04);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

const SOUND = {
  count:   () => tone(880, 0.12),                                   // 5・4・3・2・1 のピッ
  prep:    () => tone(880, 0.12),
  work:    () => tone(1320, 0.6),                                   // 高いピー：運動開始
  rest:    () => tone(660, 0.6),                                    // 低いピー：休憩開始
  setRest: () => { tone(660, 0.25); tone(660, 0.5, 0.35); },        // ピッ・ピー：セット間休憩
  done:    () => { tone(1320, 0.2); tone(1320, 0.2, 0.3); tone(1760, 0.8, 0.6); },
};

// ===== 画面スリープ防止 =====
// Wake Lock API に加え、効かない環境向けに無音の動画をループ再生して自動ロックを防ぐ。
let wakeLock = null;
const keepAwakeVideo = $('keepAwake');
keepAwakeVideo.muted = true;

async function requestWake() {
  try {
    const p = keepAwakeVideo.play();
    if (p) p.catch(() => {});
  } catch (e) { /* noop */ }
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* 非対応・拒否時は動画側に任せる */ }
}
function releaseWake() {
  try { keepAwakeVideo.pause(); } catch (e) { /* noop */ }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// ===== 設定画面 =====
function renderFields() {
  const box = $('fields');
  box.innerHTML = '';
  FIELDS.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'field';
    row.dataset.key = f.key;
    row.innerHTML = `
      <div class="label">${f.label}${f.sub ? `<small>${f.sub}</small>` : ''}</div>
      <button class="step" data-d="-1" aria-label="${f.label}を減らす">−</button>
      <div class="value"></div>
      <button class="step" data-d="1" aria-label="${f.label}を増やす">+</button>`;
    row.querySelectorAll('.step').forEach((btn) => attachRepeat(btn, () => change(f, Number(btn.dataset.d))));
    box.appendChild(row);
  });
  updateFields();
}

function valueHTML(f) {
  const v = settings[f.key];
  if (f.type === 'time') return v < 60 ? `${v}<small>秒</small>` : fmt(v);
  return `${v}<small>${f.unit}</small>`;
}

function updateFields() {
  FIELDS.forEach((f) => {
    const row = document.querySelector(`.field[data-key="${f.key}"]`);
    row.querySelector('.value').innerHTML = valueHTML(f);
    if (f.key === 'setRest') row.classList.toggle('disabled', settings.sets <= 1);
  });
  $('total').textContent = fmt(buildSegments(settings).total);
}

function change(f, dir) {
  const v = Math.min(f.max, Math.max(f.min, settings[f.key] + dir * f.step));
  if (v === settings[f.key]) return;
  settings[f.key] = v;
  updateFields();
  saveSettings();
}

// 長押しで連続変更
function attachRepeat(btn, fn) {
  let timer = null;
  let delay = null;
  const stop = () => { clearTimeout(delay); clearInterval(timer); delay = timer = null; };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stop();
    fn();
    delay = setTimeout(() => { timer = setInterval(fn, 80); }, 400);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ===== タイマー本体 =====
const state = {
  segs: [], total: 0,
  running: false,   // 時間が進んでいるか
  active: false,    // 実行画面にいるか
  finished: false,
  startedAt: 0,     // 再開時刻 (ms)
  accumulated: 0,   // 一時停止までの経過 (ms)
  prevE: 0,         // 前回 tick 時の経過 (s)
  loop: null,
};

function elapsedSec() {
  const ms = state.accumulated + (state.running ? Date.now() - state.startedAt : 0);
  return ms / 1000;
}

function segIndexAt(e) {
  const segs = state.segs;
  for (let i = 0; i < segs.length; i++) if (e < segs[i].end) return i;
  return segs.length; // 終了
}

function start() {
  ensureAudio();
  const { segs, total } = buildSegments(settings);
  Object.assign(state, {
    segs, total, running: true, active: true, finished: false,
    startedAt: Date.now(), accumulated: 0, prevE: 0,
  });
  $('setup').hidden = true;
  $('run').hidden = false;
  $('pause').hidden = false;
  $('pause').textContent = '一時停止';
  $('stop').textContent = '終了';
  document.body.classList.remove('paused');
  requestWake();
  SOUND[segs[0].type]();
  render(0);
  clearInterval(state.loop);
  state.loop = setInterval(tick, 50);
}

function tick() {
  if (!state.running) return;
  updateAudioOverlay();
  const e = elapsedSec();
  const prev = state.prevE;
  state.prevE = e;

  // バックグラウンドから戻った等で大きく飛んだ場合は鳴らし直さない
  const fresh = e - prev < 1;

  if (e >= state.total) {
    if (fresh) SOUND.done();
    finish();
    return;
  }

  if (fresh) {
    const i = segIndexAt(e);
    const seg = state.segs[i];
    if (seg.start > prev && seg.start <= e) {
      SOUND[seg.type]();           // 区間の切り替わり
    } else {
      for (const m of [5, 4, 3, 2, 1]) {  // 切り替わり5秒前からのカウント
        const t = seg.end - m;
        if (m < seg.dur && t > prev && t <= e) { SOUND.count(); break; }
      }
    }
  }
  render(e);
}

function render(e) {
  const i = segIndexAt(e);
  const seg = state.segs[i];
  const s = settings;
  document.body.className = seg.type + (state.running ? '' : ' paused');
  $('phase').textContent = PHASE_LABEL[seg.type];
  const remainSeg = Math.ceil(seg.end - e - 1e-6);
  $('time').textContent = remainSeg >= 60 ? fmt(remainSeg) : String(remainSeg);

  $('setInfo').textContent = `セット ${seg.set}/${s.sets}`;
  $('roundInfo').textContent = `ラウンド ${seg.round}/${s.rounds}`;

  const nxt = state.segs[i + 1];
  $('next').textContent = nxt ? `次：${PHASE_LABEL[nxt.type]} ${nxt.dur}秒` : '次：完了';
  $('bar').style.width = `${(e / state.total) * 100}%`;
  $('remainTotal').textContent = fmt(Math.ceil(state.total - e - 1e-6));
}

function togglePause() {
  if (state.finished) return;
  ensureAudio();
  if (state.running) {
    state.accumulated += Date.now() - state.startedAt;
    state.running = false;
    $('pause').textContent = '再開';
  } else {
    state.startedAt = Date.now();
    state.running = true;
    state.prevE = elapsedSec();
    $('pause').textContent = '一時停止';
  }
  render(elapsedSec());
}

function finish() {
  state.running = false;
  state.finished = true;
  clearInterval(state.loop);
  document.body.className = 'done';
  $('phase').textContent = PHASE_LABEL.done;
  $('time').textContent = fmt(state.total);
  $('next').textContent = 'おつかれさまでした';
  $('bar').style.width = '100%';
  $('remainTotal').textContent = '0:00';
  $('pause').hidden = true;
  $('stop').textContent = '戻る';
  releaseWake();
}

function backToSetup() {
  state.running = false;
  state.active = false;
  clearInterval(state.loop);
  releaseWake();
  document.body.className = '';
  $('run').hidden = true;
  $('setup').hidden = false;
}

function onStop() {
  if (state.finished || confirm('タイマーを終了しますか？')) backToSetup();
}

// ===== イベント =====
$('start').addEventListener('click', start);
$('soundTest').addEventListener('click', () => {
  ensureAudio();
  // 解除直後は running になるまで少し待つ
  setTimeout(() => { SOUND.count(); setTimeout(SOUND.work, 400); setTimeout(SOUND.rest, 1200); }, 100);
});
$('pause').addEventListener('click', togglePause);
$('stop').addEventListener('click', onStop);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // ロック・アプリ切り替え後は音声が死んでいることがあるので作り直し対象にする
    if (ctx) audioStale = true;
  } else {
    if (state.active && !state.finished) requestWake();
    updateAudioOverlay();
    if (state.running) tick();
  }
});

// 音が止まっているときの「タップで再開」表示
function updateAudioOverlay() {
  const show = state.active && !state.finished && !audioOK();
  $('audioOverlay').hidden = !show;
}
$('audioOverlay').addEventListener('click', () => { ensureAudio(); });

// 画面のどこかをタップしたときも、音が止まっていれば復帰させる
// （iOS は touchstart / pointerdown では音声を有効化できないため touchend / click で行う）
['touchend', 'click'].forEach((ev) => document.addEventListener(ev, () => {
  if (ctx && !audioOK()) ensureAudio();
}, true));

renderFields();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
