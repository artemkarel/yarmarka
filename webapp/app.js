/* Ярмарка — мини-приложение Telegram */
'use strict';

const tg = window.Telegram && window.Telegram.WebApp;
const qsp = new URLSearchParams(location.search);
const DEV = qsp.get('dev');

let ME = null;
let SETTINGS = { share_pct: 50, commission_pct: 2 };
let PRODUCTS_CACHE = null;

// ===== утилиты =====
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const NF2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const NF3 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
function fmtM(x) { return NF2.format(Math.round((+x || 0) * 100) / 100) + ' ₽'; }
function fmtQ(q, unit) { return NF3.format(Math.round((+q || 0) * 1000) / 1000) + (unit ? ' ' + unit : ''); }
function pnum(v) {
  v = String(v == null ? '' : v).trim().replace(',', '.');
  if (v === '') return 0;
  const x = parseFloat(v);
  return isNaN(x) ? 0 : x;
}
function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
function today() { return isoDate(new Date()); }
function daysAgo(n) { return isoDate(new Date(Date.now() - n * 864e5)); }
function dstr(d) { return d ? d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(2, 4) : ''; }

function toast(msg, ok) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = ok ? 'ok' : '';
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, 2600);
}

function confirmDlg(msg) {
  return new Promise(res => {
    if (tg && tg.showConfirm) tg.showConfirm(msg, ok => res(ok));
    else res(window.confirm(msg));
  });
}

async function api(path, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (DEV) headers['X-Dev-User'] = DEV;
  else headers['X-Tg-Init-Data'] = (tg && tg.initData) || '';
  const r = await fetch(path, {
    method: method || 'GET', headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* пустой ответ */ }
  if (!r.ok) {
    if (j.need_registration || (j.detail && j.detail.need_registration)) {
      const err = new Error('registration');
      err.needReg = true;
      throw err;
    }
    throw new Error(j.error || (j.detail && j.detail.error) || 'Ошибка сервера');
  }
  return j;
}

async function getProducts(force) {
  if (!PRODUCTS_CACHE || force) PRODUCTS_CACHE = (await api('/api/products?all=1')).products;
  return PRODUCTS_CACHE;
}

// ===== навигация =====
let stack = [];
function render() {
  const top = stack[stack.length - 1];
  top.fn.apply(null, top.args);
  if (tg) { if (stack.length > 1) tg.BackButton.show(); else tg.BackButton.hide(); }
}
function push(fn) {
  stack.push({ fn, args: Array.prototype.slice.call(arguments, 1) });
  render();
}
function back() { if (stack.length > 1) { stack.pop(); render(); } }
window.back = back;
if (tg) tg.BackButton.onClick(back);

function setTab(fn, idx) {
  stack = [{ fn, args: [] }];
  render();
  document.querySelectorAll('#nav button').forEach((b, i) => b.classList.toggle('on', i === idx));
}

function screen(title, html, sub) {
  const el = document.getElementById('screen');
  const head = sub
    ? '<div class="subhead"><button class="backbtn" onclick="back()">‹</button>' +
      '<div class="subtitle">' + esc(title) + '</div></div>'
    : (title ? '<div class="pagetitle">' + esc(title) + '</div>' : '');
  el.innerHTML = head + html;
  window.scrollTo(0, 0);
  return el;
}

function buildNav() {
  let items;
  if (ME.role === 'seller') {
    items = [['🏠', 'Главная', S_home], ['📦', 'Склад', S_skladView],
             ['📍', 'Точки', S_places], ['📊', 'Аналитика', S_turnover],
             ['⋯', 'Ещё', S_more]];
  } else if (ME.role === 'keeper') {
    items = [['📦', 'Склад', S_sklad], ['👥', 'Продавцы', S_sellers],
             ['📊', 'Аналитика', S_analytics], ['⋯', 'Ещё', S_more]];
  } else {
    items = [['📦', 'Склад', S_sklad], ['👥', 'Продавцы', S_sellers], ['📍', 'Точки', S_places],
             ['📊', 'Аналитика', S_analytics], ['⋯', 'Ещё', S_more]];
  }
  const nav = document.getElementById('nav');
  nav.innerHTML = items.map(it =>
    '<button><span class="ico">' + it[0] + '</span>' + it[1] + '</button>').join('');
  nav.hidden = false;
  nav.querySelectorAll('button').forEach((b, i) => {
    b.onclick = () => setTab(items[i][2], i);
  });
  setTab(items[0][2], 0);
}

// ===== общие блоки =====
function balanceHtml(b, self) {
  let big, cls;
  if (b.balance > 0.005) { big = (self ? 'Ты должен' : 'Должен нам'); cls = 'red'; }
  else if (b.balance < -0.005) { big = (self ? 'Тебе должны' : 'Мы должны ему'); cls = 'green'; }
  else { big = 'Расчёт закрыт'; cls = ''; }
  const row = (l, v) => '<div class="row"><div class="l hint">' + l +
    '</div><div class="r val">' + v + '</div></div>';
  return '<div class="card">' +
    '<div class="biglabel">' + big + '</div>' +
    '<div class="bignum ' + cls + '">' + fmtM(Math.abs(b.balance)) + '</div>' +
    '<div style="margin-top:10px">' +
    row('Взял товара на', fmtM(b.taken_value)) +
    row('Продал на', fmtM(b.sold_value)) +
    row('Начислено (' + SETTINGS.share_pct + '%)', '+ ' + fmtM(b.charged)) +
    row('Возврат товара', '− ' + fmtM(b.returned_credit)) +
    row('Терминал (пробито ' + fmtM(b.terminal_raw) + ')', '− ' + fmtM(b.terminal_credit)) +
    row('Наличными', (b.cash_total >= 0 ? '− ' + fmtM(b.cash_total) : '+ ' + fmtM(-b.cash_total))) +
    '</div></div>';
}

function stockListHtml(items, title) {
  if (!items.length) return '';
  let total = 0;
  const rows = items.map(it => {
    total += it.value;
    return '<div class="row"><div class="l"><div class="name">' + esc(it.name) + '</div>' +
      '<div class="sub">' + fmtQ(it.qty, it.unit) + ' × ' + fmtM(it.retail_price) + '</div></div>' +
      '<div class="r val">' + fmtM(it.value) + '</div></div>';
  }).join('');
  return '<div class="card"><h3>' + title + '</h3>' + rows +
    '<div class="row total"><div class="l">Итого</div><div class="r">' + fmtM(total) +
    '</div></div></div>';
}

const DOC_META = {
  prihod: ['📦', 'Приход'], initial: ['📋', 'Нач. остатки'], inventory: ['🔍', 'Инвентаризация'],
  vydacha: ['🚚', 'Выдача'], sdacha: ['↩️', 'Сдача'], incass: ['💳', 'Инкассация'],
  cash: ['💵', 'Наличные'],
};

function docCard(d, showSeller) {
  const meta = DOC_META[d.type] || ['📄', d.type];
  let sum = '';
  if (d.type === 'prihod') sum = 'на ' + fmtM(d.amount) + ' по рознице' +
    (d.supplier_name ? ' • ' + esc(d.supplier_name) : '');
  else if (d.type === 'vydacha') sum = fmtM(d.amount) + ' • долг +' + fmtM(d.money);
  else if (d.type === 'sdacha') sum = 'продано на ' + fmtM(d.amount) + ' • зачтено ' + fmtM(-d.money);
  else if (d.type === 'incass') sum = 'терминал ' + fmtM(d.amount) + ' → зачёт ' + fmtM(-d.money);
  else if (d.type === 'cash') sum = d.amount >= 0
    ? 'получено ' + fmtM(d.amount) : 'выдано продавцу ' + fmtM(-d.amount);
  else if (d.type === 'inventory') sum = 'результат ' + fmtM(d.amount) + ' по закупу';
  else if (d.type === 'initial') sum = 'введены остатки';
  const who = (showSeller && d.seller_name) ? esc(d.seller_name) + ' • ' : '';
  return '<details class="doc" ontoggle="onDocToggle(event,' + d.id + ')">' +
    '<summary><div class="dochead"><div><b>' + meta[0] + ' ' + meta[1] + '</b></div>' +
    '<div class="dt">' + dstr(d.date) + '</div></div>' +
    '<div class="sub hint small">' + who + sum +
    (d.comment ? ' • ' + esc(d.comment) : '') + '</div></summary>' +
    '<div class="doclines hint small">Загрузка…</div></details>';
}

window.onDocToggle = async function (ev, id) {
  const det = ev.target;
  if (!det.open || det.dataset.loaded) return;
  det.dataset.loaded = '1';
  try {
    const r = await api('/api/docs/' + id);
    det.querySelector('.doclines').innerHTML = docLinesHtml(r.doc) ||
      '<div class="hint small">Без позиций</div>';
  } catch (e) { det.querySelector('.doclines').textContent = e.message; }
};

function docLinesHtml(doc) {
  return doc.lines.map(l => {
    let txt = '';
    if (doc.type === 'prihod' || doc.type === 'initial') {
      txt = esc(l.name) + ' — ' + fmtQ(l.qty, l.unit);
    } else if (doc.type === 'inventory') {
      const diff = l.qty - (l.qty_before || 0);
      const dtxt = Math.abs(diff) < 0.0005 ? '' :
        ' <span class="' + (diff < 0 ? 'red' : 'green') + '">(' +
        (diff > 0 ? '+' : '') + fmtQ(diff, l.unit) + ')</span>';
      txt = esc(l.name) + ': учёт ' + fmtQ(l.qty_before || 0, l.unit) + ' → факт ' +
        fmtQ(l.qty, l.unit) + dtxt;
    } else if (doc.type === 'vydacha') {
      txt = esc(l.name) + ' — ' + fmtQ(l.qty, l.unit) + ' × ' + fmtM(l.retail_price) +
        ' = ' + fmtM(l.qty * l.retail_price) +
        (l.qty_shelf > 0 ? ' <span class="hint">(с полки ' + fmtQ(l.qty_shelf, l.unit) + ')</span>' : '');
    } else if (doc.type === 'sdacha') {
      const parts = [];
      if (l.qty_sold > 0) parts.push('продано ' + fmtQ(l.qty_sold, l.unit) +
        ' (' + fmtM(l.qty_sold * l.retail_price) + ')');
      if (l.qty_to_wh > 0) parts.push('на склад ' + fmtQ(l.qty_to_wh, l.unit));
      if (l.qty_to_shelf > 0) parts.push('на полку ' + fmtQ(l.qty_to_shelf, l.unit));
      txt = esc(l.name) + ': ' + parts.join(', ');
    }
    return '<div class="row small">' + txt + '</div>';
  }).join('');
}

// выбор товара с поиском
function openPicker(products, cb, subFn) {
  const ov = document.createElement('div');
  ov.className = 'picker';
  ov.innerHTML =
    '<div class="subhead"><button class="backbtn" id="pk-close">‹</button>' +
    '<div class="subtitle">Выбор товара</div></div>' +
    '<div class="field"><input id="pk-q" placeholder="Поиск…" autocomplete="off"></div>' +
    '<div id="pk-list"></div>';
  document.body.appendChild(ov);
  const list = ov.querySelector('#pk-list');
  const draw = q => {
    q = (q || '').toLowerCase().trim();
    const items = products.filter(p => !p.archived &&
      (!q || p.name.toLowerCase().includes(q) || (p.group_name || '').toLowerCase().includes(q)));
    let html = '', lastGroup = null;
    items.slice(0, 400).forEach(p => {
      if (p.group_name !== lastGroup) {
        lastGroup = p.group_name;
        html += '<div class="hint small" style="margin:10px 4px 4px;font-weight:700">' +
          esc(p.group_name || 'Без группы') + '</div>';
      }
      html += '<div class="card" style="padding:10px 12px;margin-bottom:6px" data-pid="' + p.id +
        '"><div class="name">' + esc(p.name) + '</div><div class="sub hint small">' +
        (subFn ? subFn(p) : fmtM(p.retail_price) + '/' + p.unit) + '</div></div>';
    });
    list.innerHTML = html || '<div class="hint" style="padding:20px;text-align:center">Не найдено</div>';
  };
  draw('');
  ov.querySelector('#pk-q').addEventListener('input', e => draw(e.target.value));
  ov.querySelector('#pk-q').focus();
  const close = () => ov.remove();
  ov.querySelector('#pk-close').onclick = close;
  list.addEventListener('click', e => {
    const c = e.target.closest('[data-pid]');
    if (!c) return;
    const p = products.find(x => x.id === +c.dataset.pid);
    close();
    cb(p);
  });
}

function periodChips(state, onChange) {
  const presets = [['today', 'Сегодня'], ['7', '7 дней'], ['30', '30 дней'],
    ['all', 'Всё время'], ['custom', 'Даты']];
  const chips = presets.map(p =>
    '<button class="chip' + (state.preset === p[0] ? ' on' : '') + '" data-p="' + p[0] + '">' +
    p[1] + '</button>').join('');
  const custom = state.preset === 'custom'
    ? '<div class="grid2" style="margin-bottom:10px">' +
      '<input type="date" id="pc-from" value="' + (state.from || daysAgo(6)) + '">' +
      '<input type="date" id="pc-to" value="' + (state.to || today()) + '"></div>'
    : '';
  return {
    html: '<div class="chips" id="pc-chips">' + chips + '</div>' + custom,
    bind(el) {
      el.querySelector('#pc-chips').addEventListener('click', e => {
        const c = e.target.closest('.chip');
        if (!c) return;
        state.preset = c.dataset.p;
        onChange();
      });
      const f = el.querySelector('#pc-from'), t = el.querySelector('#pc-to');
      if (f) {
        f.addEventListener('change', () => { state.from = f.value; onChange(); });
        t.addEventListener('change', () => { state.to = t.value; onChange(); });
      }
    },
  };
}

function periodDates(state) {
  if (state.preset === 'today') return { from: today(), to: today() };
  if (state.preset === '7') return { from: daysAgo(6), to: today() };
  if (state.preset === '30') return { from: daysAgo(29), to: today() };
  if (state.preset === 'all') return { from: '2000-01-01', to: today() };
  return { from: state.from || today(), to: state.to || today() };
}

// ===== экраны продавца =====
async function S_home() {
  const r = await api('/api/me/summary');
  SETTINGS = r.settings;
  const html =
    balanceHtml(r.balance, true) +
    '<button class="btn" id="go-incass">💳 Внести инкассацию</button>' +
    stockListHtml(r.stock.hands, '🚚 Товар на руках') +
    stockListHtml(r.stock.shelf, '🧺 На твоей полке') +
    (!r.stock.hands.length && !r.stock.shelf.length
      ? '<div class="card hint">Товара на тебе нет. Возьми товар на складе — и он появится здесь.</div>'
      : '');
  const el = screen('Привет, ' + ME.first_name + '!', html);
  el.querySelector('#go-incass').onclick = () => push(S_incass, null);
}

// склад для продавца: только актуальные остатки в кг
async function S_skladView() {
  const r = await api('/api/stock');
  const rows = r.rows.map(p =>
    '<div class="row prow" data-name="' + esc(p.name.toLowerCase()) + '">' +
    '<div class="l name small">' + esc(p.name) + '</div>' +
    '<div class="r val">' + fmtQ(p.qty, p.unit) + '</div></div>').join('');
  const html =
    '<div class="tiles" style="grid-template-columns:1fr 1fr">' +
    '<div class="tile"><div class="tl">Всего кг</div><div class="tv">' +
    NF3.format(r.totals.kg) + '</div></div>' +
    '<div class="tile"><div class="tl">Позиций</div><div class="tv">' + r.rows.length +
    '</div></div></div>' +
    '<div class="field"><input id="sv-q" placeholder="Поиск товара…"></div>' +
    '<div class="card">' + (rows || '<div class="hint">Склад пуст</div>') + '</div>';
  const el = screen('Склад', html);
  el.querySelector('#sv-q').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    el.querySelectorAll('.prow').forEach(row => {
      row.style.display = !q || row.dataset.name.includes(q) ? '' : 'none';
    });
  });
}

