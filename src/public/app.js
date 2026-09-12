const $ = (id) => document.getElementById(id);
const overlay = location.pathname === '/overlay';
document.body.classList.toggle('overlay', overlay);
const canvas = $('canvas'), ctx = canvas.getContext('2d');
const toolNames = { paint: '路径绘画', brush: '笔刷', line: '直线', rect: '矩形', ellipse: '椭圆', polygon: '多边形', bezier: '贝塞尔曲线', curve: '平滑曲线', fill: '填充', spray: '喷漆' };
let state = { board: null, references: [], queued: 0, cursor: { x: 0, y: 0, mode: 'idle' } };
let boardKey = '', referenceKey = '', stepKey = '', drawing = null, paintVersion = 0;
let pendingFiles = [];
let uploading = false;

function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
async function api(path, body, method = 'POST') {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}
async function command(name, args = {}) {
  try {
    const result = await api('/api/command', { name, args });
    render(result.state);
    return result.result;
  } catch (error) { message(error.message, true); throw error; }
}
function paint(url) {
  const version = ++paintVersion;
  const image = new Image();
  image.onload = () => { if (version === paintVersion) { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0); } };
  image.src = url;
}
function resize() {
  if (!state.board) return;
  const stage = document.querySelector('.stage');
  const scale = Math.min((stage.clientWidth - 52) / state.board.width, (stage.clientHeight - 52) / state.board.height, 1);
  $('board-wrap').style.width = `${Math.max(1, state.board.width * scale)}px`;
  $('board-wrap').style.height = `${Math.max(1, state.board.height * scale)}px`;
  cursor(state.cursor);
}
function cursor(value) {
  state.cursor = value;
  const node = $('corti-cursor');
  node.hidden = !state.board;
  if (!state.board) return;
  node.dataset.mode = value.mode;
  node.classList.toggle('edge-right', value.x / state.board.width * $('board-wrap').clientWidth > $('board-wrap').clientWidth - 70);
  node.classList.toggle('edge-bottom', value.y / state.board.height * $('board-wrap').clientHeight > $('board-wrap').clientHeight - 80);
  node.style.transform = `translate(${value.x / state.board.width * $('board-wrap').clientWidth}px, ${value.y / state.board.height * $('board-wrap').clientHeight}px)`;
}
function render(next) {
  const hadPreview = !!state.preview;
  state = next;
  const board = state.board;
  $('board-title').textContent = board?.title || '画布';
  $('board-meta').textContent = board ? `${board.width} × ${board.height} px · 已自动存档` : '尚未新建画布';
  $('save').disabled = !board || state.queued > 0;
  $('empty-board').hidden = !!board;
  $('board-wrap').hidden = !board;
  if (board) {
    const key = `${board.id}:${board.revision}`;
    if (key !== boardKey || (hadPreview && !state.preview)) {
      boardKey = key; canvas.width = board.width; canvas.height = board.height;
      paint(`/api/canvas.png?v=${encodeURIComponent(key)}`);
    }
    resize();
  }
  if (state.preview) paint(`data:image/png;base64,${state.preview}`);
  cursor(state.cursor);
  progress(state.painting, state.queued);
  renderReferences(); renderSteps(); renderGame(state.game);
}
function progress(painting, queued) {
  $('progress').classList.toggle('active', !!painting || queued > 0);
  $('progress').textContent = painting ? `可缇正在绘制 ${painting.step} / ${painting.total} · ${painting.label}` : queued > 0 ? `队列处理中 · ${queued} 项` : state.board ? '已完成' : '就绪';
}
function renderReferences() {
  const refs = state.references;
  $('reference-count').textContent = `${refs.length} / 64`;
  const key = JSON.stringify(refs);
  if (key === referenceKey) return;
  referenceKey = key;
  $('references').replaceChildren(...refs.map((ref, index) => {
    const card = document.createElement('article'); card.className = 'reference-card';
    const img = document.createElement('img'); img.src = ref.url; img.alt = ref.name; img.className = 'thumb'; img.tabIndex = 0;
    const open = () => { $('reference-title').textContent = ref.name; $('reference-image').src = ref.url; $('reference-dialog').showModal(); };
    img.onclick = open; img.onkeydown = (event) => { if (event.key === 'Enter') open(); };
    const info = document.createElement('div'); info.className = 'reference-info';
    const name = document.createElement('div'); name.className = 'ref-name'; name.textContent = `${String(index + 1).padStart(2, '0')} · ${ref.name}`;
    const meta = document.createElement('small'); meta.textContent = `${ref.width} × ${ref.height} px`;
    const input = document.createElement('input'); input.value = ref.name; input.maxLength = 120; input.setAttribute('aria-label', '参考图名称'); input.className = 'operator';
    const actions = document.createElement('div'); actions.className = 'ref-actions operator';
    const rename = document.createElement('button'); rename.textContent = '重命名'; rename.className = 'secondary';
    rename.onclick = () => api(`/api/references/${ref.id}`, { name: input.value }, 'PATCH').catch((error) => message(error.message, true));
    const remove = document.createElement('button'); remove.textContent = '移出队列'; remove.className = 'secondary';
    remove.onclick = () => api(`/api/references/${ref.id}`, {}, 'DELETE').catch((error) => message(error.message, true));
    actions.append(rename, remove); info.append(name, meta, input, actions); card.append(img, info); return card;
  }));
}
function renderSteps() {
  const steps = state.board?.steps || [];
  $('step-count').textContent = `${steps.length} 步`; $('step-empty').hidden = steps.length > 0;
  const key = `${state.board?.id}:${state.board?.revision}`;
  if (key === stepKey) return;
  stepKey = key;
  $('steps').replaceChildren(...steps.map((step, index) => {
    const li = document.createElement('li'); li.className = 'step';
    const top = document.createElement('div'); top.className = 'step-top';
    const title = document.createElement('strong'); title.textContent = `${String(index + 1).padStart(2, '0')}  ${step.action.label}`;
    const undo = document.createElement('button'); undo.className = 'secondary operator'; undo.textContent = '撤销'; undo.title = `仅撤销 ${step.id}`;
    undo.onclick = () => command('canvas_undo', { step_id: step.id }).catch(() => {});
    top.append(title, undo);
    const meta = document.createElement('small'); meta.textContent = `${toolNames[step.action.kind]} · ${step.action.color}`;
    const id = document.createElement('code'); id.textContent = step.id;
    li.append(top, meta, id); return li;
  }));
  $('steps').lastElementChild?.scrollIntoView({ block: 'nearest' });
}
function addFiles(files) {
  for (const file of files) {
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 10 * 1024 * 1024) { message(`${file.name}：请选择 10 MiB 以内的 PNG/JPG`, true); continue; }
    if (state.references.length + pendingFiles.length >= 64) { message('参考图队列最多 64 张', true); break; }
    pendingFiles.push({ file, name: file.name.replace(/\.[^.]+$/, '').slice(0, 120), preview: URL.createObjectURL(file) });
  }
  renderPending();
}
function renderPending() {
  $('pending').replaceChildren();
  pendingFiles.forEach((item) => {
    const row = document.createElement('div'); row.className = 'pending-row';
    const img = document.createElement('img'); img.src = item.preview; img.alt = '待上传参考图';
    const input = document.createElement('input'); input.value = item.name; input.maxLength = 120; input.setAttribute('aria-label', '上传前命名'); input.oninput = () => { item.name = input.value; };
    input.disabled = uploading;
    row.append(img, input); $('pending').append(row);
  });
  if (!pendingFiles.length) return;
  const upload = document.createElement('button'); upload.textContent = `上传 ${pendingFiles.length} 张参考图`;
  upload.disabled = uploading;
  upload.onclick = async () => {
    const batch = [...pendingFiles];
    uploading = true; renderPending();
    try {
      for (const item of batch) {
        const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(item.file); });
        await api('/api/references', { name: item.name, base64 });
        URL.revokeObjectURL(item.preview); pendingFiles.shift();
      }
      message('参考图已上传');
    } catch (error) { message(error.message, true); }
    uploading = false; renderPending();
  };
  const clear = document.createElement('button'); clear.textContent = '取消待上传'; clear.className = 'secondary'; clear.onclick = () => { for (const item of pendingFiles) URL.revokeObjectURL(item.preview); pendingFiles = []; renderPending(); };
  clear.disabled = uploading;
  $('pending').append(upload, clear);
}
$('files').onchange = (event) => { addFiles(event.target.files); event.target.value = ''; };
$('dropzone').ondragover = (event) => { event.preventDefault(); $('dropzone').classList.add('drag'); };
$('dropzone').ondragleave = () => $('dropzone').classList.remove('drag');
$('dropzone').ondrop = (event) => { event.preventDefault(); $('dropzone').classList.remove('drag'); addFiles(event.dataTransfer.files); };
document.addEventListener('paste', (event) => {
  if (overlay) return;
  const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
  if (!images.length) return;
  event.preventDefault();
  addFiles(images);
});
$('new').onclick = () => $('new-dialog').showModal();
$('cancel-new').onclick = () => $('new-dialog').close();
$('new-form').onsubmit = async (event) => {
  event.preventDefault();
  const submit = event.submitter; submit.disabled = true;
  try { await command('canvas_new', { title: $('title').value, width: +$('width').value, height: +$('height').value, background: $('background').value }); $('new-dialog').close(); }
  catch {} finally { submit.disabled = false; }
};
$('save').onclick = async () => {
  try { const saved = await command('canvas_save'); const a = document.createElement('a'); a.href = saved.url; a.download = saved.filename; a.click(); message(`已保存：${saved.path}`); } catch {}
};
$('close-reference').onclick = () => $('reference-dialog').close();
$('size').oninput = () => { $('size-value').value = $('size').value; };
function point(event) { const rect = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(canvas.width - 1, (event.clientX - rect.left) / rect.width * canvas.width)), y: Math.max(0, Math.min(canvas.height - 1, (event.clientY - rect.top) / rect.height * canvas.height)) }; }
canvas.onpointerdown = (event) => {
  if (overlay || !state.board || state.queued || event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId); drawing = [point(event)];
};
canvas.onpointermove = (event) => {
  const p = point(event); $('coordinates').textContent = `(${Math.round(p.x)}, ${Math.round(p.y)})`;
  if (drawing && drawing.length < 1024 && Math.hypot(p.x - drawing.at(-1).x, p.y - drawing.at(-1).y) > 2) drawing.push(p);
};
canvas.onpointerup = (event) => {
  if (!drawing) return;
  const points = drawing; drawing = null;
  const tool = $('brush').value, isBrush = ['pen', 'marker', 'soft', 'eraser'].includes(tool);
  const selected = tool === 'fill' ? [points[0]] : ['rect', 'ellipse', 'line'].includes(tool) ? [points[0], point(event)] : [...points.slice(0, 1023), point(event)];
  void command('canvas_draw', { actions: [{ kind: isBrush ? 'brush' : tool, brush: isBrush ? tool : 'pen', points: selected, color: $('color').value, size: +$('size').value, opacity: +$('opacity').value / 100, filled: $('filled').checked, label: `手绘 · ${$('brush').selectedOptions[0].text}` }] }).catch(() => {});
};
canvas.onpointercancel = () => { drawing = null; };
new ResizeObserver(resize).observe(document.querySelector('.stage'));
const events = new EventSource('/events');
events.onopen = () => { $('connection').textContent = '画室在线'; $('connection').classList.add('online'); };
events.onerror = () => { $('connection').textContent = '连接中断 · 正在重连'; $('connection').classList.remove('online'); };
events.onmessage = (event) => {
  const packet = JSON.parse(event.data);
  if (packet.type === 'state') render(packet.data);
  if (packet.type === 'frame') { state.preview = packet.data.png; state.painting = packet.data; cursor(packet.data.cursor); progress(packet.data, state.queued); paint(`data:image/png;base64,${packet.data.png}`); }
};