// аналитика для продавца: обороты всех по ценам продажи
const TO_STATE = { preset: '30' };

async function S_turnover() {
  const p = periodDates(TO_STATE);
  const chips = periodChips(TO_STATE, S_turnover);
  const r = await api('/api/analytics/turnover?date_from=' + p.from + '&date_to=' + p.to);
  const html = chips.html +
    '<div class="card"><h3>Оборот по ценам продажи</h3>' +
    (r.sellers.length ? r.sellers.map(s =>
      '<div class="row"><div class="l"><div class="name">' + esc(s.name) + '</div>' +
      (s.sold_kg > 0 ? '<div class="sub">' + fmtQ(s.sold_kg, 'кг') + '</div>' : '') +
      '</div><div class="r val">' + fmtM(s.sold_value) + '</div></div>').join('') +
      '<div class="row total"><div class="l">Итого</div><div class="r">' + fmtM(r.total) +
      '</div></div>'
      : '<div class="hint small">Продаж за период нет</div>') + '</div>';
  const el = screen('Аналитика', html);
  chips.bind(el);
}

async function S_incass(sellerId) {
  const self = !sellerId;
  const url = '/api/docs?type=incass' + (self ? '' : '&seller_id=' + sellerId) + '&limit=30';
  const r = await api(url);
  const comm = SETTINGS.commission_pct;
  const html =
    '<div class="card">' +
    '<div class="field"><label>Дата</label><input type="date" id="in-date" value="' + today() + '"></div>' +
    '<div class="field"><label>Сумма по терминалу, ₽</label>' +
    '<input id="in-amount" inputmode="decimal" placeholder="0"></div>' +
    '<div class="hint small" id="in-credit" style="margin-bottom:10px">К зачёту: 0 ₽ (минус ' +
    comm + '%)</div>' +
    '<button class="btn" id="in-save" style="margin-bottom:0">Сохранить</button></div>' +
    '<div class="card"><h3>Последние инкассации</h3>' +
    (r.docs.length ? r.docs.map(d =>
      '<div class="row"><div class="l"><div class="name">' + dstr(d.date) + '</div>' +
      '<div class="sub">зачёт ' + fmtM(-d.money) + '</div></div>' +
      '<div class="r val">' + fmtM(d.amount) + '</div></div>').join('')
      : '<div class="hint small">Пока нет</div>') + '</div>';
  const el = screen('Инкассация', html, true);
  const amt = el.querySelector('#in-amount');
  amt.addEventListener('input', () => {
    el.querySelector('#in-credit').textContent =
      'К зачёту: ' + fmtM(pnum(amt.value) * (100 - comm) / 100) + ' (минус ' + comm + '%)';
  });
  el.querySelector('#in-save').onclick = async () => {
    const amount = pnum(amt.value);
    if (amount <= 0) return toast('Укажи сумму терминала');
    try {
      await api('/api/docs/incass', 'POST', {
        seller_id: sellerId || undefined,
        date: el.querySelector('#in-date').value, amount,
      });
      toast('Инкассация записана ✓', true);
      if (self) render(); else back();
    } catch (e) { toast(e.message); }
  };
}

async function S_history() {
  const r = await api('/api/docs?limit=100');
  screen('История',
    r.docs.length ? r.docs.map(d => docCard(d, false)).join('')
      : '<div class="card hint">Операций пока нет</div>', true);
}

// ===== склад =====
async function S_sklad() {
  const r = await api('/api/stock');
  const t = r.totals;
  let rows = '', lastGroup = null;
  r.rows.forEach(p => {
    if (p.group_name !== lastGroup) {
      lastGroup = p.group_name;
      rows += '<div class="hint small" style="margin:10px 4px 2px;font-weight:700">' +
        esc(p.group_name || 'Без группы') + '</div>';
    }
    rows += '<div class="row"><div class="l"><div class="name">' + esc(p.name) + '</div>' +
      '<div class="sub">' + fmtQ(p.qty, p.unit) + ' • закуп ' + fmtM(p.purchase_value) +
      '</div></div><div class="r val">' + fmtM(p.retail_value) + '</div></div>';
  });
  const shelf = r.shelf_rows.length
    ? '<div class="card"><h3>🧺 На полках продавцов</h3>' + r.shelf_rows.map(s =>
      '<div class="row"><div class="l">' + esc(s.name) + '</div><div class="r val">' +
      fmtQ(s.qty, s.unit) + '</div></div>').join('') + '</div>'
    : '';
  const html =
    '<button class="btn" id="sk-prihod">📦 Приход товара</button>' +
    '<div class="btnrow"><button class="btn secondary" id="sk-inv">🔍 Инвентаризация</button>' +
    '<button class="btn secondary" id="sk-init">📋 Нач. остатки</button></div>' +
    '<div class="tiles">' +
    '<div class="tile"><div class="tl">Всего кг</div><div class="tv">' + NF3.format(t.kg) + '</div></div>' +
    '<div class="tile"><div class="tl">Закупка</div><div class="tv">' + fmtM(t.purchase_value) + '</div></div>' +
    '<div class="tile"><div class="tl">Розница</div><div class="tv">' + fmtM(t.retail_value) + '</div></div>' +
    '</div>' +
    '<div class="card"><h3>Остатки на складе</h3>' +
    (rows || '<div class="hint small">Склад пуст. Добавь приход или начальные остатки.</div>') +
    '</div>' + shelf;
  const el = screen('Склад', html);
  el.querySelector('#sk-prihod').onclick = () => push(S_prihod);
  el.querySelector('#sk-inv').onclick = () => push(S_countSheet, 'inventory');
  el.querySelector('#sk-init').onclick = () => push(S_countSheet, 'initial');
}

async function S_prihod() {
  const products = await getProducts(true);
  const sup = (await api('/api/suppliers')).suppliers;
  const lines = [];
  const html =
    '<div class="grid2" style="margin-bottom:10px">' +
    '<div class="field" style="margin:0"><label>Дата</label>' +
    '<input type="date" id="pr-date" value="' + today() + '"></div>' +
    '<div class="field" style="margin:0"><label>Поставщик</label><select id="pr-sup">' +
    '<option value="">— не указан —</option>' +
    sup.map(s => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('') +
    '</select></div></div>' +
    '<div id="pr-lines"></div>' +
    '<button class="btn secondary" id="pr-add">+ Добавить позицию</button>' +
    '<div class="card" id="pr-total" hidden></div>' +
    '<button class="btn" id="pr-save">Провести приход</button>';
  const el = screen('Приход товара', html, true);
  const linesEl = el.querySelector('#pr-lines');

  const totals = () => {
    let pv = 0, rv = 0, any = false;
    lines.forEach(l => {
      const q = pnum(l.qty);
      if (q > 0) { any = true; pv += q * l.product.purchase_price; rv += q * l.product.retail_price; }
    });
    const tEl = el.querySelector('#pr-total');
    tEl.hidden = !any;
    tEl.innerHTML = '<div class="row"><div class="l hint">По закупке</div><div class="r val">' +
      fmtM(pv) + '</div></div><div class="row"><div class="l hint">По рознице</div>' +
      '<div class="r val">' + fmtM(rv) + '</div></div>';
  };
  const draw = () => {
    linesEl.innerHTML = lines.map((l, i) =>
      '<div class="line"><div class="linehead"><div style="flex:1"><div class="name">' +
      esc(l.product.name) + '</div><div class="sub hint small">закуп ' +
      fmtM(l.product.purchase_price) + ' • розница ' + fmtM(l.product.retail_price) + '</div></div>' +
      '<button class="rm" data-i="' + i + '">✕</button></div>' +
      '<div class="field" style="margin:0"><label>Количество, ' + l.product.unit + '</label>' +
      '<input inputmode="decimal" class="qin" data-i="' + i + '" value="' + esc(l.qty) + '"></div>' +
      '</div>').join('');
    totals();
  };
  linesEl.addEventListener('input', e => {
    if (e.target.classList.contains('qin')) {
      lines[+e.target.dataset.i].qty = e.target.value;
      totals();
    }
  });
  linesEl.addEventListener('click', e => {
    const rm = e.target.closest('.rm');
    if (rm) { lines.splice(+rm.dataset.i, 1); draw(); }
  });
  el.querySelector('#pr-add').onclick = () =>
    openPicker(products, p => { lines.push({ product: p, qty: '' }); draw(); },
      p => 'остаток ' + fmtQ(p.stock_qty, p.unit) + ' • закуп ' + fmtM(p.purchase_price));
  el.querySelector('#pr-save').onclick = async () => {
    const out = lines.map(l => ({ product_id: l.product.id, qty: pnum(l.qty) }))
      .filter(l => l.qty > 0);
    if (!out.length) return toast('Добавь позиции и количество');
    try {
      await api('/api/docs/prihod', 'POST', {
        date: el.querySelector('#pr-date').value,
        supplier_id: +el.querySelector('#pr-sup').value || undefined,
        lines: out,
      });
      toast('Приход проведён ✓', true);
      PRODUCTS_CACHE = null;
      back();
    } catch (e) { toast(e.message); }
  };
}

async function S_countSheet(kind) {
  const products = (await getProducts(true)).filter(p => !p.archived);
  const isInv = kind === 'inventory';
  const rows = products.map(p =>
    '<div class="row prow" data-name="' + esc(p.name.toLowerCase()) + '">' +
    '<div class="l" style="flex:1"><div class="name small">' + esc(p.name) + '</div>' +
    (isInv ? '<div class="sub">учёт: ' + fmtQ(p.stock_qty, p.unit) + '</div>' : '') + '</div>' +
    '<div class="r" style="width:110px"><input inputmode="decimal" class="fin" data-pid="' + p.id +
    '" placeholder="' + (isInv ? 'факт' : '0') + '"></div></div>').join('');
  const html =
    '<div class="card hint small">' +
    (isInv
      ? 'Впиши фактическое количество по пересчитанным позициям. Пустые поля не трогаются.'
      : 'Введи начальные остатки склада. Пустые поля не трогаются.') + '</div>' +
    '<div class="field"><input id="cs-q" placeholder="Поиск товара…"></div>' +
    '<div class="field"><label>Дата</label><input type="date" id="cs-date" value="' + today() + '"></div>' +
    '<div class="card">' + (rows || '<div class="hint">Номенклатура пуста</div>') + '</div>' +
    '<button class="btn" id="cs-save">' + (isInv ? 'Провести инвентаризацию' : 'Сохранить остатки') +
    '</button>';
  const el = screen(isInv ? 'Инвентаризация' : 'Начальные остатки', html, true);
  el.querySelector('#cs-q').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    el.querySelectorAll('.prow').forEach(r => {
      r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none';
    });
  });
  el.querySelector('#cs-save').onclick = async () => {
    const lines = [];
    el.querySelectorAll('.fin').forEach(inp => {
      if (inp.value.trim() !== '') lines.push({ product_id: +inp.dataset.pid, qty: pnum(inp.value) });
    });
    if (!lines.length) return toast('Заполни хотя бы одну позицию');
    const ok = await confirmDlg('Записать ' + lines.length + ' позиц.?');
    if (!ok) return;
    try {
      await api('/api/docs/' + kind, 'POST',
        { date: el.querySelector('#cs-date').value, lines });
      toast(isInv ? 'Инвентаризация проведена ✓' : 'Остатки сохранены ✓', true);
      PRODUCTS_CACHE = null;
      back();
    } catch (e) { toast(e.message); }
  };
}

// ===== продавцы =====
async function S_sellers() {
  const r = await api('/api/sellers');
  const html = r.sellers.length ? r.sellers.map(s => {
    const bal = s.balance > 0.005
      ? '<span class="red">должен ' + fmtM(s.balance) + '</span>'
      : s.balance < -0.005
        ? '<span class="green">мы должны ' + fmtM(-s.balance) + '</span>'
        : '<span class="hint">расчёт 0 ₽</span>';
    return '<div class="card" data-sid="' + s.id + '" style="cursor:pointer">' +
      '<div class="row" style="border:none;padding:2px 0"><div class="l">' +
      '<div class="name">' + esc(s.name) + '</div>' +
      '<div class="sub">на руках на ' + fmtM(s.hands_value) +
      (s.shelf_value > 0 ? ' • полка ' + fmtM(s.shelf_value) : '') + '</div></div>' +
      '<div class="r">' + bal + '</div></div></div>';
  }).join('')
    : '<div class="card hint">Продавцов пока нет. Они появятся после регистрации в боте.</div>';
  const el = screen('Продавцы', html);
  el.addEventListener('click', e => {
    const c = e.target.closest('[data-sid]');
    if (c) push(S_seller, +c.dataset.sid);
  });
}

async function S_seller(sid) {
  const r = await api('/api/sellers/' + sid);
  const admin = ME.role === 'admin';
  const html =
    balanceHtml(r.balance, false) +
    '<div class="btnrow">' +
    '<button class="btn" id="a-vyd">🚚 Выдать товар</button>' +
    '<button class="btn" id="a-sd">↩️ Принять сдачу</button></div>' +
    '<div class="btnrow">' +
    '<button class="btn secondary" id="a-inc">💳 Инкассация</button>' +
    (admin ? '<button class="btn secondary" id="a-cash">💵 Наличный расчёт</button>'
           : '<div></div>') + '</div>' +
    stockListHtml(r.stock.hands, '🚚 На руках') +
    stockListHtml(r.stock.shelf, '🧺 На полке') +
    '<div class="card"><h3>Последние операции</h3>' +
    (r.docs.length ? r.docs.map(d => docCard(d, false)).join('')
      : '<div class="hint small">Пока нет</div>') + '</div>';
  const el = screen(r.seller.name, html, true);
  el.querySelector('#a-vyd').onclick = () => push(S_vydacha, sid);
  el.querySelector('#a-sd').onclick = () => push(S_sdacha, sid);
  el.querySelector('#a-inc').onclick = () => push(S_incass, sid);
  if (admin) el.querySelector('#a-cash').onclick = () => push(S_cash, sid, r.balance.balance);
}