// ---- 你画我猜:计分板、倒计时与揭示都是服务端状态的投影,页面只负责动画 ----
const ARC = 2 * Math.PI * 52;
let clockOffset = 0, rankKey = '', timerKey = '', revealKey = '', revealHide = null, timerVisible = false, timerRound = null;
const formatClock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function renderGame(game) {
  if (!game) return;
  clockOffset = game.now - Date.now();
  const playing = game.mode === 'guess';
  document.body.classList.toggle('game', playing);
  $('brand-title').textContent = playing ? '可缇的你画我猜' : 'Corti 的头像画室';
  $('game-badge').hidden = !playing;
  $('game-round').textContent = game.round ? game.round.id : game.rounds;
  renderRanks(playing ? game.scoreboard : []);
  renderTimer(playing ? game.round : null);
  renderReveal(playing ? game.reveal : null);
}
function renderRanks(list) {
  const top = list.slice(0, 10);
  const key = JSON.stringify(top);
  if (key === rankKey) return;
  rankKey = key;
  const ol = $('ranks');
  const before = new Map(Array.from(ol.children, (li) => [li.dataset.name, { top: li.getBoundingClientRect().top, score: +li.dataset.score }]));
  $('score-count').textContent = list.length ? `${list.length} 人参与` : '';
  $('rank-empty').hidden = top.length > 0;
  ol.replaceChildren(...top.map((entry) => {
    const li = document.createElement('li'); li.className = `rank-row rank-${Math.min(entry.rank, 4)}`; li.dataset.name = entry.name; li.dataset.score = entry.score;
    const badge = document.createElement('span'); badge.className = 'rank-badge'; badge.textContent = entry.rank;
    const name = document.createElement('span'); name.className = 'rank-name'; name.textContent = entry.name; name.title = entry.name;
    const score = document.createElement('span'); score.className = 'rank-score'; score.textContent = entry.score;
    li.append(badge, name, score); return li;
  }));
  for (const li of ol.children) {
    const prev = before.get(li.dataset.name);
    if (!prev) { li.classList.add('enter'); continue; }
    const dy = prev.top - li.getBoundingClientRect().top;
    if (dy) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 550, easing: 'cubic-bezier(.2,.9,.25,1.15)' });
    const delta = +li.dataset.score - prev.score;
    if (!delta) continue;
    li.querySelector('.rank-score').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.5)' }, { transform: 'scale(1)' }], { duration: 600, easing: 'ease-out' });
    const chip = document.createElement('i'); chip.className = 'delta'; chip.textContent = `${delta > 0 ? '+' : ''}${delta}`;
    li.append(chip); setTimeout(() => chip.remove(), 1200);
  }
}
function renderTimer(round) {
  const node = $('timer');
  timerRound = round;
  if (!round) {
    if (!timerVisible) return;
    timerVisible = false;
    node.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.6)', opacity: 0 }], { duration: 250, easing: 'ease-in' }).onfinish = () => { if (!timerVisible) node.hidden = true; };
    return;
  }
  if (!timerVisible) { timerVisible = true; node.hidden = false; node.classList.remove('pop'); void node.offsetWidth; node.classList.add('pop'); }
  const key = `${round.id}:${round.length}:${round.hint}`;
  if (key !== timerKey) {
    timerKey = key;
    $('timer-blanks').replaceChildren(...Array.from({ length: Math.min(round.length, 20) }, () => { const blank = document.createElement('span'); blank.className = 'blank'; blank.textContent = '？'; return blank; }));
    $('timer-hint').hidden = !round.hint; $('timer-hint').textContent = round.hint ? `提示 · ${round.hint}` : '';
  }
  tickTimer();
}
function tickTimer() {
  const round = timerRound;
  if (!round || !timerVisible) return;
  const remaining = round.endsAt - (Date.now() + clockOffset);
  const over = round.expired || remaining <= 0;
  const fraction = over ? 0 : Math.min(1, remaining / (round.endsAt - round.startedAt));
  $('timer-arc').style.strokeDashoffset = ARC * (1 - fraction);
  $('timer-clock').textContent = over ? '0:00' : formatClock(remaining);
  $('timer').classList.toggle('urgent', !over && remaining <= 10000);
  $('timer').classList.toggle('over', over);
  $('timer-label').textContent = over ? '时间到！等可缇揭晓答案～' : '猜猜我在画什么？';
}
setInterval(tickTimer, 200);
function renderReveal(reveal) {
  const node = $('reveal');
  const key = reveal ? `${reveal.roundId}:${reveal.at}` : '';
  if (key === revealKey) return;
  revealKey = key;
  clearTimeout(revealHide);
  const age = reveal ? Date.now() + clockOffset - reveal.at : 0;
  if (!reveal || age > 25000) { node.hidden = true; return; }
  const letters = Array.from(reveal.answer);
  const columns = (limit) => Math.ceil(letters.length / Math.ceil(letters.length / limit));
  $('reveal-answer').style.setProperty('--wide-columns', columns(10));
  $('reveal-answer').style.setProperty('--narrow-columns', columns(5));
  $('reveal-answer').replaceChildren(...letters.map((char, index) => { const span = document.createElement('span'); span.textContent = char; span.style.setProperty('--i', index); return span; }));
  $('reveal-winners').replaceChildren(...reveal.winners.map((name, index) => { const li = document.createElement('li'); li.textContent = `${index + 1}. ${name}`; li.style.setProperty('--i', index); return li; }));
  const colors = ['#dfa0b6', '#e7c478', '#91b6d1', '#a4bea5', '#b7a4cf'];
  $('confetti').replaceChildren(...Array.from({ length: 48 }, () => {
    const piece = document.createElement('i');
    piece.style.setProperty('--x', Math.random() * 100); piece.style.setProperty('--d', `${2.5 + Math.random() * 2.5}s`); piece.style.setProperty('--w', `${Math.random() * 1.2}s`);
    piece.style.setProperty('--r', `${Math.random() * 360}deg`); piece.style.setProperty('--c', colors[Math.floor(Math.random() * colors.length)]);
    return piece;
  }));
  node.hidden = false;
  node.classList.remove('pop'); void node.offsetWidth; node.classList.add('pop');
  revealHide = setTimeout(() => { node.hidden = true; }, 25000 - age);
}