async function S_vydacha(sid) {
  const products = await getProducts(true);
  const info = await api('/api/sellers/' + sid);
  const shelfMap = {};
  info.stock.shelf.forEach(s => { shelfMap[s.product_id] = s.qty; });
  const lines = [];
  const html =
    '<div class="field"><label>Дата</label><input type="date" id="v-date" value="' + today() + '"></div>' +
    '<div id="v-lines"></div>' +
    '<button class="btn secondary" id="v-add">+ Добавить позицию</button>' +
    '<div class="card" id="v-total" hidden></div>' +
    '<button class="btn" id="v-save">Выдать товар</button>';
  const el = screen('Выдача: ' + info.seller.name, html, true);
  const linesEl = el.querySelector('#v-lines');

  const totals = () => {
    let sum = 0, any = false;
    lines.forEach(l => {
      const q = pnum(l.qty_wh) + pnum(l.qty_shelf);
      if (q > 0) { any = true; sum += q * l.product.retail_price; }
    });
    const tEl = el.querySelector('#v-total');
    tEl.hidden = !any;
    tEl.innerHTML =
      '<div class="row"><div class="l hint">Товара по рознице</div><div class="r val">' +
      fmtM(sum) + '</div></div>' +
      '<div class="row"><div class="l hint">Долг (+' + SETTINGS.share_pct + '%)</div>' +
      '<div class="r val red">+ ' + fmtM(sum * SETTINGS.share_pct / 100) + '</div></div>';
  };
  const draw = () => {
    linesEl.innerHTML = lines.map((l, i) => {
      const shelfQ = shelfMap[l.product.id] || 0;
      return '<div class="line"><div class="linehead"><div style="flex:1">' +
        '<div class="name">' + esc(l.product.name) + '</div>' +
        '<div class="sub hint small">склад ' + fmtQ(l.product.stock_qty, l.product.unit) +
        (shelfQ > 0 ? ' • полка ' + fmtQ(shelfQ, l.product.unit) : '') +
        ' • ' + fmtM(l.product.retail_price) + '/' + l.product.unit + '</div></div>' +
        '<button class="rm" data-i="' + i + '">✕</button></div>' +
        '<div class="' + (shelfQ > 0 ? 'grid2' : '') + '">' +
        '<div class="field" style="margin:0"><label>Со склада, ' + l.product.unit + '</label>' +
        '<input inputmode="decimal" class="q-wh" data-i="' + i + '" value="' + esc(l.qty_wh) + '"></div>' +
        (shelfQ > 0
          ? '<div class="field" style="margin:0"><label>С полки, ' + l.product.unit + '</label>' +
            '<input inputmode="decimal" class="q-sh" data-i="' + i + '" value="' + esc(l.qty_shelf) + '"></div>'
          : '') +
        '</div></div>';
    }).join('');
    totals();
  };
  linesEl.addEventListener('input', e => {
    const i = +e.target.dataset.i;
    if (e.target.classList.contains('q-wh')) lines[i].qty_wh = e.target.value;
    if (e.target.classList.contains('q-sh')) lines[i].qty_shelf = e.target.value;
    totals();
  });
  linesEl.addEventListener('click', e => {
    const rm = e.target.closest('.rm');
    if (rm) { lines.splice(+rm.dataset.i, 1); draw(); }
  });
  el.querySelector('#v-add').onclick = () =>
    openPicker(products.filter(p => p.stock_qty > 0.0005 || shelfMap[p.id] > 0.0005),
      p => { lines.push({ product: p, qty_wh: '', qty_shelf: '' }); draw(); },
      p => 'склад ' + fmtQ(p.stock_qty, p.unit) +
        (shelfMap[p.id] ? ' • полка ' + fmtQ(shelfMap[p.id], p.unit) : '') +
        ' • ' + fmtM(p.retail_price) + '/' + p.unit);
  el.querySelector('#v-save').onclick = async () => {
    const out = lines.map(l => ({
      product_id: l.product.id, qty_wh: pnum(l.qty_wh), qty_shelf: pnum(l.qty_shelf),
    })).filter(l => l.qty_wh > 0 || l.qty_shelf > 0);
    if (!out.length) return toast('Добавь позиции и количество');
    try {
      const r = await api('/api/docs/vydacha', 'POST',
        { seller_id: sid, date: el.querySelector('#v-date').value, lines: out });
      toast('Выдано на ' + fmtM(r.doc.amount) + ', долг +' + fmtM(r.doc.money), true);
      PRODUCTS_CACHE = null;
      back();
    } catch (e) { toast(e.message); }
  };
}

async function S_sdacha(sid) {
  const info = await api('/api/sellers/' + sid);
  const hands = info.stock.hands;
  if (!hands.length) {
    screen('Сдача: ' + info.seller.name,
      '<div class="card hint">У продавца нет товара на руках.</div>', true);
    return;
  }
  const rows = hands.map((h, i) =>
    '<div class="line" data-i="' + i + '"><div class="linehead"><div style="flex:1">' +
    '<div class="name">' + esc(h.name) + '</div>' +
    '<div class="sub hint small">на руках ' + fmtQ(h.qty, h.unit) + ' • ' +
    fmtM(h.retail_price) + '/' + h.unit + '</div></div></div>' +
    '<div class="grid3">' +
    '<div class="field" style="margin:0"><label>На склад</label>' +
    '<input inputmode="decimal" class="s-wh" data-i="' + i + '"></div>' +
    '<div class="field" style="margin:0"><label>На полку</label>' +
    '<input inputmode="decimal" class="s-sh" data-i="' + i + '"></div>' +
    '<div class="field" style="margin:0"><label>Продано</label>' +
    '<input inputmode="decimal" class="s-sold" data-i="' + i + '" value="' + h.qty + '"></div>' +
    '</div></div>').join('');
  const html =
    '<div class="card hint small">Впиши, сколько вернулось на склад и на полку — «продано» ' +
    'посчитается само. Если что-то остаётся у продавца на руках, уменьши «продано».</div>' +
    '<div class="field"><label>Дата</label><input type="date" id="s-date" value="' + today() + '"></div>' +
    rows +
    '<div class="card" id="s-total"></div>' +
    '<button class="btn" id="s-save">Принять сдачу</button>';
  const el = screen('Сдача: ' + info.seller.name, html, true);
  const touched = {};

  const totals = () => {
    let sold = 0, ret = 0;
    hands.forEach((h, i) => {
      sold += pnum(el.querySelector('.s-sold[data-i="' + i + '"]').value) * h.retail_price;
      ret += (pnum(el.querySelector('.s-wh[data-i="' + i + '"]').value) +
        pnum(el.querySelector('.s-sh[data-i="' + i + '"]').value)) * h.retail_price;
    });
    el.querySelector('#s-total').innerHTML =
      '<div class="row"><div class="l hint">Продано на</div><div class="r val">' + fmtM(sold) +
      '</div></div><div class="row"><div class="l hint">Возврат товара</div><div class="r val">' +
      fmtM(ret) + '</div></div>' +
      '<div class="row"><div class="l hint">Списание долга (−' + SETTINGS.share_pct + '%)</div>' +
      '<div class="r val green">− ' + fmtM(ret * SETTINGS.share_pct / 100) + '</div></div>';
  };
  totals();
  el.addEventListener('input', e => {
    const i = e.target.dataset.i;
    if (i === undefined) return;
    if (e.target.classList.contains('s-sold')) touched[i] = true;
    if (!touched[i] && (e.target.classList.contains('s-wh') || e.target.classList.contains('s-sh'))) {
      const h = hands[+i];
      const rest = h.qty - pnum(el.querySelector('.s-wh[data-i="' + i + '"]').value) -
        pnum(el.querySelector('.s-sh[data-i="' + i + '"]').value);
      el.querySelector('.s-sold[data-i="' + i + '"]').value =
        Math.round(Math.max(0, rest) * 1000) / 1000;
    }
    totals();
  });
  el.querySelector('#s-save').onclick = async () => {
    const lines = [];
    let bad = null;
    hands.forEach((h, i) => {
      const wh = pnum(el.querySelector('.s-wh[data-i="' + i + '"]').value);
      const sh = pnum(el.querySelector('.s-sh[data-i="' + i + '"]').value);
      const sold = pnum(el.querySelector('.s-sold[data-i="' + i + '"]').value);
      if (wh + sh + sold > h.qty + 0.0005) bad = h.name;
      if (wh + sh + sold > 0) {
        lines.push({ product_id: h.product_id, qty_to_wh: wh, qty_to_shelf: sh, qty_sold: sold });
      }
    });
    if (bad) return toast(bad + ': сумма больше, чем на руках');
    if (!lines.length) return toast('Нечего проводить');
    try {
      const r = await api('/api/docs/sdacha', 'POST',
        { seller_id: sid, date: el.querySelector('#s-date').value, lines });
      toast('Сдача принята: продано на ' + fmtM(r.doc.amount), true);
      PRODUCTS_CACHE = null;
      back();
    } catch (e) { toast(e.message); }
  };
}

async function S_cash(sid, balance) {
  let dir = 1; // 1 = продавец отдаёт нам, -1 = мы отдаём продавцу
  const html =
    '<div class="card hint small">Текущий баланс: ' +
    (balance > 0 ? 'должен нам ' + fmtM(balance)
      : balance < 0 ? 'мы должны ' + fmtM(-balance) : '0 ₽') + '</div>' +
    '<div class="seg" id="c-seg"><button class="on">Продавец → нам</button>' +
    '<button>Мы → продавцу</button></div>' +
    '<div class="field"><label>Сумма, ₽</label>' +
    '<input id="c-amount" inputmode="decimal" placeholder="0"></div>' +
    '<div class="field"><label>Дата</label><input type="date" id="c-date" value="' + today() + '"></div>' +
    '<div class="field"><label>Комментарий</label><input id="c-comment" placeholder="необязательно"></div>' +
    '<button class="btn" id="c-save">Записать</button>';
  const el = screen('Наличный расчёт', html, true);
  el.querySelectorAll('#c-seg button').forEach((b, i) => {
    b.onclick = () => {
      dir = i === 0 ? 1 : -1;
      el.querySelectorAll('#c-seg button').forEach((x, j) =>
        x.classList.toggle('on', j === i));
    };
  });
  el.querySelector('#c-save').onclick = async () => {
    const amount = pnum(el.querySelector('#c-amount').value);
    if (amount <= 0) return toast('Укажи сумму');
    try {
      await api('/api/docs/cash', 'POST', {
        seller_id: sid, amount: amount * dir,
        date: el.querySelector('#c-date').value,
        comment: el.querySelector('#c-comment').value,
      });
      toast('Записано ✓', true);
      back();
    } catch (e) { toast(e.message); }
  };
}

// ===== аналитика =====
const AN_STATE = { preset: '7' };

async function S_analytics() {
  const p = periodDates(AN_STATE);
  const chips = periodChips(AN_STATE, S_analytics);
  const qs = 'date_from=' + p.from + '&date_to=' + p.to;
  const [sales, onSellers] = await Promise.all([
    api('/api/analytics/sales?' + qs), api('/api/analytics/on_sellers'),
  ]);
  let profitHtml = '';
  if (ME.role === 'admin') {
    const pr = await api('/api/analytics/profit?' + qs);
    const row = (l, v, cls) => '<div class="row"><div class="l hint">' + l +
      '</div><div class="r val ' + (cls || '') + '">' + v + '</div></div>';
    profitHtml = '<div class="card"><h3>💰 Прибыль за период</h3>' +
      '<div class="biglabel">Чистая прибыль</div>' +
      '<div class="bignum ' + (pr.net_profit >= 0 ? 'green' : 'red') + '">' +
      fmtM(pr.net_profit) + '</div>' +
      '<div class="sub hint" style="margin-bottom:8px">' + NF2.format(pr.margin_pct) +
      '% от оборота • ' + NF2.format(pr.margin_of_revenue_pct) + '% от нашей выручки</div>' +
      row('Оборот (продано по рознице)', fmtM(pr.turnover)) +
      row('Наша выручка (' + SETTINGS.share_pct + '%)', fmtM(pr.revenue)) +
      row('Себестоимость проданного', '− ' + fmtM(pr.cogs)) +
      row('Валовая прибыль', fmtM(pr.gross_profit)) +
      (Math.abs(pr.inventory_delta) > 0.005
        ? row('Инвентаризации (недостачи/излишки)',
            (pr.inventory_delta > 0 ? '+ ' : '− ') + fmtM(Math.abs(pr.inventory_delta)),
            pr.inventory_delta < 0 ? 'red' : 'green')
        : '') +
      row('Расходы', '− ' + fmtM(pr.expenses_total), 'red') +
      (pr.expenses_by_category.length
        ? '<div class="hint small" style="margin-top:6px">' +
          pr.expenses_by_category.map(c => esc(c.category) + ': ' + fmtM(c.amount)).join(' • ') +
          '</div>'
        : '') +
      '</div>';
  }
  const t = sales.totals;
  const sellersHtml = sales.sellers.length ? sales.sellers.map(s =>
    '<details class="doc"><summary><div class="dochead"><div><b>' + esc(s.name) + '</b></div>' +
    '<div class="dt">' + fmtM(s.sold_value) + '</div></div>' +
    '<div class="sub hint small">' +
    (s.sold_kg > 0 ? fmtQ(s.sold_kg, 'кг') + ' • ' : '') +
    'наша доля ' + fmtM(s.our_share) + ' • терминал ' + fmtM(s.terminal_credit) +
    (s.cash ? ' • нал ' + fmtM(s.cash) : '') + '</div></summary>' +
    '<div class="doclines small">' + s.products.map(pp =>
      '<div class="row small"><div class="l">' + esc(pp.name) + '</div><div class="r">' +
      fmtQ(pp.qty, pp.unit) + ' • ' + fmtM(pp.value) + '</div></div>').join('') +
    '</div></details>').join('')
    : '<div class="hint small">Продаж за период нет</div>';
  const onSellersHtml = onSellers.sellers.length ? onSellers.sellers.map(s =>
    '<details class="doc"><summary><div class="dochead"><div><b>' + esc(s.name) + '</b></div>' +
    '<div class="dt">' + fmtM(s.hands_value + s.shelf_value) + '</div></div>' +
    '<div class="sub hint small">на руках ' + fmtM(s.hands_value) +
    (s.shelf_value > 0 ? ' • полка ' + fmtM(s.shelf_value) : '') + '</div></summary>' +
    '<div class="doclines small">' +
    s.hands.map(h => '<div class="row small"><div class="l">🚚 ' + esc(h.name) + '</div>' +
      '<div class="r">' + fmtQ(h.qty, h.unit) + '</div></div>').join('') +
    s.shelf.map(h => '<div class="row small"><div class="l">🧺 ' + esc(h.name) + '</div>' +
      '<div class="r">' + fmtQ(h.qty, h.unit) + '</div></div>').join('') +
    '</div></details>').join('')
    : '<div class="hint small">На продавцах товара нет</div>';
  const html = chips.html + profitHtml +
    '<div class="tiles">' +
    '<div class="tile"><div class="tl">Продано</div><div class="tv">' + fmtM(t.sold_value) + '</div></div>' +
    '<div class="tile"><div class="tl">Наша доля</div><div class="tv">' + fmtM(t.our_share) + '</div></div>' +
    '<div class="tile"><div class="tl">Терминал</div><div class="tv">' + fmtM(t.terminal_credit) + '</div></div>' +
    '</div>' +
    '<div class="card"><h3>Продажи по продавцам</h3>' + sellersHtml + '</div>' +
    '<div class="card"><h3>Товар на продавцах</h3>' + onSellersHtml + '</div>';
  const el = screen('Аналитика', html);
  chips.bind(el);
}

// ===== мероприятия и точки =====
const PL_STATE = { seg: 'events', when: 'upcoming', city: '', ptype: '' };
const P_TYPES = ['Праздник', 'Рынок', 'ТЦ', 'Сеть', 'Магазин', 'Другое'];
const E_TYPES = ['Праздник', 'Ярмарка', 'Фестиваль', 'Другое'];

function ownerLine(x) {
  return x.owner_name
    ? '👤 ездит: <b>' + esc(x.owner_name) + '</b>'
    : '<span class="green">точка свободна</span>';
}

function bookingsLine(x) {
  if (!x.bookings || !x.bookings.length) return '';
  return '<div class="sub small" style="margin-top:2px">' + x.bookings.slice(0, 3).map(b =>
    '🔒 ' + esc(b.user_name) + ': ' + dstr(b.date_from) +
    (b.date_to !== b.date_from ? ' – ' + dstr(b.date_to) : '')).join(' • ') +
    (x.bookings.length > 3 ? ' • ещё ' + (x.bookings.length - 3) : '') + '</div>';
}

function bookingBlock(el, kind, refId, meta) {
  const box = el.querySelector('#bk-box');
  const drawList = async () => {
    const r = await api('/api/bookings?kind=' + kind + '&ref_id=' + refId);
    box.querySelector('#bk-list').innerHTML = r.bookings.length
      ? r.bookings.map(b =>
        '<div class="row"><div class="l"><div class="name small">🔒 ' + esc(b.user_name) +
        '</div><div class="sub">' + dstr(b.date_from) +
        (b.date_to !== b.date_from ? ' – ' + dstr(b.date_to) : '') +
        (b.comment ? ' • ' + esc(b.comment) : '') + '</div></div>' +
        '<div class="r"><button class="chip" data-bdel="' + b.id + '">✕</button></div></div>').join('')
      : '<div class="hint small">Активных броней нет</div>';
  };
  box.innerHTML =
    '<h3>🔒 Брони</h3><div id="bk-list"></div>' +
    '<div class="grid2" style="margin-top:10px">' +
    '<input type="date" id="bk-from" value="' + today() + '">' +
    '<input type="date" id="bk-to" value=""></div>' +
    '<div class="field" style="margin-top:8px"><select id="bk-who">' +
    meta.people.map(pp => '<option value="' + pp.id + '"' +
      (pp.id === ME.id ? ' selected' : '') + '>' + esc(pp.name) + '</option>').join('') +
    '</select></div>' +
    '<button class="btn secondary" id="bk-add" style="margin-bottom:0">Забронировать</button>';
  drawList();
  box.querySelector('#bk-add').onclick = async () => {
    try {
      await api('/api/bookings', 'POST', {
        kind, ref_id: refId,
        user_id: +box.querySelector('#bk-who').value,
        date_from: box.querySelector('#bk-from').value,
        date_to: box.querySelector('#bk-to').value,
      });
      toast('Забронировано ✓', true);
      drawList();
    } catch (e) { toast(e.message); }
  };
  box.addEventListener('click', async e => {
    const d = e.target.closest('[data-bdel]');
    if (!d) return;
    if (!(await confirmDlg('Снять бронь?'))) return;
    try { await api('/api/bookings/' + d.dataset.bdel, 'DELETE'); drawList(); }
    catch (err) { toast(err.message); }
  });
}

async function S_places() {
  const meta = await api('/api/places/meta');
  const isEv = PL_STATE.seg === 'events';
  const cityOpts = '<option value="">Все города</option>' + meta.cities.map(c =>
    '<option' + (PL_STATE.city === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
  let listHtml = '';
  if (isEv) {
    const r = await api('/api/events?when=' + PL_STATE.when +
      '&city=' + encodeURIComponent(PL_STATE.city));
    listHtml = r.events.length ? r.events.map(ev => {
      const dates = dstr(ev.date_from) +
        (ev.date_to && ev.date_to !== ev.date_from ? ' – ' + dstr(ev.date_to) : '');
      return '<div class="card" data-eid="' + ev.id + '" style="cursor:pointer">' +
        '<div class="dochead"><div><b>' + esc(ev.name) + '</b></div>' +
        '<div class="dt">' + dates + '</div></div>' +
        '<div class="sub hint small">' + [esc(ev.etype), esc(ev.city)].filter(Boolean).join(' • ') +
        '</div><div class="sub small" style="margin-top:4px">' + ownerLine(ev) +
        (ev.comment ? ' • <span class="hint">' + esc(ev.comment) + '</span>' : '') +
        '</div>' + bookingsLine(ev) + '</div>';
    }).join('') : '<div class="card hint">Мероприятий нет — добавь первое!</div>';
  } else {
    const r = await api('/api/points?ptype=' + encodeURIComponent(PL_STATE.ptype) +
      '&city=' + encodeURIComponent(PL_STATE.city));
    listHtml = r.points.length ? r.points.map(pt =>
      '<div class="card" data-ptid="' + pt.id + '" style="cursor:pointer">' +
      '<div><b>' + esc(pt.name) + '</b></div>' +
      '<div class="sub hint small">' +
      ([esc(pt.address || ''), esc(pt.city)].filter(Boolean).join(', ') || 'адрес не указан') +
      '</div>' + bookingsLine(pt) +
      '<button class="btn secondary" data-book="' + pt.id +
      '" style="margin:10px 0 0;padding:10px">Забронировать</button></div>').join('')
      : '<div class="card hint">Точек нет — добавь первую!</div>';
  }
  const whenChips = isEv
    ? '<div class="chips">' + [['upcoming', 'Ближайшие'], ['past', 'Прошедшие'], ['all', 'Все']]
      .map(w => '<button class="chip' + (PL_STATE.when === w[0] ? ' on' : '') +
        '" data-when="' + w[0] + '">' + w[1] + '</button>').join('') + '</div>'
    : '<div class="chips">' + [['', 'Все']].concat(P_TYPES.map(t => [t, t]))
      .map(w => '<button class="chip' + (PL_STATE.ptype === w[0] ? ' on' : '') +
        '" data-ptype="' + w[0] + '">' + w[1] + '</button>').join('') + '</div>';
  const html =
    '<div class="seg" id="pl-seg"><button' + (isEv ? ' class="on"' : '') +
    '>📅 Мероприятия</button><button' + (!isEv ? ' class="on"' : '') + '>📍 Точки</button></div>' +
    '<button class="btn" id="pl-add">+ Добавить ' + (isEv ? 'мероприятие' : 'точку') + '</button>' +
    whenChips +
    '<div class="field"><select id="pl-city">' + cityOpts + '</select></div>' +
    listHtml;
  const el = screen('Точки и события', html);
  el.querySelectorAll('#pl-seg button').forEach((b, i) => {
    b.onclick = () => { PL_STATE.seg = i === 0 ? 'events' : 'points'; render(); };
  });
  el.querySelector('#pl-add').onclick = () =>
    push(isEv ? S_eventEdit : S_pointEdit, null, meta);
  el.querySelector('#pl-city').addEventListener('change', e => {
    PL_STATE.city = e.target.value; render();
  });
  el.addEventListener('click', e => {
    const w = e.target.closest('[data-when]');
    if (w) { PL_STATE.when = w.dataset.when; render(); return; }
    const pt = e.target.closest('[data-ptype]');
    if (pt) { PL_STATE.ptype = pt.dataset.ptype; render(); return; }
    const ec = e.target.closest('[data-eid]');
    if (ec) {
      api('/api/events?when=all').then(r =>
        push(S_eventEdit, r.events.find(x => x.id === +ec.dataset.eid), meta));
      return;
    }
    const bk = e.target.closest('[data-book]');
    const pc = e.target.closest('[data-ptid]');
    if (bk || pc) {
      const pid = +(bk ? bk.dataset.book : pc.dataset.ptid);
      api('/api/points').then(r =>
        push(S_pointEdit, r.points.find(x => x.id === pid), meta, !!bk));
    }
  });
}

function ownerSelect(id, meta, current) {
  return '<div class="field"><label>Кто туда ездит</label><select id="' + id + '">' +
    '<option value="">— точка свободна —</option>' +
    meta.people.map(pp => '<option value="' + pp.id + '"' +
      (current === pp.id ? ' selected' : '') + '>' + esc(pp.name) + '</option>').join('') +
    '</select></div>';
}

function cityField(id, meta, val) {
  return '<div class="field"><label>Город</label><input id="' + id + '" list="' + id + '-dl" value="' +
    esc(val || '') + '"><datalist id="' + id + '-dl">' +
    meta.cities.map(c => '<option value="' + esc(c) + '">').join('') + '</datalist></div>';
}

async function S_eventEdit(ev, meta) {
  const html =
    '<div class="field"><label>Название</label><input id="ee-name" value="' +
    esc(ev ? ev.name : '') + '"></div>' +
    '<div class="field"><label>Тип</label><input id="ee-type" list="ee-types" value="' +
    esc(ev ? ev.etype : '') + '" placeholder="Ярмарка, фестиваль…"><datalist id="ee-types">' +
    E_TYPES.map(t => '<option value="' + t + '">').join('') + '</datalist></div>' +
    cityField('ee-city', meta, ev && ev.city) +
    '<div class="grid2">' +
    '<div class="field"><label>Начало</label><input type="date" id="ee-from" value="' +
    (ev ? ev.date_from : today()) + '"></div>' +
    '<div class="field"><label>Окончание</label><input type="date" id="ee-to" value="' +
    (ev && ev.date_to ? ev.date_to : '') + '"></div></div>' +
    ownerSelect('ee-owner', meta, ev && ev.owner_user_id) +
    '<div class="field"><label>Комментарий</label><input id="ee-comment" value="' +
    esc(ev ? ev.comment || '' : '') + '"></div>' +
    '<button class="btn" id="ee-save">Сохранить</button>' +
    (ev ? '<div class="card" id="bk-box"></div>' : '') +
    (ev && (ME.role === 'admin' || ev.created_by === ME.id)
      ? '<button class="btn danger" id="ee-del">Удалить</button>' : '');
  const el = screen(ev ? 'Мероприятие' : 'Новое мероприятие', html, true);
  if (ev) bookingBlock(el, 'event', ev.id, meta);
  el.querySelector('#ee-save').onclick = async () => {
    try {
      await api('/api/events', 'POST', {
        id: ev ? ev.id : undefined,
        name: el.querySelector('#ee-name').value,
        etype: el.querySelector('#ee-type').value,
        city: el.querySelector('#ee-city').value,
        date_from: el.querySelector('#ee-from').value,
        date_to: el.querySelector('#ee-to').value,
        owner_user_id: +el.querySelector('#ee-owner').value || null,
        comment: el.querySelector('#ee-comment').value,
      });
      toast('Сохранено ✓', true);
      back();
    } catch (e) { toast(e.message); }
  };
  const del = el.querySelector('#ee-del');
  if (del) del.onclick = async () => {
    if (!(await confirmDlg('Удалить мероприятие?'))) return;
    try { await api('/api/events/' + ev.id, 'DELETE'); toast('Удалено', true); back(); }
    catch (e) { toast(e.message); }
  };
}

async function S_pointEdit(pt, meta, scrollToBooking) {
  const contacts = pt
    ? '<div class="card"><h3>📞 Контакты точки</h3>' +
      '<div class="row"><div class="l hint">Телефон</div><div class="r val">' +
      (pt.phone ? '<a href="tel:' + esc(pt.phone) + '">' + esc(pt.phone) + '</a>'
        : '<span class="hint">не указан</span>') + '</div></div>' +
      '<div class="row"><div class="l hint">Почта</div><div class="r val">' +
      (pt.email ? '<a href="mailto:' + esc(pt.email) + '">' + esc(pt.email) + '</a>'
        : '<span class="hint">не указана</span>') + '</div></div>' +
      '<div class="row"><div class="l hint">Чья точка</div><div class="r val">' +
      (pt.owner_name ? esc(pt.owner_name) : '<span class="green">свободна</span>') +
      '</div></div>' +
      (pt.comment ? '<div class="hint small" style="margin-top:6px">' + esc(pt.comment) +
        '</div>' : '') + '</div>'
    : '';
  const html =
    contacts +
    (pt ? '<div class="card" id="bk-box"></div>' : '') +
    '<div class="card"><h3>' + (pt ? '✏️ Редактировать' : 'Данные точки') + '</h3>' +
    '<div class="field"><label>Название</label><input id="po-name" value="' +
    esc(pt ? pt.name : '') + '"></div>' +
    '<div class="field"><label>Адрес</label><input id="po-addr" value="' +
    esc(pt ? pt.address || '' : '') + '"></div>' +
    '<div class="grid2">' +
    '<div class="field"><label>Телефон</label><input id="po-phone" inputmode="tel" value="' +
    esc(pt ? pt.phone || '' : '') + '"></div>' +
    '<div class="field"><label>Почта</label><input id="po-email" inputmode="email" value="' +
    esc(pt ? pt.email || '' : '') + '"></div></div>' +
    '<div class="field"><label>Тип</label><input id="po-type" list="po-types" value="' +
    esc(pt ? pt.ptype : '') + '" placeholder="Рынок, ТЦ, сеть…"><datalist id="po-types">' +
    P_TYPES.map(t => '<option value="' + t + '">').join('') + '</datalist></div>' +
    cityField('po-city', meta, pt && pt.city) +
    ownerSelect('po-owner', meta, pt && pt.owner_user_id) +
    '<div class="field"><label>Комментарий</label><input id="po-comment" value="' +
    esc(pt ? pt.comment || '' : '') + '"></div>' +
    '<button class="btn" id="po-save" style="margin-bottom:0">Сохранить</button></div>' +
    (pt && (ME.role === 'admin' || pt.created_by === ME.id)
      ? '<button class="btn danger" id="po-del">Удалить</button>' : '');
  const el = screen(pt ? pt.name : 'Новая точка', html, true);
  if (pt) {
    bookingBlock(el, 'point', pt.id, meta);
    if (scrollToBooking) el.querySelector('#bk-box').scrollIntoView({ block: 'start' });
  }
  el.querySelector('#po-save').onclick = async () => {
    try {
      await api('/api/points', 'POST', {
        id: pt ? pt.id : undefined,
        name: el.querySelector('#po-name').value,
        ptype: el.querySelector('#po-type').value,
        city: el.querySelector('#po-city').value,
        address: el.querySelector('#po-addr').value,
        phone: el.querySelector('#po-phone').value,
        email: el.querySelector('#po-email').value,
        owner_user_id: +el.querySelector('#po-owner').value || null,
        comment: el.querySelector('#po-comment').value,
      });
      toast('Сохранено ✓', true);
      back();
    } catch (e) { toast(e.message); }
  };
  const del = el.querySelector('#po-del');
  if (del) del.onclick = async () => {
    if (!(await confirmDlg('Удалить точку?'))) return;
    try { await api('/api/points/' + pt.id, 'DELETE'); toast('Удалено', true); back(); }
    catch (e) { toast(e.message); }
  };
}

// ===== ещё =====
async function S_more() {
  const admin = ME.role === 'admin';
  const seller = ME.role === 'seller';
  const roleName = admin ? 'администратор' : (seller ? 'продавец' : 'кладовщик');
  const item = (id, ico, name) =>
    '<div class="card" style="cursor:pointer" id="' + id + '"><div class="name">' + ico + ' ' +
    name + '</div></div>';
  const html =
    (seller ? item('m-history', '🗂', 'История моих операций')
      : item('m-products', '🏷', 'Номенклатура') +
        item('m-sup', '🚛', 'Поставщики') +
        (admin ? item('m-exp', '🧾', 'Расходы') : '') +
        item('m-docs', '📚', 'Все документы') +
        item('m-users', '👤', 'Пользователи') +
        (admin ? item('m-set', '⚙️', 'Настройки') : '')) +
    '<div class="hint small" style="text-align:center;margin-top:16px">' +
    esc(ME.first_name + ' ' + ME.last_name) + ' • ' + roleName + '</div>';
  const el = screen('Ещё', html);
  if (seller) {
    el.querySelector('#m-history').onclick = () => push(S_history);
    return;
  }
  el.querySelector('#m-products').onclick = () => push(S_products);
  el.querySelector('#m-sup').onclick = () => push(S_suppliers);
  el.querySelector('#m-docs').onclick = () => push(S_docs);
  el.querySelector('#m-users').onclick = () => push(S_users);
  if (admin) {
    el.querySelector('#m-exp').onclick = () => push(S_expenses);
    el.querySelector('#m-set').onclick = () => push(S_settings);
  }
}

async function S_products() {
  const products = await getProducts(true);
  const active = products.filter(p => !p.archived);
  const arch = products.filter(p => p.archived);
  const rowP = p =>
    '<div class="row" data-pid="' + p.id + '" style="cursor:pointer">' +
    '<div class="l"><div class="name small">' + esc(p.name) + '</div>' +
    '<div class="sub">закуп ' + fmtM(p.purchase_price) + ' • розница ' + fmtM(p.retail_price) +
    ' • остаток ' + fmtQ(p.stock_qty, p.unit) + '</div></div><div class="r hint">›</div></div>';
  let listHtml = '', lastGroup = null;
  active.forEach(p => {
    if (p.group_name !== lastGroup) {
      lastGroup = p.group_name;
      listHtml += '<div class="hint small" style="margin:10px 4px 2px;font-weight:700">' +
        esc(p.group_name || 'Без группы') + '</div>';
    }
    listHtml += rowP(p);
  });
  const html =
    '<button class="btn" id="p-add">+ Добавить товар</button>' +
    '<div class="field"><input id="p-q" placeholder="Поиск…"></div>' +
    '<div class="card" id="p-list">' + (listHtml || '<div class="hint">Пусто</div>') + '</div>' +
    (arch.length
      ? '<div class="card"><h3>Архив</h3>' + arch.map(rowP).join('') + '</div>' : '');
  const el = screen('Номенклатура', html, true);
  el.querySelector('#p-add').onclick = () => push(S_productEdit, null);
  el.querySelector('#p-q').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    el.querySelectorAll('#p-list .row').forEach(r => {
      r.style.display = !q || r.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  el.addEventListener('click', e => {
    const c = e.target.closest('[data-pid]');
    if (c) push(S_productEdit, products.find(p => p.id === +c.dataset.pid));
  });
}

async function S_productEdit(p) {
  const products = await getProducts();
  const groups = [...new Set(products.map(x => x.group_name).filter(Boolean))];
  const html =
    '<div class="field"><label>Название</label><input id="pe-name" value="' +
    esc(p ? p.name : '') + '"></div>' +
    '<div class="field"><label>Группа</label><input id="pe-group" list="pe-groups" value="' +
    esc(p ? p.group_name : '') + '"><datalist id="pe-groups">' +
    groups.map(g => '<option value="' + esc(g) + '">').join('') + '</datalist></div>' +
    '<div class="seg" id="pe-unit"><button' + (!p || p.unit === 'кг' ? ' class="on"' : '') +
    '>кг</button><button' + (p && p.unit === 'шт' ? ' class="on"' : '') + '>шт</button></div>' +
    '<div class="grid2">' +
    '<div class="field"><label>Закупочная, ₽</label><input id="pe-pp" inputmode="decimal" value="' +
    (p ? p.purchase_price : '') + '"></div>' +
    '<div class="field"><label>Розничная, ₽</label><input id="pe-rp" inputmode="decimal" value="' +
    (p ? p.retail_price : '') + '"></div></div>' +
    '<button class="btn" id="pe-save">Сохранить</button>' +
    (p ? '<button class="btn secondary" id="pe-arch">' +
      (p.archived ? 'Вернуть из архива' : 'В архив') + '</button>' +
      '<button class="btn danger" id="pe-del">Удалить</button>' : '');
  const el = screen(p ? 'Товар' : 'Новый товар', html, true);
  let unit = p ? p.unit : 'кг';
  el.querySelectorAll('#pe-unit button').forEach((b, i) => {
    b.onclick = () => {
      unit = i === 0 ? 'кг' : 'шт';
      el.querySelectorAll('#pe-unit button').forEach((x, j) => x.classList.toggle('on', j === i));
    };
  });
  el.querySelector('#pe-save').onclick = async () => {
    const body = {
      name: el.querySelector('#pe-name').value,
      group_name: el.querySelector('#pe-group').value,
      unit,
      purchase_price: pnum(el.querySelector('#pe-pp').value),
      retail_price: pnum(el.querySelector('#pe-rp').value),
    };
    try {
      if (p) await api('/api/products/' + p.id, 'PUT', body);
      else await api('/api/products', 'POST', body);
      toast('Сохранено ✓', true);
      PRODUCTS_CACHE = null;
      back();
    } catch (e) { toast(e.message); }
  };
  if (p) {
    el.querySelector('#pe-arch').onclick = async () => {
      try {
        await api('/api/products/' + p.id, 'PUT', { archived: p.archived ? 0 : 1 });
        toast(p.archived ? 'Возвращён из архива' : 'Товар в архиве', true);
        PRODUCTS_CACHE = null;
        back();
      } catch (e) { toast(e.message); }
    };
    el.querySelector('#pe-del').onclick = async () => {
      const ok = await confirmDlg('Удалить «' + p.name + '» безвозвратно?');
      if (!ok) return;
      try {
        await api('/api/products/' + p.id, 'DELETE');
        toast('Товар удалён', true);
        PRODUCTS_CACHE = null;
        back();
      } catch (e) { toast(e.message); }
    };
  }
}

async function S_suppliers() {
  const r = await api('/api/suppliers');
  const html =
    '<button class="btn" id="su-add">+ Добавить поставщика</button>' +
    '<div class="card">' +
    (r.suppliers.length ? r.suppliers.map(s =>
      '<div class="row"><div class="l name">' + esc(s.name) + '</div>' +
      '<div class="r"><button class="chip" data-ren="' + s.id + '">✏️</button> ' +
      '<button class="chip" data-arch="' + s.id + '">🗑</button></div></div>').join('')
      : '<div class="hint">Поставщиков пока нет</div>') + '</div>';
  const el = screen('Поставщики', html, true);
  el.querySelector('#su-add').onclick = async () => {
    const name = window.prompt('Название поставщика:');
    if (!name) return;
    try { await api('/api/suppliers', 'POST', { name }); render(); }
    catch (e) { toast(e.message); }
  };
  el.addEventListener('click', async e => {
    const ren = e.target.closest('[data-ren]');
    const arch = e.target.closest('[data-arch]');
    try {
      if (ren) {
        const s = r.suppliers.find(x => x.id === +ren.dataset.ren);
        const name = window.prompt('Новое название:', s.name);
        if (name && name !== s.name) { await api('/api/suppliers/' + s.id, 'PUT', { name }); render(); }
      } else if (arch) {
        const s = r.suppliers.find(x => x.id === +arch.dataset.arch);
        const ok = await confirmDlg('Убрать поставщика «' + s.name + '»?');
        if (ok) { await api('/api/suppliers/' + s.id, 'PUT', { archived: 1 }); render(); }
      }
    } catch (err) { toast(err.message); }
  });
}

const EX_STATE = { preset: '30' };
const EX_CATS = ['Грузчики', 'Зарплата', 'Аренда', 'Транспорт', 'Прочее'];

async function S_expenses() {
  const p = periodDates(EX_STATE);
  const chips = periodChips(EX_STATE, S_expenses);
  const r = await api('/api/expenses?date_from=' + p.from + '&date_to=' + p.to);
  const html =
    '<button class="btn" id="ex-add">+ Добавить расход</button>' +
    chips.html +
    '<div class="card"><div class="row total"><div class="l">Итого за период</div>' +
    '<div class="r">' + fmtM(r.total) + '</div></div>' +
    (r.by_category.length
      ? '<div class="hint small" style="margin-top:6px">' +
        r.by_category.map(c => esc(c.category) + ': ' + fmtM(c.amount)).join(' • ') + '</div>'
      : '') + '</div>' +
    '<div class="card">' +
    (r.expenses.length ? r.expenses.map(x =>
      '<div class="row"><div class="l"><div class="name small">' + esc(x.category) + '</div>' +
      '<div class="sub">' + dstr(x.date) + (x.comment ? ' • ' + esc(x.comment) : '') + '</div></div>' +
      '<div class="r"><span class="val">' + fmtM(x.amount) + '</span> ' +
      '<button class="chip" data-del="' + x.id + '">✕</button></div></div>').join('')
      : '<div class="hint">Расходов за период нет</div>') + '</div>';
  const el = screen('Расходы', html, true);
  chips.bind(el);
  el.querySelector('#ex-add').onclick = () => push(S_expenseAdd);
  el.addEventListener('click', async e => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    const ok = await confirmDlg('Удалить расход?');
    if (!ok) return;
    try { await api('/api/expenses/' + del.dataset.del, 'DELETE'); render(); }
    catch (err) { toast(err.message); }
  });
}

async function S_expenseAdd() {
  const html =
    '<div class="field"><label>Категория</label><select id="xa-cat">' +
    EX_CATS.map(c => '<option>' + c + '</option>').join('') +
    '<option value="__other">Другая…</option></select></div>' +
    '<div class="field" id="xa-other-w" hidden><label>Своя категория</label>' +
    '<input id="xa-other" placeholder="например, Бензин"></div>' +
    '<div class="field"><label>Сумма, ₽</label>' +
    '<input id="xa-amount" inputmode="decimal" placeholder="0"></div>' +
    '<div class="field"><label>Дата</label><input type="date" id="xa-date" value="' + today() + '"></div>' +
    '<div class="field"><label>Комментарий</label><input id="xa-comment" placeholder="необязательно"></div>' +
    '<button class="btn" id="xa-save">Записать</button>';
  const el = screen('Новый расход', html, true);
  const catSel = el.querySelector('#xa-cat');
  catSel.addEventListener('change', () => {
    el.querySelector('#xa-other-w').hidden = catSel.value !== '__other';
  });
  el.querySelector('#xa-save').onclick = async () => {
    const amount = pnum(el.querySelector('#xa-amount').value);
    if (amount <= 0) return toast('Укажи сумму');
    const category = catSel.value === '__other'
      ? el.querySelector('#xa-other').value : catSel.value;
    try {
      await api('/api/expenses', 'POST', {
        category, amount,
        date: el.querySelector('#xa-date').value,
        comment: el.querySelector('#xa-comment').value,
      });
      toast('Расход записан ✓', true);
      back();
    } catch (e) { toast(e.message); }
  };
}

const DOCS_STATE = { type: '' };

async function S_docs() {
  const r = await api('/api/docs?limit=100' + (DOCS_STATE.type ? '&type=' + DOCS_STATE.type : ''));
  const types = [['', 'Все'], ['prihod', 'Приход'], ['vydacha', 'Выдача'], ['sdacha', 'Сдача'],
    ['incass', 'Инкассация'], ['cash', 'Наличные'], ['inventory', 'Инвентаризация']];
  const chips = types.map(t =>
    '<button class="chip' + (DOCS_STATE.type === t[0] ? ' on' : '') + '" data-t="' + t[0] + '">' +
    t[1] + '</button>').join('');
  const el = screen('Документы',
    '<div class="chips">' + chips + '</div>' +
    (r.docs.length ? r.docs.map(d => docCard(d, true)).join('')
      : '<div class="card hint">Документов нет</div>'), true);
  el.querySelector('.chips').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    DOCS_STATE.type = c.dataset.t;
    render();
  });
}

async function S_users() {
  const r = await api('/api/users');
  const allRoles = [['seller', 'Продавец'], ['keeper', 'Кладовщик'], ['admin', 'Админ']];
  const roles = ME.role === 'admin' ? allRoles : allRoles.slice(0, 2);
  const roleTitle = { seller: 'Продавец', keeper: 'Кладовщик', admin: 'Админ' };
  const html = '<div class="card">' + r.users.map(u => {
    const locked = ME.role !== 'admin' && u.role === 'admin';
    const controls = locked
      ? '<span class="hint small">Админ</span>'
      : '<select data-uid="' + u.id + '" style="width:auto;padding:6px 8px;font-size:13px">' +
        roles.map(x => '<option value="' + x[0] + '"' + (u.role === x[0] ? ' selected' : '') +
          '>' + x[1] + '</option>').join('') +
        (u.role === 'admin' && ME.role !== 'admin' ? '' : '') + '</select>' +
        '<button class="chip" data-tgl="' + u.id + '">' + (u.active ? '⏸' : '▶️') + '</button>';
    return '<div class="row"><div class="l"><div class="name small">' +
      esc(u.first_name + ' ' + u.last_name) +
      (u.active ? '' : ' <span class="red">(откл.)</span>') +
      '</div><div class="sub">' + (u.username ? '@' + esc(u.username) : 'id ' + u.tg_id) +
      ' • ' + (roleTitle[u.role] || u.role) +
      '</div></div><div class="r" style="display:flex;gap:6px;align-items:center">' +
      controls + '</div></div>';
  }).join('') + '</div>' +
    '<div class="card hint small">Продавец видит только своё. Кладовщик — склад, выдачи, сдачи, ' +
    'инкассации. Админ — всё, включая прибыль, расходы и наличные расчёты.</div>';
  const el = screen('Пользователи', html, true);
  el.addEventListener('change', async e => {
    const sel = e.target.closest('select[data-uid]');
    if (!sel) return;
    try {
      await api('/api/users/' + sel.dataset.uid, 'PUT', { role: sel.value });
      toast('Роль обновлена ✓', true);
    } catch (err) { toast(err.message); render(); }
  });
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-tgl]');
    if (!b) return;
    const u = r.users.find(x => x.id === +b.dataset.tgl);
    try {
      await api('/api/users/' + u.id, 'PUT', { active: u.active ? 0 : 1 });
      render();
    } catch (err) { toast(err.message); }
  });
}

async function S_settings() {
  const r = await api('/api/settings');
  const html =
    '<div class="field"><label>Доля с продаж, % (сколько продавец должен с розницы)</label>' +
    '<input id="st-share" inputmode="decimal" value="' + r.settings.share_pct + '"></div>' +
    '<div class="field"><label>Комиссия терминала, %</label>' +
    '<input id="st-comm" inputmode="decimal" value="' + r.settings.commission_pct + '"></div>' +
    '<button class="btn" id="st-save">Сохранить</button>' +
    '<div class="card hint small">Изменения действуют на новые документы. ' +
    'Уже проведённые выдачи, сдачи и инкассации не пересчитываются.</div>';
  const el = screen('Настройки', html, true);
  el.querySelector('#st-save').onclick = async () => {
    try {
      const rr = await api('/api/settings', 'PUT', {
        share_pct: pnum(el.querySelector('#st-share').value),
        commission_pct: pnum(el.querySelector('#st-comm').value),
      });
      SETTINGS = rr.settings;
      toast('Сохранено ✓', true);
      back();
    } catch (e) { toast(e.message); }
  };
}

// ===== вход =====
function S_reg(tgInfo) {
  const html =
    '<div class="card"><h3>Регистрация</h3>' +
    '<div class="hint small" style="margin-bottom:12px">Представься — так тебя будут видеть ' +
    'кладовщик и администратор.</div>' +
    '<div class="field"><label>Имя</label><input id="rg-first" value="' +
    esc(tgInfo.first_name || '') + '"></div>' +
    '<div class="field"><label>Фамилия</label><input id="rg-last" value="' +
    esc(tgInfo.last_name || '') + '"></div>' +
    '<button class="btn" id="rg-go" style="margin-bottom:0">Начать работу</button></div>';
  const el = screen('Ярмарка 🛒', html);
  el.querySelector('#rg-go').onclick = async () => {
    try {
      const r = await api('/api/register', 'POST', {
        first_name: el.querySelector('#rg-first').value,
        last_name: el.querySelector('#rg-last').value,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      });
      ME = r.user;
      SETTINGS = r.settings;
      buildNav();
    } catch (e) { toast(e.message); }
  };
}

async function boot() {
  if (tg) { tg.ready(); tg.expand(); }
  if (!DEV && !(tg && tg.initData)) {
    screen('', '<div class="card" style="text-align:center;padding:40px 20px">' +
      '<div style="font-size:40px;margin-bottom:10px">🛒</div>' +
      '<b>Это мини-приложение Telegram</b>' +
      '<div class="hint" style="margin-top:8px">Открой его через бота в Telegram.</div></div>');
    return;
  }
  try {
    const r = await api('/api/auth', 'POST',
      { tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '' });
    if (r.need_registration) { S_reg(r.tg || {}); return; }
    ME = r.user;
    SETTINGS = r.settings;
    buildNav();
  } catch (e) {
    if (e.needReg) { S_reg({}); return; }
    screen('', '<div class="card" style="text-align:center;padding:30px 20px">' +
      '<b>Не получилось войти</b><div class="hint" style="margin-top:8px">' + esc(e.message) +
      '</div></div>');
  }
}

boot();
