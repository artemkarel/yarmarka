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
    if (tg && tg.showConfirm && tg.isVersionAtLeast && tg.isVersionAtLeast('6.2')) {
      try {
        tg.showConfirm(msg, ok => res(ok));
        return;
      } catch (e) { /* клиент не поддерживает — обычный confirm */ }
    }
    res(window.confirm(msg));
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
let ANIM = null; // push | backin | tab — анимация ближайшей отрисовки экрана

function render() {
  const top = stack[stack.length - 1];
  top.fn.apply(null, top.args);
  if (tg) { if (stack.length > 1) tg.BackButton.show(); else tg.BackButton.hide(); }
}
let RESTORE_Y = null; // прокрутка, которую надо вернуть после «назад»

function push(fn) {
  // запоминаем, где стоял пользователь и как выглядел экран,
  // чтобы вернуть на то же место и показывать его под свайпом «назад»
  if (stack.length) {
    const sc = document.getElementById('screen');
    stack[stack.length - 1].scrollY = window.scrollY || 0;
    stack[stack.length - 1].html = sc ? sc.innerHTML : '';
  }
  stack.push({ fn, args: Array.prototype.slice.call(arguments, 1) });
  ANIM = 'push';
  render();
}
let backBusy = false;
function back() {
  if (backBusy || stack.length < 2) return;
  backBusy = true;
  const sc = document.getElementById('screen');
  sc.style.transition = 'transform .2s ease, opacity .2s ease';
  sc.style.transform = 'translateX(100%)';
  sc.style.opacity = '0.4';
  setTimeout(() => {
    sc.style.transition = '';
    sc.style.transform = '';
    sc.style.opacity = '';
    stack.pop();
    RESTORE_Y = stack[stack.length - 1].scrollY || 0;
    ANIM = 'backin';
    render();
    backBusy = false;
  }, 190);
}
window.back = back;
if (tg) tg.BackButton.onClick(back);

// клавиатура не должна мешать: прокрутка списка или Enter закрывают её
document.addEventListener('touchmove', e => {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && e.target !== a) a.blur();
}, { passive: true });
document.addEventListener('keydown', e => {
  const a = document.activeElement;
  if (e.key === 'Enter' && a && a.tagName === 'INPUT') a.blur();
});

function setTab(fn, idx) {
  stack = [{ fn, args: [] }];
  ANIM = 'tab';
  render();
  document.querySelectorAll('#nav button').forEach((b, i) => b.classList.toggle('on', i === idx));
  const ind = document.querySelector('#nav .ind');
  if (ind) ind.style.transform = 'translateX(' + idx * 100 + '%)';
}

function screen(title, html, sub) {
  // пересоздаём контейнер: старые обработчики уходят вместе с прежним узлом,
  // иначе они копятся и каждый тап срабатывает по несколько раз
  const old = document.getElementById('screen');
  const el = old.cloneNode(false);
  old.replaceWith(el);
  const head = sub
    ? '<div class="subhead"><button class="backbtn" onclick="back()">‹</button>' +
      '<div class="subtitle">' + esc(title) + '</div></div>'
    : (title ? '<div class="pagetitle">' + esc(title) + '</div>' : '');
  el.innerHTML = head + html;
  if (ANIM) {
    void el.offsetWidth;
    el.classList.add('anim-' + ANIM);
    ANIM = null;
  }
  if (RESTORE_Y != null) {
    const y = RESTORE_Y;
    RESTORE_Y = null;
    requestAnimationFrame(() => window.scrollTo(0, y));
  } else {
    window.scrollTo(0, 0);
  }
  return el;
}

// свайп слева направо — назад: экран (вместе с шапкой) едет за пальцем,
// а под ним проглядывает предыдущий экран
(function () {
  const sc = () => document.getElementById('screen');
  let t0 = null;
  let under = null;

  function makeUnder() {
    const prev = stack[stack.length - 2];
    if (!prev || !prev.html) return;
    const el = sc();
    under = document.createElement('div');
    under.id = 'screen-under';
    under.style.cssText = 'position:absolute; left:' + el.offsetLeft + 'px; width:' +
      el.offsetWidth + 'px; top:' + el.offsetTop + 'px; bottom:0; overflow:hidden; ' +
      'z-index:0; pointer-events:none; opacity:.9; transform:translateX(-24%);';
    under.innerHTML = '<div style="transform:translateY(-' + (prev.scrollY || 0) + 'px)">' +
      prev.html + '</div>';
    el.parentElement.insertBefore(under, el);
    el.classList.add('dragging');
  }

  function dropUnder(delay) {
    const u = under;
    under = null;
    setTimeout(() => {
      if (u) u.remove();
      const el = sc();
      if (el) el.classList.remove('dragging');
    }, delay || 0);
  }

  function finish(dxRaw) {
    const el = sc();
    const dx = dxRaw || 0;
    const dt = Date.now() - (t0.t || Date.now());
    const speed = dt > 0 ? dx / dt : 0; // px/ms
    t0 = null;
    const ok = dx > 70 || (dx > 30 && speed > 0.45);
    if (ok && !backBusy) {
      backBusy = true;
      el.style.transition = 'transform .16s ease';
      el.style.transform = 'translateX(100%)';
      if (under) {
        under.style.transition = 'transform .16s ease, opacity .16s ease';
        under.style.transform = 'translateX(0)';
        under.style.opacity = '1';
      }
      setTimeout(() => {
        el.style.transition = '';
        el.style.transform = '';
        stack.pop();
        RESTORE_Y = stack[stack.length - 1].scrollY || 0;
        ANIM = null; // подложка уже показала предыдущий экран — без второй анимации
        render();
        dropUnder(40);
        backBusy = false;
        if (tg) { if (stack.length > 1) tg.BackButton.show(); else tg.BackButton.hide(); }
      }, 150);
    } else {
      el.style.transition = 'transform .18s ease';
      el.style.transform = 'translateX(0)';
      if (under) {
        under.style.transition = 'transform .18s ease';
        under.style.transform = 'translateX(-24%)';
      }
      dropUnder(200);
      setTimeout(() => { el.style.transition = ''; el.style.transform = ''; }, 200);
    }
  }

  document.addEventListener('touchstart', e => {
    t0 = null;
    if (stack.length < 2 || backBusy) return;
    // горизонтальным лентам (календарь, чипсы) не мешаем
    if (e.target.closest('.dstrip, .chips')) return;
    const t = e.touches[0];
    // жест — строго от левой кромки экрана, поверх любых элементов;
    // обычный тап не страдает: жест включается только после уверенного сдвига
    if (t.clientX <= 32) {
      t0 = { x: t.clientX, y: t.clientY, drag: false, dead: false, dx: 0, t: Date.now() };
    }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!t0 || t0.dead) return;
    const t = e.touches[0];
    const dx = t.clientX - t0.x, dy = t.clientY - t0.y;
    if (!t0.drag) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { t0.dead = true; return; }
      // жест признаём только при уверенном горизонтальном движении,
      // чтобы обычный тап с лёгким сдвигом пальца оставался кликом
      if (dx > 16 && dx > Math.abs(dy) * 1.3) t0.drag = true;
      else return;
    }
    if (e.cancelable) e.preventDefault(); // жест наш — не отдаём его прокрутке
    const el = sc();
    if (!under && t0.drag) makeUnder();
    el.style.transition = 'none';
    el.style.transform = 'translateX(' + Math.max(0, dx) + 'px)';
    if (under) {
      const prog = Math.min(1, Math.max(0, dx / el.offsetWidth));
      under.style.transform = 'translateX(' + (-24 + 24 * prog) + '%)';
      under.style.opacity = String(0.85 + 0.15 * prog);
    }
    t0.dx = dx;
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!t0) return;
    if (!t0.drag) { t0 = null; return; }
    finish(t0.dx);
  }, { passive: true });

  document.addEventListener('touchcancel', () => {
    // систему перехватило — всё равно решаем по пройденному пути
    if (!t0) return;
    if (!t0.drag) { t0 = null; return; }
    finish(t0.dx);
  }, { passive: true });
})();


// строгие иконки нижнего меню (SVG, цвет наследуется)
const NAV_ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16 15.2c2.6.2 4.6 1.8 5.3 4.3"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-5.8-7-11a7 7 0 0 1 14 0c0 5.2-7 11-7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg>',
};

function buildNav() {
  const ownerish = ME.role === 'admin' || ME.role === 'owner';
  let items;
  if (ME.role === 'seller') {
    items = [['home', 'Главная', S_home], ['box', 'Склад', S_skladView],
             ['pin', 'Точки', S_places], ['chart', 'Аналитика', S_turnover],
             ['menu', 'Ещё', S_more]];
  } else if (ME.role === 'keeper') {
    items = [['box', 'Склад', S_sklad], ['people', 'Реализация', S_sellers],
             ['chart', 'Аналитика', S_analytics], ['menu', 'Ещё', S_more]];
  } else {
    items = [['box', 'Склад', S_sklad], ['people', 'Реализация', S_sellers],
             ['pin', 'Точки', S_places], ['chart', 'Аналитика', S_analytics],
             ['menu', 'Ещё', S_more]];
  }
  const nav = document.getElementById('nav');
  nav.innerHTML = '<div class="ind" style="width:calc((100% - 8px)/' + items.length +
    ')"></div>' +
    items.map(it =>
      '<button><span class="ico">' + (NAV_ICONS[it[0]] || '') + '</span>' + it[1] +
      '</button>').join('');
  nav.hidden = false;
  nav.querySelectorAll('button').forEach((b, i) => {
    b.onclick = () => setTab(items[i][2], i);
  });
  setTab(items[0][2], 0);
}

// ===== общие блоки =====
function balanceHtml(b, self) {
  // нам должны — зелёным, мы должны — красным
  let big, cls;
  if (b.balance > 0.005) {
    big = self ? 'Ты должен компании' : 'Должен компании';
    cls = 'green';
  } else if (b.balance < -0.005) {
    big = self ? 'Компания должна тебе' : 'Компания должна';
    cls = 'red';
  } else { big = 'Расчёт закрыт'; cls = ''; }
  const row = (l, v, c) => '<div class="row"><div class="l hint">' + l +
    '</div><div class="r val ' + (c || '') + '">' + v + '</div></div>';
  return '<div class="card">' +
    '<div class="biglabel">' + big + '</div>' +
    '<div class="bignum ' + cls + '">' + fmtM(Math.abs(b.balance)) + '</div>' +
    '<div style="margin-top:10px">' +
    row('Взял товара на', fmtM(b.taken_value)) +
    row('Продал на', fmtM(b.sold_value)) +
    row('Начислено (' + SETTINGS.share_pct + '%)', '+ ' + fmtM(b.charged)) +
    row('Возврат товара', '− ' + fmtM(b.returned_credit)) +
    row('Терминал (пробито ' + fmtM(b.terminal_raw) + ')', '− ' + fmtM(b.terminal_credit)) +
    (Math.abs(b.cash_total) > 0.005
      ? row('Наличными', (b.cash_total >= 0 ? '− ' : '+ ') + fmtM(Math.abs(b.cash_total)))
      : '') +
    '<div class="row total"><div class="l">' + big + '</div><div class="r ' + cls + '">' +
    fmtM(Math.abs(b.balance)) + '</div></div>' +
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
  prihod: ['📥', 'Поступление'], initial: ['📋', 'Нач. остатки'],
  inventory: ['🔍', 'Инвентаризация'], vydacha: ['🚚', 'Выдача'], sdacha: ['↩️', 'Приём товара'],
  incass: ['💳', 'Инкассация'], cash: ['💵', 'Наличные'], writeoff: ['📉', 'Списание'],
  surplus: ['📈', 'Оприходование'], price_change: ['🏷', 'Смена цен'],
  transfer_out: ['📤', 'Передача (отдал)'], transfer_in: ['📥', 'Передача (принял)'],
};

function statusBadge(d) {
  if (d.status === 'draft') return ' <span class="badge draft">Черновик</span>';
  if (d.status === 'void') return ' <span class="badge void">Отменён</span>';
  return ' <span class="badge posted">✓ проведён</span>';
}

// единый стиль меню: карточка со строками «иконка название ›»
function menuTiles(items) {
  return '<div class="tilemenu">' + items.map(it =>
    '<button class="tilebtn" data-menu="' + it[0] + '"' +
    (it[3] ? ' style="grid-column:span 2"' : '') + '><span class="tico">' + it[1] +
    '</span>' + it[2] + '</button>').join('') + '</div>';
}

function bindMenu(el, handlers) {
  el.addEventListener('click', e => {
    const m = e.target.closest('[data-menu]');
    if (m && handlers[m.dataset.menu]) handlers[m.dataset.menu]();
  });
}

function docCard(d, showSeller, canManage) {
  const meta = DOC_META[d.type] || ['📄', d.type];
  let sum = '';
  if (d.type === 'prihod') sum = 'на ' + fmtM(d.amount) + ' по ценам продажи' +
    (d.supplier_name ? ' • ' + esc(d.supplier_name) : '');
  else if (d.type === 'vydacha') sum = fmtM(d.amount) + ' • долг +' + fmtM(d.money);
  else if (d.type === 'sdacha') sum = 'продано на ' + fmtM(d.amount) + ' • зачтено ' + fmtM(-d.money);
  else if (d.type === 'incass') sum = 'терминал ' + fmtM(d.amount) + ' → зачёт ' + fmtM(-d.money);
  else if (d.type === 'cash') sum = d.amount >= 0
    ? 'получено ' + fmtM(d.amount) : 'выдано продавцу ' + fmtM(-d.amount);
  else if (d.type === 'inventory') sum = 'результат ' + fmtM(d.amount) + ' по себестоимости';
  else if (d.type === 'initial') sum = 'введены остатки';
  else if (d.type === 'writeoff') sum = 'недостача ' + fmtM(d.amount);
  else if (d.type === 'surplus') sum = 'излишки ' + fmtM(d.amount);
  else if (d.type === 'price_change') sum = 'обновлены цены продажи';
  else if (d.type === 'transfer_out' || d.type === 'transfer_in') {
    sum = 'товара на ' + fmtM(d.amount) + ' • долг ' +
      (d.money >= 0 ? '+' : '−') + fmtM(Math.abs(d.money));
  }
  const who = (showSeller && d.seller_name) ? esc(d.seller_name) + ' • ' : '';
  const docName = meta[1] + ' от ' + dstr(d.date);
  let controls = '';
  if (canManage) {
    if (d.status === 'draft') {
      controls =
        ' <button class="chip" style="padding:4px 9px" data-docpost="' + d.id +
        '" data-docname="' + docName + '">▶️</button>' +
        ' <button class="chip" style="padding:4px 9px" data-docdel="' + d.id +
        '" data-docname="' + docName + '">🗑</button>';
    } else if (d.status === 'posted' && d.type !== 'price_change') {
      controls = ' <button class="chip" style="padding:4px 9px" data-docvoid="' + d.id +
        '" data-docname="' + docName + '">↩️</button>';
    }
  }
  return '<details class="doc' + (d.status === 'void' ? ' voided' : '') +
    '" ontoggle="onDocToggle(event,' + d.id + ')">' +
    '<summary><div class="dochead"><div><b>' + meta[0] + ' ' + meta[1] + '</b>' +
    statusBadge(d) + '</div>' +
    '<div class="dt">' + dstr(d.date) + controls + '</div></div>' +
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
    } else if (doc.type === 'price_change') {
      txt = esc(l.name) + ': ' + fmtM(l.purchase_price) + ' → <b>' +
        fmtM(l.retail_price) + '</b>';
    } else if (doc.type === 'transfer_out' || doc.type === 'transfer_in') {
      txt = esc(l.name) + ' — ' + fmtQ(l.qty, l.unit);
    } else if (doc.type === 'writeoff' || doc.type === 'surplus') {
      txt = esc(l.name) + ' — ' + fmtQ(l.qty, l.unit) + ' × ' + fmtM(l.purchase_price) +
        ' = ' + fmtM(l.qty * l.purchase_price);
    }
    return '<div class="row small">' + txt + '</div>';
  }).join('') +
  ((doc.chain || []).length
    ? '<div style="padding:8px 0 2px" class="hint small"><b>🔗 Цепочка документов:</b></div>' +
      doc.chain.map(c => {
        const m = DOC_META[c.type] || ['📄', c.type];
        return '<button class="chip" style="margin:2px 4px 2px 0" data-chainopen="' + c.id +
          '">' + (c.rel === 'parent' ? '⬆️ ' : '⬇️ ') + m[1] + ' от ' + dstr(c.date) +
          (c.status === 'void' ? ' (отменён)' : '') + '</button>';
      }).join('')
    : '') +
  (doc.type === 'inventory'
    ? '<div style="padding:8px 0"><button class="chip" onclick="openInvReport(' + doc.id +
      ')">📑 Отчёт о расхождениях</button></div>' : '') +
  (doc.type === 'vydacha' && doc.print_url
    ? '<div style="padding:8px 0"><button class="chip" data-print="' + esc(doc.print_url) +
      '">🖨 УПД — печать / PDF</button></div>' : '');
}

window.openInvReport = id => push(S_invReport, id);

function openExternal(url) {
  const abs = location.origin + url;
  if (tg && tg.openLink) tg.openLink(abs);
  else window.open(abs, '_blank');
}

document.addEventListener('click', e => {
  const pr = e.target.closest('[data-print]');
  if (pr) { e.preventDefault(); openExternal(pr.dataset.print); return; }
  const ch = e.target.closest('[data-chainopen]');
  if (ch) { e.preventDefault(); push(S_docView, +ch.dataset.chainopen); }
});

// просмотр одного документа (по клику из цепочки)
async function S_docView(id) {
  const d = (await api('/api/docs/' + id)).doc;
  const meta = DOC_META[d.type] || ['📄', d.type];
  const html = '<div class="card">' +
    '<div class="dochead"><div><b>' + meta[0] + ' ' + meta[1] + '</b>' + statusBadge(d) +
    '</div><div class="dt">' + dstr(d.date) + '</div></div>' +
    (d.seller_name ? '<div class="sub hint small">' + esc(d.seller_name) + '</div>' : '') +
    '<div style="margin-top:8px">' + docLinesHtml(d) + '</div></div>';
  screen(meta[1], html, true);
}

// живой поиск товара: печатаешь название — снизу предлагаются позиции
function attachProductSearch(el, products, opts) {
  const inp = el.querySelector('#' + opts.input);
  const box = el.querySelector('#' + opts.box);
  const draw = () => {
    const q = inp.value.toLowerCase().trim();
    if (!q) { box.innerHTML = ''; box.hidden = true; return; }
    const items = products.filter(p => !p.archived &&
      (p.name.toLowerCase().includes(q) || (p.group_name || '').toLowerCase().includes(q)))
      .slice(0, 25);
    box.hidden = false;
    box.innerHTML = items.length ? items.map(p => {
      const dis = opts.disabled && opts.disabled(p);
      return '<div class="row' + (dis ? ' psdis' : '') + '" data-ps="' + p.id + '">' +
        '<div class="l"><div class="name small">' + esc(p.name) + '</div>' +
        '<div class="sub">' + opts.sub(p) + (dis ? ' • <span class="red">нет на складе</span>' : '') +
        '</div></div>' + (dis ? '' : '<div class="r val" style="font-size:20px">+</div>') +
        '</div>';
    }).join('')
      : '<div class="hint small" style="padding:10px 0">Ничего не найдено</div>';
  };
  inp.addEventListener('input', draw);
  box.addEventListener('click', e => {
    const c = e.target.closest('[data-ps]');
    if (!c || c.classList.contains('psdis')) return;
    const p = products.find(x => x.id === +c.dataset.ps);
    inp.value = '';
    box.innerHTML = '';
    box.hidden = true;
    opts.pick(p);
  });
}

function productSearchHtml(input, box, placeholder) {
  return '<div class="field"><input id="' + input + '" placeholder="' +
    (placeholder || '🔍 Начни вводить название товара…') + '" autocomplete="off"></div>' +
    '<div class="card" id="' + box + '" hidden style="padding:4px 14px"></div>';
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
  const el = screen('', html);
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
  const el = screen('', html);
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
  const mine = r.sellers.find(s => s.seller_id === ME.id) || { sold_value: 0, sold_kg: 0 };
  const medals = ['🥇', '🥈', '🥉'];
  const html = chips.html +
    '<div class="card"><h3>📈 Моя аналитика</h3>' +
    '<div class="biglabel">Мой оборот за период</div>' +
    '<div class="bignum">' + fmtM(mine.sold_value) + '</div>' +
    (mine.sold_kg > 0
      ? '<div class="sub hint">' + fmtQ(mine.sold_kg, 'кг') + ' продано</div>' : '') +
    '</div>' +
    '<div class="card"><h3>🏆 Рейтинг компании</h3>' +
    (r.sellers.length ? r.sellers.map((s, i) => {
      const my = s.seller_id === ME.id;
      return '<div class="row"><div class="l"><div class="name' +
        (my ? '" style="color:var(--accent)' : '') + '">' +
        (medals[i] || (i + 1) + '.') + ' ' + esc(s.name) + (my ? ' (ты)' : '') + '</div>' +
        (s.sold_kg > 0 ? '<div class="sub">' + fmtQ(s.sold_kg, 'кг') + '</div>' : '') +
        '</div><div class="r val">' + fmtM(s.sold_value) + '</div></div>';
    }).join('') +
      '<div class="row total"><div class="l">Вся компания</div><div class="r">' + fmtM(r.total) +
      '</div></div>'
      : '<div class="hint small">Продаж за период нет</div>') + '</div>';
  const el = screen('', html);
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
      rows += '<div class="hint small skgroup" style="margin:10px 4px 2px;font-weight:700">' +
        esc(p.group_name || 'Без группы') + '</div>';
    }
    rows += '<div class="row skrow" data-name="' + esc(p.name.toLowerCase()) + '">' +
      '<div class="l"><div class="name">' + esc(p.name) + '</div>' +
      '<div class="sub">сумма продажи ' + fmtM(p.retail_value) + ' • себестоимость ' +
      fmtM(p.purchase_value) + '</div></div>' +
      '<div class="r val">' + fmtQ(p.qty, p.unit) + '</div></div>';
  });
  const onSellers = await api('/api/analytics/on_sellers');
  const shelfSellers = onSellers.sellers.filter(s => s.shelf.length);
  const shelf = shelfSellers.length
    ? '<div class="card"><h3>🧺 На полках продавцов</h3>' + shelfSellers.map((s, i) =>
      '<details class="doc"><summary><div class="dochead"><div><b>' + (i + 1) + '. ' +
      esc(s.name) + '</b></div><div class="dt">' + fmtM(s.shelf_value) + '</div></div>' +
      '<div class="sub hint small">' + fmtQ(
        s.shelf.reduce((a, x) => a + (x.unit === 'кг' ? x.qty : 0), 0), 'кг') +
      ' • позиций: ' + s.shelf.length + '</div></summary>' +
      '<div class="doclines small">' + s.shelf.map(h =>
        '<div class="row small"><div class="l">' + esc(h.name) + '</div><div class="r">' +
        fmtQ(h.qty, h.unit) + ' • ' + fmtM(h.value) + '</div></div>').join('') +
      '</div></details>').join('') + '</div>'
    : '';
  const html =
    '<div class="tiles">' +
    '<div class="tile"><div class="tl">Всего кг</div><div class="tv">' + NF3.format(t.kg) + '</div></div>' +
    '<div class="tile"><div class="tl">Себестоимость</div><div class="tv">' + fmtM(t.purchase_value) + '</div></div>' +
    '<div class="tile"><div class="tl">Сумма продаж</div><div class="tv">' + fmtM(t.retail_value) + '</div></div>' +
    '</div>' +
    menuTiles([
      ['prihod', '📥', 'Поступление товара', true],
      ['inv', '🔍', 'Инвентаризация'],
      ['init', '📋', 'Начальные остатки'],
    ]) +
    '<div class="field"><input id="sk-q" placeholder="🔍 Поиск по остаткам…"></div>' +
    '<div class="card"><h3>Остатки на складе</h3>' +
    (rows || '<div class="hint small">Склад пуст. Добавь поступление или начальные остатки.</div>') +
    '</div>' + shelf;
  const el = screen('', html);
  bindMenu(el, {
    prihod: () => push(S_prihod),
    inv: () => push(S_invStart),
    init: () => push(S_countSheet, 'initial'),
  });
  el.querySelector('#sk-q').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    el.querySelectorAll('.skrow').forEach(row => {
      row.style.display = !q || row.dataset.name.includes(q) ? '' : 'none';
    });
    el.querySelectorAll('.skgroup').forEach(g => { g.style.display = q ? 'none' : ''; });
  });
}

// выбор сотрудника для выдачи или приёма товара
async function S_chooseSeller(mode) {
  const forSdacha = mode === 'sdacha';
  const r = await api('/api/sellers');
  const sellers = forSdacha ? r.sellers.filter(s => s.hands_value > 0.005) : r.sellers;
  const hint = forSdacha ? 'От кого принимаем товар?' : 'Кому выдаём товар под реализацию?';
  const html = sellers.length
    ? '<div class="card hint small">' + hint + '</div>' +
      sellers.map(s =>
        '<div class="card" data-pick="' + s.id + '" style="cursor:pointer">' +
        '<div class="row" style="border:none;padding:2px 0"><div class="l">' +
        '<div class="name">' + esc(s.name) + '</div>' +
        '<div class="sub">на руках на ' + fmtM(s.hands_value) + '</div></div>' +
        '<div class="r hint">›</div></div></div>').join('')
    : '<div class="card hint">' + (forSdacha
        ? 'Ни у кого нет товара на руках — принимать нечего.'
        : 'Продавцов пока нет — они появятся после регистрации в боте.') + '</div>';
  const el = screen(forSdacha ? 'Приём товара' : 'Кому выдать', html, true);
  el.addEventListener('click', e => {
    const c = e.target.closest('[data-pick]');
    if (!c) return;
    stack.pop(); // после операции «назад» вернёт сразу на склад
    push(forSdacha ? S_sdacha : S_vydacha, +c.dataset.pick);
  });
}

async function S_prihod() {
  const products = await getProducts(true);
  const sup = (await api('/api/suppliers')).suppliers;
  const lines = [];
  const html =
    '<div class="grid2" style="margin-bottom:10px">' +
    '<div class="field" style="margin:0"><label>Дата</label>' +
    '<input type="date" id="pr-date" value="' + today() + '"></div>' +
    '<div class="field" style="margin:0"><label>Поставщик</label>' +
    '<input id="pr-sup" list="pr-sup-dl" placeholder="Поиск или выбор…" autocomplete="off">' +
    '<datalist id="pr-sup-dl">' +
    sup.map(s => '<option value="' + esc(s.name) + '">').join('') + '</datalist></div></div>' +
    productSearchHtml('pr-search', 'pr-sug') +
    '<div id="pr-lines"></div>' +
    '<button class="chip" id="pr-more" hidden style="margin-bottom:10px">+ Добавить строку</button>' +
    '<div class="card" id="pr-total" hidden></div>' +
    '<button class="btn" id="pr-save">Провести поступление</button>' +
    '<button class="btn secondary" id="pr-draft">💾 Сохранить черновик</button>';
  const el = screen('Поступление товара', html, true);
  const linesEl = el.querySelector('#pr-lines');

  const totals = () => {
    let pv = 0, any = false;
    lines.forEach(l => {
      const q = pnum(l.qty);
      if (q > 0) { any = true; pv += q * pnum(l.price); }
    });
    const tEl = el.querySelector('#pr-total');
    tEl.hidden = !any;
    tEl.innerHTML = '<div class="row"><div class="l hint">Итого по себестоимости</div>' +
      '<div class="r val">' + fmtM(pv) + '</div></div>';
    el.querySelector('#pr-more').hidden = !lines.length;
  };
  const draw = () => {
    linesEl.innerHTML = lines.map((l, i) =>
      '<div class="line"><div class="linehead"><div style="flex:1"><div class="name">' +
      (i + 1) + '. ' + esc(l.product.name) + '</div>' +
      '<div class="sub hint small">себестоимость ' + fmtM(l.product.purchase_price) +
      '</div></div>' +
      '<button class="rm" data-i="' + i + '">✕</button></div>' +
      '<div class="grid2">' +
      '<div class="field" style="margin:0"><label>Себестоимость, ₽/' + l.product.unit +
      '</label><input inputmode="decimal" class="pin" data-i="' + i + '" value="' +
      esc(l.price) + '"></div>' +
      '<div class="field" style="margin:0"><label>Количество, ' + l.product.unit + '</label>' +
      '<input inputmode="decimal" class="qin" data-i="' + i + '" value="' + esc(l.qty) + '"></div>' +
      '</div></div>').join('');
    totals();
  };
  linesEl.addEventListener('input', e => {
    const i = +e.target.dataset.i;
    if (e.target.classList.contains('qin')) { lines[i].qty = e.target.value; totals(); }
    if (e.target.classList.contains('pin')) { lines[i].price = e.target.value; totals(); }
  });
  linesEl.addEventListener('click', e => {
    const rm = e.target.closest('.rm');
    if (rm) { lines.splice(+rm.dataset.i, 1); draw(); }
  });
  attachProductSearch(el, products, {
    input: 'pr-search', box: 'pr-sug',
    sub: p => 'остаток ' + fmtQ(p.stock_qty, p.unit) + ' • себестоимость ' +
      fmtM(p.purchase_price),
    pick: p => {
      if (lines.some(l => l.product.id === p.id)) return toast('Уже в списке');
      lines.push({ product: p, qty: '', price: String(p.purchase_price || '') });
      draw();
    },
  });
  el.querySelector('#pr-more').onclick = () => {
    const s = el.querySelector('#pr-search');
    s.scrollIntoView({ block: 'center' });
    s.focus();
  };
  const saveProc = async draft => {
    const out = lines.map(l => ({
      product_id: l.product.id, qty: pnum(l.qty), purchase_price: pnum(l.price),
    })).filter(l => l.qty > 0);
    if (!out.length) return toast('Добавь позиции и количество');
    // поставщик: ищем по имени, при новом имени предлагаем создать
    let supplierId;
    const supName = el.querySelector('#pr-sup').value.trim();
    if (supName) {
      const found = sup.find(s => s.name.toLowerCase() === supName.toLowerCase());
      if (found) supplierId = found.id;
      else {
        if (!(await confirmDlg('Добавить нового поставщика «' + supName + '»?'))) return;
        try {
          supplierId = (await api('/api/suppliers', 'POST', { name: supName })).supplier.id;
        } catch (e) { return toast(e.message); }
      }
    }
    try {
      await api('/api/docs/prihod', 'POST', {
        date: el.querySelector('#pr-date').value,
        supplier_id: supplierId,
        lines: out,
        draft: draft || undefined,
      });
      toast(draft ? 'Черновик сохранён — он в «Документах» ✓'
        : 'Поступление проведено ✓', true);
      PRODUCTS_CACHE = null;
      back();
    } catch (e) { toast(e.message); }
  };
  el.querySelector('#pr-save').onclick = () => saveProc(false);
  el.querySelector('#pr-draft').onclick = () => saveProc(true);
}

// инвентаризация как процесс: Ведомость (черновик) → Подсчёт → Проведение,
// при проведении система сама создаёт Списание (недостачи) и Оприходование (излишки)
async function S_invStart() {
  const r = await api('/api/docs?type=inventory&limit=50');
  const draft = r.docs.find(d => d.status === 'draft');
  if (draft) {
    stack.pop();
    push(S_invCount, draft.id);
    return;
  }
  try {
    const created = await api('/api/docs/inventory', 'POST', { lines: [] });
    toast('Создана ведомость — вноси подсчёт', true);
    stack.pop();
    push(S_invCount, created.doc.id);
  } catch (e) { toast(e.message); back(); }
}

async function S_invCount(docId) {
  const [d, products] = await Promise.all([
    api('/api/docs/' + docId), getProducts(true),
  ]);
  const facts = {};
  d.doc.lines.forEach(l => { facts[l.product_id] = l.qty; });
  const rows = products.filter(p => !p.archived).map((p, i) =>
    '<div class="row prow" data-name="' + esc(p.name.toLowerCase()) + '">' +
    '<div class="l" style="flex:1"><div class="name small">' + (i + 1) + '. ' + esc(p.name) +
    '</div><div class="sub">учёт: ' + fmtQ(p.stock_qty, p.unit) + '</div></div>' +
    '<div class="r" style="width:104px"><input inputmode="decimal" class="fin" data-pid="' +
    p.id + '" value="' + (facts[p.id] != null ? facts[p.id] : '') +
    '" placeholder="факт"></div></div>').join('');
  const html =
    '<div class="card hint small">Ведомость №' + docId + ' (черновик). Считай в несколько ' +
    'заходов: вноси факты и жми «Сохранить подсчёт». Остатки не меняются до проведения. ' +
    'Пустые поля при проведении не трогаются.</div>' +
    '<div class="field"><input id="ic-q" placeholder="🔍 Поиск товара…"></div>' +
    '<div class="card">' + rows + '</div>' +
    '<button class="btn secondary" id="ic-save">💾 Сохранить подсчёт</button>' +
    '<button class="btn" id="ic-post">Провести ведомость</button>';
  const el = screen('Инвентаризация', html, true);
  el.querySelector('#ic-q').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    el.querySelectorAll('.prow').forEach(row => {
      row.style.display = !q || row.dataset.name.includes(q) ? '' : 'none';
    });
  });
  const collect = () => {
    const lines = [];
    el.querySelectorAll('.fin').forEach(inp => {
      if (inp.value.trim() !== '') {
        lines.push({ product_id: +inp.dataset.pid, qty: pnum(inp.value) });
      }
    });
    return lines;
  };
  el.querySelector('#ic-save').onclick = async () => {
    const lines = collect();
    if (!lines.length) return toast('Внеси хотя бы один факт');
    try {
      await api('/api/docs/' + docId + '/lines', 'PUT', { lines });
      toast('Подсчёт сохранён (' + lines.length + ' поз.) ✓', true);
    } catch (e) { toast(e.message); }
  };
  el.querySelector('#ic-post').onclick = async () => {
    const lines = collect();
    if (!lines.length) return toast('Сначала внеси подсчёт');
    if (!(await confirmDlg('Провести ведомость (' + lines.length + ' поз.)? Система создаст ' +
      'списание недостач и оприходование излишков.'))) return;
    try {
      await api('/api/docs/' + docId + '/lines', 'PUT', { lines });
      await api('/api/docs/' + docId + '/post', 'POST');
      toast('Инвентаризация проведена ✓', true);
      PRODUCTS_CACHE = null;
      stack.pop();
      push(S_invReport, docId);
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
      const r = await api('/api/docs/' + kind, 'POST',
        { date: el.querySelector('#cs-date').value, lines });
      toast(isInv ? 'Инвентаризация проведена ✓' : 'Остатки сохранены ✓', true);
      PRODUCTS_CACHE = null;
      if (isInv) {
        // сразу показываем отчёт о расхождениях; «назад» вернёт на склад
        stack.pop();
        push(S_invReport, r.doc.id);
      } else {
        back();
      }
    } catch (e) { toast(e.message); }
  };
}

// ===== продавцы =====
async function S_sellers() {
  const r = await api('/api/sellers');
  const html = r.sellers.length ? r.sellers.map(s => {
    const bal = s.balance > 0.005
      ? '<span class="green">должен за товар ' + fmtM(s.balance) + '</span>'
      : s.balance < -0.005
        ? '<span class="red">компания должна ' + fmtM(-s.balance) + '</span>'
        : '<span class="hint">должен за товар 0 ₽</span>';
    return '<div class="card" data-sid="' + s.id + '" style="cursor:pointer">' +
      '<div class="row" style="border:none;padding:2px 0"><div class="l">' +
      '<div class="name">' + esc(s.name) + '</div>' +
      '<div class="sub">Товара на руках на ' + fmtM(s.hands_value) +
      (s.shelf_value > 0 ? ' • полка ' + fmtM(s.shelf_value) : '') + '</div></div>' +
      '<div class="r">' + bal + '</div></div></div>';
  }).join('')
    : '<div class="card hint">Продавцов пока нет. Они появятся после регистрации в боте.</div>';
  const el = screen('', html);
  el.addEventListener('click', e => {
    const c = e.target.closest('[data-sid]');
    if (c) push(S_seller, +c.dataset.sid);
  });
}

async function S_seller(sid) {
  const r = await api('/api/sellers/' + sid);
  const admin = ME.role === 'admin' || ME.role === 'owner';
  const bal = r.balance.balance;
  const settleBtn = admin && Math.abs(bal) > 0.005
    ? '<button class="btn secondary" id="a-settle">💵 Рассчитаться наличными: ' +
      (bal > 0 ? 'получить ' : 'выдать ') + fmtM(Math.abs(bal)) + '</button>'
    : '';
  const html =
    balanceHtml(r.balance, false) +
    '<div class="btnrow">' +
    '<button class="btn" id="a-vyd">🚚 Выдать товар</button>' +
    '<button class="btn" id="a-sd">↩️ Принять товар</button></div>' +
    '<div class="btnrow">' +
    '<button class="btn secondary" id="a-inc">💳 Внести инкассацию</button>' +
    '<button class="btn secondary" id="a-move">🔁 Передать товар</button></div>' +
    settleBtn +
    stockListHtml(r.stock.hands, '🚚 На руках') +
    stockListHtml(r.stock.shelf, '🧺 На полке') +
    '<div class="card"><h3>Последние операции</h3>' +
    (r.docs.length ? r.docs.map(d => docCard(d, false)).join('')
      : '<div class="hint small">Пока нет</div>') + '</div>';
  const el = screen(r.seller.name, html, true);
  el.querySelector('#a-vyd').onclick = () => push(S_vydacha, sid);
  el.querySelector('#a-sd').onclick = () => push(S_sdacha, sid);
  el.querySelector('#a-inc').onclick = () => push(S_incass, sid);
  el.querySelector('#a-move').onclick = () => push(S_transfer, sid);
  const settle = el.querySelector('#a-settle');
  if (settle) settle.onclick = async () => {
    const msg = bal > 0
      ? 'Получить от продавца наличными ' + fmtM(bal) + ' и закрыть расчёт?'
      : 'Выдать продавцу наличными ' + fmtM(-bal) + ' и закрыть расчёт?';
    if (!(await confirmDlg(msg))) return;
    try {
      // сумма формируется автоматически из текущего баланса
      await api('/api/docs/cash', 'POST', { seller_id: sid, amount: bal });
      toast('Расчёт закрыт ✓', true);
      render();
    } catch (e) { toast(e.message); }
  };
}

async function S_vydacha(sid) {
  const products = await getProducts(true);
  const info = await api('/api/sellers/' + sid);
  const shelfMap = {};
  info.stock.shelf.forEach(s => { shelfMap[s.product_id] = s.qty; });
  const lines = [];
  const html =
    '<div class="field"><label>Дата</label><input type="date" id="v-date" value="' + today() + '"></div>' +
    productSearchHtml('v-search', 'v-sug') +
    '<div id="v-lines"></div>' +
    '<div class="card" id="v-total" hidden></div>' +
    '<button class="btn" id="v-save">Выдать товар</button>' +
    '<button class="btn secondary" id="v-draft">💾 Сохранить черновик</button>';
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
      '<div class="row"><div class="l hint">Товара по ценам продажи</div><div class="r val">' +
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
  attachProductSearch(el, products, {
    input: 'v-search', box: 'v-sug',
    sub: p => 'склад ' + fmtQ(p.stock_qty, p.unit) +
      (shelfMap[p.id] ? ' • полка ' + fmtQ(shelfMap[p.id], p.unit) : '') +
      ' • ' + fmtM(p.retail_price) + '/' + p.unit,
    disabled: p => !(p.stock_qty > 0.0005 || shelfMap[p.id] > 0.0005),
    pick: p => {
      if (lines.some(l => l.product.id === p.id)) return toast('Уже в списке');
      lines.push({ product: p, qty_wh: '', qty_shelf: '' });
      draw();
    },
  });
  const saveVyd = async draft => {
    const out = lines.map(l => ({
      product_id: l.product.id, qty_wh: pnum(l.qty_wh), qty_shelf: pnum(l.qty_shelf),
    })).filter(l => l.qty_wh > 0 || l.qty_shelf > 0);
    if (!out.length) return toast('Добавь позиции и количество');
    try {
      const r = await api('/api/docs/vydacha', 'POST',
        { seller_id: sid, date: el.querySelector('#v-date').value, lines: out,
          draft: draft || undefined });
      PRODUCTS_CACHE = null;
      if (draft) {
        toast('Черновик выдачи сохранён — он в «Документах» ✓', true);
      } else {
        toast('Выдано на ' + fmtM(r.doc.amount) + ', долг +' + fmtM(r.doc.money), true);
        if (r.doc.print_url &&
            await confirmDlg('Открыть УПД для печати или сохранения в PDF?')) {
          openExternal(r.doc.print_url);
        }
      }
      back();
    } catch (e) { toast(e.message); }
  };
  el.querySelector('#v-save').onclick = () => saveVyd(false);
  el.querySelector('#v-draft').onclick = () => saveVyd(true);
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

// передача товара от одного сотрудника другому (делает кладовщик)
async function S_transfer(fromSid) {
  const [info, sellersResp] = await Promise.all([
    api('/api/sellers/' + fromSid), api('/api/sellers'),
  ]);
  const hands = info.stock.hands;
  const others = sellersResp.sellers.filter(s => s.id !== fromSid);
  if (!hands.length) {
    screen('Передача товара',
      '<div class="card hint">У сотрудника нет товара на руках — передавать нечего.</div>',
      true);
    return;
  }
  if (!others.length) {
    screen('Передача товара',
      '<div class="card hint">Некому передавать — нет других продавцов.</div>', true);
    return;
  }
  const rows = hands.map((h, i) =>
    '<div class="row"><div class="l" style="flex:1"><div class="name small">' + (i + 1) +
    '. ' + esc(h.name) + '</div><div class="sub">на руках ' + fmtQ(h.qty, h.unit) +
    '</div></div>' +
    '<div class="r" style="width:104px"><input inputmode="decimal" class="tr-q" data-pid="' +
    h.product_id + '" data-max="' + h.qty + '" placeholder="сколько"></div></div>').join('');
  const html =
    '<div class="card hint small">Товар и долг за него переедут к получателю. ' +
    'Оба получат уведомление в Telegram.</div>' +
    '<div class="field"><label>Кому передать</label><select id="tr-to">' +
    others.map(s => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('') +
    '</select></div>' +
    '<div class="card">' + rows + '</div>' +
    '<button class="btn" id="tr-save">Передать</button>';
  const el = screen('Передача: ' + info.seller.name, html, true);
  el.querySelector('#tr-save').onclick = async () => {
    const lines = [];
    let bad = null;
    el.querySelectorAll('.tr-q').forEach(inp => {
      const q = pnum(inp.value);
      if (q > parseFloat(inp.dataset.max) + 0.0005) bad = true;
      if (q > 0) lines.push({ product_id: +inp.dataset.pid, qty: q });
    });
    if (bad) return toast('Нельзя передать больше, чем на руках');
    if (!lines.length) return toast('Укажи количество хотя бы по одной позиции');
    try {
      const r = await api('/api/docs/transfer', 'POST', {
        from_seller_id: fromSid,
        to_seller_id: +el.querySelector('#tr-to').value,
        lines,
      });
      toast('Передано на ' + fmtM(r.doc.amount) + ' ✓', true);
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
  const [sales, prodRep] = await Promise.all([
    api('/api/analytics/sales?' + qs), api('/api/analytics/products?' + qs),
  ]);
  const ownerish = ME.role === 'admin' || ME.role === 'owner';
  let profitHtml = '';
  if (ME.role === 'admin' || ME.role === 'owner') {
    const pr = await api('/api/analytics/profit?' + qs);
    const row = (l, v, cls) => '<div class="row"><div class="l hint">' + l +
      '</div><div class="r val ' + (cls || '') + '">' + v + '</div></div>';
    profitHtml = '<div class="card"><h3>💰 Прибыль за период</h3>' +
      '<div class="biglabel">Чистая прибыль</div>' +
      '<div class="bignum ' + (pr.net_profit >= 0 ? 'green' : 'red') + '">' +
      fmtM(pr.net_profit) + '</div>' +
      '<div class="sub hint" style="margin-bottom:8px">' + NF2.format(pr.margin_pct) +
      '% от оборота</div>' +
      row('Оборот (продано по ценам продажи)', fmtM(pr.turnover)) +
      row('Прошло по терминалу', fmtM(pr.terminal_raw)) +
      row('Себестоимость проданного', '− ' + fmtM(pr.cogs)) +
      row('Валовая прибыль', fmtM(pr.gross_profit)) +
      (Math.abs(pr.inventory_delta) > 0.005
        ? row('Инвентаризации (недостачи/излишки)',
            (pr.inventory_delta > 0 ? '+ ' : '− ') + fmtM(Math.abs(pr.inventory_delta)),
            pr.inventory_delta < 0 ? 'red' : 'green')
        : '') +
      row('Дополнительные расходы', '− ' + fmtM(pr.expenses_total), 'red') +
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
  const prods = ownerish
    ? [...prodRep.products].sort((a, b) => b.profit - a.profit)
    : prodRep.products;
  const prodHtml = prods.length ? prods.map((pp, i) =>
    '<div class="row"><div class="l" style="flex:1"><div class="name small">' + (i + 1) + '. ' +
    esc(pp.name) + '</div><div class="sub">' + fmtQ(pp.qty, pp.unit) + ' • продано ' +
    fmtM(pp.sold_value) +
    (ownerish ? ' • доля ' + fmtM(pp.our_share) : '') + '</div></div>' +
    '<div class="r">' + (ownerish
      ? '<div class="val ' + (pp.profit >= 0 ? 'green' : 'red') + '">' + fmtM(pp.profit) +
        '</div><div class="sub hint">заработали</div>'
      : '<div class="val">' + fmtM(pp.sold_value) + '</div>') + '</div></div>').join('') +
    '<div class="row total"><div class="l">Итого: ' + fmtQ(prodRep.totals.kg, 'кг') +
    '</div><div class="r">' + fmtM(ownerish ? prodRep.totals.profit : prodRep.totals.sold_value) +
    '</div></div>'
    : '<div class="hint small">Продаж за период нет</div>';
  const html = chips.html + profitHtml +
    '<div class="tiles">' +
    '<div class="tile"><div class="tl">Продано</div><div class="tv">' + fmtM(t.sold_value) + '</div></div>' +
    '<div class="tile"><div class="tl">Наша доля</div><div class="tv">' + fmtM(t.our_share) + '</div></div>' +
    '<div class="tile"><div class="tl">Терминал</div><div class="tv">' + fmtM(t.terminal_credit) + '</div></div>' +
    '</div>' +
    '<div class="card"><h3>Продажи по продавцам</h3>' + sellersHtml + '</div>' +
    '<div class="card"><h3>📈 Аналитика по товарам</h3>' + prodHtml + '</div>';
  const el = screen('', html);
  chips.bind(el);
}

// ===== отчёты =====
async function S_reports() {
  const r = await api('/api/docs?type=inventory&limit=100');
  const html = r.docs.length
    ? '<div class="card">' + r.docs.map((d, i) =>
      '<div class="row" data-rep="' + d.id + '" style="cursor:pointer">' +
      '<div class="l"><div class="name small">' + (i + 1) + '. Инвентаризация от ' +
      dstr(d.date) + '</div><div class="sub">' + esc(d.creator_name || '') + '</div></div>' +
      '<div class="r val ' + (d.amount < -0.005 ? 'red' : d.amount > 0.005 ? 'green' : 'hint') +
      '">' + fmtM(d.amount) + '</div></div>').join('') + '</div>'
    : '<div class="card hint">Отчётов пока нет — проведи инвентаризацию, и здесь появится ' +
      'отчёт о расхождениях.</div>';
  const el = screen('Отчёты', html, true);
  el.addEventListener('click', e => {
    const c = e.target.closest('[data-rep]');
    if (c) push(S_invReport, +c.dataset.rep);
  });
}

async function S_invReport(docId) {
  const d = (await api('/api/docs/' + docId)).doc;
  const diffs = d.lines.map(l => ({
    name: l.name, unit: l.unit,
    before: l.qty_before || 0, fact: l.qty,
    diff: l.qty - (l.qty_before || 0),
    money: (l.qty - (l.qty_before || 0)) * l.purchase_price,
  })).filter(x => Math.abs(x.diff) > 0.0005);
  let shortage = 0, surplus = 0;
  diffs.forEach(x => { if (x.money < 0) shortage += x.money; else surplus += x.money; });
  const rows = diffs.length ? diffs.map((x, i) =>
    '<div class="row"><div class="l" style="flex:1"><div class="name small">' + (i + 1) + '. ' +
    esc(x.name) + '</div><div class="sub">учёт ' + fmtQ(x.before, x.unit) + ' → факт ' +
    fmtQ(x.fact, x.unit) + '</div></div>' +
    '<div class="r"><div class="val ' + (x.diff < 0 ? 'red' : 'green') + '">' +
    (x.diff > 0 ? '+' : '') + fmtQ(x.diff, x.unit) + '</div>' +
    '<div class="sub ' + (x.money < 0 ? 'red' : 'green') + '">' +
    (x.money > 0 ? '+' : '') + fmtM(x.money) + '</div></div></div>').join('')
    : '<div class="hint">Расхождений нет — всё сходится ✓</div>';
  const html =
    '<div class="card"><div class="biglabel">Итог по себестоимости</div>' +
    '<div class="bignum ' + (d.amount < -0.005 ? 'red' : 'green') + '">' + fmtM(d.amount) +
    '</div><div class="sub hint">' + dstr(d.date) + ' • ' + esc(d.creator_name || '') +
    (shortage < 0 ? ' • недостача ' + fmtM(-shortage) : '') +
    (surplus > 0 ? ' • излишки ' + fmtM(surplus) : '') + '</div></div>' +
    '<div class="card"><h3>Расхождения</h3>' + rows + '</div>' +
    ((d.chain || []).length
      ? '<div class="card"><h3>🔗 Цепочка документов</h3>' + d.chain.map(c => {
          const m = DOC_META[c.type] || ['📄', c.type];
          return '<button class="chip" style="margin:2px 6px 2px 0" data-chainopen="' + c.id +
            '">' + m[0] + ' ' + m[1] + ' от ' + dstr(c.date) +
            (c.status === 'void' ? ' (отменён)' : '') + '</button>';
        }).join('') + '</div>'
      : '');
  screen('Отчёт: инвентаризация', html, true);
}

// ===== мероприятия и точки =====
const PL_STATE = { calMode: 'day', selKey: null, citySel: [], typeSel: [], whoSel: [], q: '' };
const RU_M_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт',
  'ноя', 'дек'];
const RU_DW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function addDays(d, n) { return new Date(d.getTime() + n * 864e5); }
function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return addDays(x, -((x.getDay() + 6) % 7));
}
function calDefaultKey(mode) {
  const t = new Date();
  if (mode === 'day') return today();
  return isoDate(new Date(t.getFullYear(), t.getMonth(), 1));
}
function calPeriod(mode, key) {
  const d = new Date(key + 'T00:00:00');
  if (mode === 'day') return { from: key, to: key };
  return { from: key, to: isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
}
function calItems(mode) {
  const out = [];
  const t = new Date();
  if (mode === 'day') {
    const t0 = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    for (let i = -30; i <= 120; i++) {
      const d = addDays(t0, i);
      const first = d.getDate() === 1;
      out.push({ key: isoDate(d), dw: RU_DW[d.getDay()],
        we: d.getDay() === 0 || d.getDay() === 6,
        dn: String(d.getDate()) +
          (first ? ' <span class="dm">' + RU_M_SHORT[d.getMonth()] + '</span>' : ''),
        month: RU_M_SHORT[d.getMonth()] });
    }
  } else {
    for (let i = -3; i <= 14; i++) {
      const d = new Date(t.getFullYear(), t.getMonth() + i, 1);
      out.push({ key: isoDate(d), dw: String(d.getFullYear()), we: false,
        dn: RU_M_SHORT[d.getMonth()], month: '', wide: true });
    }
  }
  return out;
}
function evIntersects(ev, p) {
  return ev.date_from <= p.to && (ev.date_to || ev.date_from) >= p.from;
}
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

function isBooked(x) {
  return !!(x.bookings && x.bookings.length);
}

function bookBtnHtml(x, attr) {
  if (isBooked(x)) {
    // своя бронь в приоритете — её и предлагаем снять одним тапом
    const bk = x.bookings.find(b => b.user_id === ME.id || b.created_by === ME.id) ||
      x.bookings[0];
    const info = bk.user_name + ', ' + dstr(bk.date_from) +
      (bk.date_to !== bk.date_from ? ' – ' + dstr(bk.date_to) : '');
    return '<button class="bookbtn booked" data-unbook="' + bk.id + '" data-bkinfo="' +
      esc(info) + '">Забронировано</button>';
  }
  return '<button class="bookbtn" ' + attr + '="' + x.id + '">Забронировать</button>';
}

function evCardHtml(ev, n) {
  const dates = dstr(ev.date_from) +
    (ev.date_to && ev.date_to !== ev.date_from ? ' – ' + dstr(ev.date_to) : '');
  // адрес — первый кусок комментария (площадка), без контактов
  const addr = ((ev.comment || '').split(' • ')[0] || '').slice(0, 70);
  const place = [ev.city, addr].filter(Boolean).join(', ');
  return '<div class="card place" data-eid="' + ev.id + '" style="cursor:pointer">' +
    '<div class="pl-main">' +
    '<div class="dochead"><div><b>' + n + '. ' + esc(ev.name) + '</b></div>' +
    '<div class="dt">' + dates + '</div></div>' +
    '<div class="plfoot">' +
    (place ? '<div class="sub hint small">' + esc(place) + '</div>' : '') +
    (isBooked(ev) ? '' : '<div class="sub small" style="margin-top:4px">' + ownerLine(ev) +
      '</div>') +
    bookingsLine(ev) + '</div></div>' +
    bookBtnHtml(ev, 'data-ebook') + '</div>';
}

function evListHtml(evs, per) {
  // сначала события, начинающиеся в выбранном периоде; длящиеся (начались раньше) — в конце
  const inSel = evs.filter(ev => evIntersects(ev, per))
    .sort((a, b) => {
      const aLong = a.date_from < per.from ? 1 : 0;
      const bLong = b.date_from < per.from ? 1 : 0;
      if (aLong !== bLong) return aLong - bLong;
      return a.date_from < b.date_from ? -1 : 1;
    });
  return inSel.length ? inSel.map((ev, i) => evCardHtml(ev, i + 1)).join('')
    : '<div class="card hint">На выбранный период мероприятий нет</div>';
}

function ptCardHtml(pt, n) {
  const form = isBooked(pt) ? '' :
    '<div class="bkform" data-bkform="' + pt.id + '" hidden>' +
    '<div class="hint small" style="margin:8px 0 4px">С какого по какое число:</div>' +
    '<div class="grid2">' +
    '<input type="date" class="bkf-from" value="' + today() + '">' +
    '<input type="date" class="bkf-to" value="' + today() + '"></div>' +
    '<button class="btn secondary" data-bkgo="' + pt.id +
    '" style="margin:8px 0 0;padding:10px">Забронировать на эти даты</button></div>';
  return '<div class="card place" data-ptid="' + pt.id + '" style="cursor:pointer">' +
    '<div class="pl-main">' +
    '<div><b>' + n + '. ' + esc(pt.name) + '</b></div>' +
    '<div class="plfoot"><div class="sub hint small">' +
    ([esc(pt.address || ''), esc(pt.city)].filter(Boolean).join(', ') || 'адрес не указан') +
    '</div>' + bookingsLine(pt) + '</div>' + form + '</div>' +
    bookBtnHtml(pt, 'data-book') + '</div>';
}

function ptListHtml(points) {
  return points.length ? points.map((pt, i) => ptCardHtml(pt, i + 1)).join('')
    : '<div class="card hint">Точек не найдено</div>';
}

// ===== единая лента: мероприятия + постоянные точки, фильтры нижним листом =====

function whoMatch(x, whoSel) {
  if (!whoSel.length) return true;
  if (whoSel.includes('free') && !x.owner_user_id && !isBooked(x)) return true;
  return whoSel.some(id => x.owner_user_id === id ||
    (x.bookings || []).some(b => b.user_id === id));
}

function openFilterSheet(opts) {
  const bg = document.createElement('div');
  bg.className = 'sheetbg';
  const sh = document.createElement('div');
  sh.className = 'sheet';
  const chip = (attr, val, label, on) =>
    '<button class="chip' + (on ? ' on' : '') + '" data-' + attr + '="' + esc(String(val)) +
    '">' + esc(label) + '</button>';
  const draw = () => {
    const cityQ = (sh.querySelector('#sh-cq') || {}).value || '';
    const cities = opts.cities.filter(c =>
      !cityQ.trim() || c.toLowerCase().includes(cityQ.toLowerCase().trim()));
    sh.innerHTML =
      '<div class="sheethandle"></div>' +
      '<h3 style="margin-bottom:10px">Фильтры</h3>' +
      '<div class="shsec">Город</div>' +
      '<div class="field"><input id="sh-cq" placeholder="🔍 Поиск города…" value="' +
      esc(cityQ) + '" autocomplete="off"></div>' +
      '<div class="chipwrap">' +
      cities.slice(0, 60).map(c =>
        chip('shc', c, c, opts.sel.citySel.includes(c))).join('') + '</div>' +
      '<div class="shsec">Вид</div><div class="chipwrap">' +
      opts.types.map(t => chip('sht', t, t, opts.sel.typeSel.includes(t))).join('') + '</div>' +
      '<div class="shsec">Кто едет</div><div class="chipwrap">' +
      chip('shw', 'free', 'Свободные', opts.sel.whoSel.includes('free')) +
      opts.people.map(p =>
        chip('shw', p.id, p.name, opts.sel.whoSel.includes(p.id))).join('') + '</div>' +
      '<div class="sheetfoot">' +
      '<button class="btn secondary" id="sh-reset" style="margin:0">Сбросить</button>' +
      '<button class="btn" id="sh-show" style="margin:0">Показать (' + opts.count() +
      ')</button></div>';
    const cq = sh.querySelector('#sh-cq');
    cq.addEventListener('input', () => {
      const pos = cq.selectionStart;
      draw();
      const cq2 = sh.querySelector('#sh-cq');
      cq2.focus();
      cq2.setSelectionRange(pos, pos);
    });
  };
  const close = () => { bg.remove(); sh.remove(); opts.onClose(); };
  bg.onclick = close;
  sh.addEventListener('click', e => {
    if (e.target.id === 'sh-reset') {
      opts.sel.citySel.length = 0;
      opts.sel.typeSel.length = 0;
      opts.sel.whoSel.length = 0;
      draw();
      return;
    }
    if (e.target.id === 'sh-show') { close(); return; }
    const c = e.target.closest('[data-shc]');
    const t = e.target.closest('[data-sht]');
    const w = e.target.closest('[data-shw]');
    if (!c && !t && !w) return;
    const arr = c ? opts.sel.citySel : t ? opts.sel.typeSel : opts.sel.whoSel;
    let val = c ? c.dataset.shc : t ? t.dataset.sht : w.dataset.shw;
    if (w && val !== 'free') val = +val;
    const i = arr.indexOf(val);
    if (i >= 0) arr.splice(i, 1); else arr.push(val);
    draw();
  });
  document.body.appendChild(bg);
  document.body.appendChild(sh);
  draw();
}

async function S_places() {
  const meta = await api('/api/places/meta');
  const [evResp, ptResp] = await Promise.all([
    api('/api/events?when=all'), api('/api/points'),
  ]);
  let allEvents = evResp.events;
  let allPoints = ptResp.points;
  const sel = PL_STATE; // citySel / typeSel / whoSel живут в состоянии вкладки
  const textQ = () => (PL_STATE.q || '').toLowerCase().trim();
  const textMatch = x => {
    const q = textQ();
    return !q || (x.name || '').toLowerCase().includes(q) ||
      (x.city || '').toLowerCase().includes(q) ||
      (x.address || '').toLowerCase().includes(q);
  };
  const evMatch = ev =>
    (!sel.citySel.length || sel.citySel.includes(ev.city)) &&
    (!sel.typeSel.length || sel.typeSel.includes(ev.etype || 'Другое')) &&
    whoMatch(ev, sel.whoSel) && textMatch(ev);
  const ptMatch = pt =>
    (!sel.citySel.length || sel.citySel.includes(pt.city)) &&
    (!sel.typeSel.length || sel.typeSel.includes(pt.ptype || 'Другое')) &&
    whoMatch(pt, sel.whoSel) && textMatch(pt);
  const typeOptions = [...new Set(
    allEvents.map(x => x.etype || 'Другое').concat(allPoints.map(x => x.ptype || 'Другое'))
  )].sort();
  if (!PL_STATE.selKey) PL_STATE.selKey = calDefaultKey(PL_STATE.calMode);
  const items = calItems(PL_STATE.calMode);
  if (!items.some(it => it.key === PL_STATE.selKey)) {
    PL_STATE.selKey = calDefaultKey(PL_STATE.calMode);
  }
  let per = calPeriod(PL_STATE.calMode, PL_STATE.selKey);
  const evsF = () => allEvents.filter(evMatch);
  const ptsF = () => allPoints.filter(ptMatch);
  const listBlock = () => {
    const pts = ptsF();
    return evListHtml(evsF(), per) +
      (pts.length
        ? '<div class="hint small" style="margin:16px 4px 8px;font-weight:700">📍 ПОСТОЯННЫЕ ' +
          'ТОЧКИ</div>' + ptListHtml(pts)
        : '');
  };
  const nActive = () => sel.citySel.length + sel.typeSel.length + sel.whoSel.length;
  const strip = items.map(it => {
    const has = evsF().some(ev => evIntersects(ev, calPeriod(PL_STATE.calMode, it.key)));
    return '<div class="ditem' + (it.wide ? ' wide' : '') +
      (it.key === PL_STATE.selKey ? ' sel' : '') + (has ? '' : ' off') +
      '" data-cal="' + it.key + '" data-month="' + it.month + '">' +
      '<div class="dw' + (it.we ? ' we' : '') + '">' + it.dw + '</div>' +
      '<div class="dn">' + it.dn + '</div></div>';
  }).join('');
  const modes = [['day', 'По дням'], ['month', 'По месяцам']];
  const html =
    '<div class="calwrap"><div class="calbar">' +
    '<div class="calmonth" id="cal-month"></div>' +
    '<div class="dstrip" id="cal-strip">' + strip + '</div></div>' +
    '<button class="calarr left" id="cal-prev">‹</button>' +
    '<button class="calarr right" id="cal-next">›</button></div>' +
    '<div class="seg" id="cal-mode">' + modes.map(m =>
      '<button' + (PL_STATE.calMode === m[0] ? ' class="on"' : '') + ' data-mode="' + m[0] +
      '">' + m[1] + '</button>').join('') + '</div>' +
    '<div class="searchrow"><span class="sico">🔍</span>' +
    '<input id="pl-q" placeholder="Поиск точек и мероприятий…" autocomplete="off" value="' +
    esc(PL_STATE.q || '') + '">' +
    '<button id="fl-open" title="Фильтры">🎚<span id="fl-n"></span></button></div>' +
    '<div class="addline"><span data-add="event">+ мероприятие</span>' +
    '<span data-add="point">+ точка</span></div>' +
    '<div id="pl-list">' + listBlock() + '</div>';
  const el = screen('', html);
  const flBtn = el.querySelector('#fl-open');
  const flLabel = () => {
    el.querySelector('#fl-n').textContent = nActive() ? nActive() : '';
  };
  flLabel();
  const qInp = el.querySelector('#pl-q');
  qInp.addEventListener('input', () => {
    clearTimeout(qInp._t);
    qInp._t = setTimeout(() => { PL_STATE.q = qInp.value; applyAll(); }, 250);
  });
  const applyAll = () => {
    per = calPeriod(PL_STATE.calMode, PL_STATE.selKey);
    el.querySelector('#pl-list').innerHTML = listBlock();
    const stripEl = el.querySelector('#cal-strip');
    for (const c of stripEl.children) {
      const has = evsF().some(ev => evIntersects(ev, calPeriod(PL_STATE.calMode, c.dataset.cal)));
      c.classList.toggle('off', !has);
    }
    flLabel();
  };
  flBtn.onclick = () => openFilterSheet({
    cities: meta.cities, types: typeOptions, people: meta.people, sel,
    count: () => evsF().filter(ev => evIntersects(ev, per)).length + ptsF().length,
    onClose: applyAll,
  });
  el.addEventListener('click', async e => {
    const add = e.target.closest('[data-add]');
    if (add) {
      push(add.dataset.add === 'event' ? S_eventEdit : S_pointEdit, null, meta);
      return;
    }
    const cal = e.target.closest('[data-cal]');
    if (cal) {
      PL_STATE.selKey = cal.dataset.cal;
      el.querySelectorAll('.ditem').forEach(d =>
        d.classList.toggle('sel', d.dataset.cal === cal.dataset.cal));
      applyAll();
      return;
    }
    const ub = e.target.closest('[data-unbook]');
    if (ub) {
      if (!(await confirmDlg('Снять бронь (' + ub.dataset.bkinfo + ')?'))) return;
      try {
        await api('/api/bookings/' + ub.dataset.unbook, 'DELETE');
        toast('Бронь снята ✓', true);
        allEvents = (await api('/api/events?when=all')).events;
        allPoints = (await api('/api/points')).points;
        applyAll();
      } catch (err) { toast(err.message); }
      return;
    }
    const eb = e.target.closest('[data-ebook]');
    if (eb) {
      // бронь мероприятия в один тап — на выбранную в календаре дату
      const ev = allEvents.find(x => x.id === +eb.dataset.ebook);
      const evTo = ev.date_to || ev.date_from;
      const from = per.from > ev.date_from ? per.from : ev.date_from;
      const to = per.to < evTo ? per.to : evTo;
      try {
        await api('/api/bookings', 'POST', {
          kind: 'event', ref_id: ev.id, user_id: ME.id, date_from: from, date_to: to,
        });
        toast('Забронировано ✓', true);
        allEvents = (await api('/api/events?when=all')).events;
        applyAll();
      } catch (err) { toast(err.message); }
      return;
    }
    const bk = e.target.closest('[data-book]');
    if (bk) {
      const f = el.querySelector('[data-bkform="' + bk.dataset.book + '"]');
      if (f) f.hidden = !f.hidden;
      return;
    }
    const go = e.target.closest('[data-bkgo]');
    if (go) {
      const f = el.querySelector('[data-bkform="' + go.dataset.bkgo + '"]');
      try {
        await api('/api/bookings', 'POST', {
          kind: 'point', ref_id: +go.dataset.bkgo, user_id: ME.id,
          date_from: f.querySelector('.bkf-from').value,
          date_to: f.querySelector('.bkf-to').value,
        });
        toast('Забронировано ✓', true);
        allPoints = (await api('/api/points')).points;
        applyAll();
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.closest('.bkform')) return;
    const ec = e.target.closest('[data-eid]');
    if (ec) {
      push(S_eventView, allEvents.find(x => x.id === +ec.dataset.eid), meta);
      return;
    }
    const pc = e.target.closest('[data-ptid]');
    if (pc) {
      push(S_pointEdit, allPoints.find(x => x.id === +pc.dataset.ptid), meta, false);
    }
  });
  const stripEl = el.querySelector('#cal-strip');
  const monthEl = el.querySelector('#cal-month');
  const updMonth = () => {
    let label = '';
    for (const c of stripEl.children) {
      if (c.offsetLeft - stripEl.offsetLeft + c.offsetWidth - stripEl.scrollLeft > 8) {
        label = c.dataset.month || c.querySelector('.dw').textContent;
        break;
      }
    }
    monthEl.textContent = label;
  };
  stripEl.addEventListener('scroll', () => {
    clearTimeout(stripEl._t);
    stripEl._t = setTimeout(updMonth, 80);
  });
  const selItem = stripEl.querySelector('.ditem.sel');
  if (selItem) {
    stripEl.style.scrollBehavior = 'auto';
    selItem.scrollIntoView({ inline: 'center', block: 'nearest' });
    stripEl.style.scrollBehavior = '';
    window.scrollTo(0, 0);
  }
  updMonth();
  el.querySelector('#cal-prev').onclick = () => {
    stripEl.scrollLeft -= stripEl.clientWidth * 0.8;
  };
  el.querySelector('#cal-next').onclick = () => {
    stripEl.scrollLeft += stripEl.clientWidth * 0.8;
  };
  el.querySelector('#cal-mode').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    PL_STATE.calMode = b.dataset.mode;
    PL_STATE.selKey = calDefaultKey(PL_STATE.calMode);
    render();
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

// красивая карточка мероприятия; редактирование — внутри
async function S_eventView(ev, meta) {
  const dates = dstr(ev.date_from) +
    (ev.date_to && ev.date_to !== ev.date_from ? ' – ' + dstr(ev.date_to) : '');
  const parts = (ev.comment || '').split(' • ').filter(Boolean);
  const addr = parts[0] || '';
  const contacts = parts.slice(1);
  const row = (l, v) => '<div class="row"><div class="l hint">' + l +
    '</div><div class="r val" style="text-align:right;max-width:60%">' + v + '</div></div>';
  const html =
    '<div class="card">' +
    '<div style="font-size:22px;font-weight:800;line-height:1.25">' + esc(ev.name) + '</div>' +
    '<div class="sub hint" style="margin:6px 0 10px">' +
    [esc(ev.etype), esc(ev.city)].filter(Boolean).join(' • ') + '</div>' +
    row('📅 Даты', dates) +
    (addr ? row('📍 Площадка', esc(addr)) : '') +
    row('👤 Кто ездит', ev.owner_name ? esc(ev.owner_name)
      : '<span class="green">точка свободна</span>') +
    (contacts.length
      ? '<div class="hint small" style="margin-top:8px">' + esc(contacts.join(' • ')) + '</div>'
      : '') +
    '</div>' +
    '<div class="card" id="bk-box"></div>' +
    '<button class="btn secondary" id="ev-edit">✏️ Редактировать</button>';
  const el = screen('Мероприятие', html, true);
  bookingBlock(el, 'event', ev.id, meta);
  el.querySelector('#ev-edit').onclick = () => push(S_eventEdit, ev, meta);
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
  const ownerish = admin || ME.role === 'owner';
  const seller = ME.role === 'seller';
  const roleName = { admin: 'администратор', owner: 'совладелец', keeper: 'кладовщик',
    seller: 'продавец' }[ME.role] || ME.role;
  const showUsers = admin || ME.role === 'keeper';
  const items = seller
    ? [['history', '🗂', 'История моих операций']]
    : [
        ['products', '🏷', 'Номенклатура'],
        ['prices', '💰', 'Цены продажи'],
        ['sup', '🚛', 'Поставщики'],
      ].concat(ownerish ? [['exp', '🧾', 'Расходы']] : [])
      .concat([['docs', '📚', 'Документы'], ['reports', '📑', 'Отчёты']])
      .concat(showUsers ? [['users', '👤', 'Пользователи']] : [])
      .concat(admin ? [['set', '⚙️', 'Настройки']] : []);
  const html = menuTiles(items) +
    '<div class="hint small" style="text-align:center;margin-top:16px">' +
    esc(ME.first_name + ' ' + ME.last_name) + ' • ' + roleName + '</div>';
  const el = screen('', html);
  bindMenu(el, {
    history: () => push(S_history),
    products: () => push(S_products),
    prices: () => push(S_prices),
    reports: () => push(S_reports),
    sup: () => push(S_suppliers),
    docs: () => push(S_docs),
    users: () => push(S_users),
    exp: () => push(S_expenses),
    set: () => push(S_settings),
  });
}

// быстрое управление ценами продажи: весь товар списком, справа — цена
async function S_prices() {
  const products = (await getProducts(true)).filter(p => !p.archived);
  const rows = products.map((p, i) =>
    '<div class="row prow" data-name="' + esc(p.name.toLowerCase()) + '">' +
    '<div class="l" style="flex:1"><div class="name small">' + (i + 1) + '. ' + esc(p.name) +
    '</div><div class="sub">себестоимость ' + fmtM(p.purchase_price) + '</div></div>' +
    '<div class="r" style="display:flex;gap:6px;align-items:center">' +
    '<input inputmode="decimal" class="pri" style="width:88px" data-pid="' +
    p.id + '" data-old="' + p.retail_price + '" value="' +
    (p.retail_price || '') + '" placeholder="цена">' +
    '<button class="chip psave" data-pid="' + p.id + '" hidden>✓</button></div></div>')
    .join('');
  const html =
    '<div class="card hint small">Меняй цену прямо в окошке — рядом появится кнопка ✓ ' +
    'для сохранения.</div>' +
    '<div class="field"><input id="pz-q" placeholder="🔍 Поиск товара…"></div>' +
    '<div class="card">' + (rows || '<div class="hint">Номенклатура пуста</div>') + '</div>';
  const el = screen('Цены продажи', html, true);
  el.querySelector('#pz-q').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    el.querySelectorAll('.prow').forEach(r => {
      r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none';
    });
  });
  el.addEventListener('input', e => {
    if (!e.target.classList.contains('pri')) return;
    const changed = Math.abs(pnum(e.target.value) - parseFloat(e.target.dataset.old)) > 0.004;
    e.target.parentElement.querySelector('.psave').hidden = !changed;
  });
  el.addEventListener('click', async e => {
    const b = e.target.closest('.psave');
    if (!b) return;
    const inp = b.parentElement.querySelector('.pri');
    try {
      await api('/api/products/' + b.dataset.pid, 'PUT', { retail_price: pnum(inp.value) });
      inp.dataset.old = String(pnum(inp.value));
      b.hidden = true;
      PRODUCTS_CACHE = null;
      toast('Цена сохранена ✓', true);
    } catch (err) { toast(err.message); }
  });
}

async function S_products() {
  const products = await getProducts(true);
  const active = products.filter(p => !p.archived);
  const arch = products.filter(p => p.archived);
  const rowP = p =>
    '<div class="row" data-pid="' + p.id + '" style="cursor:pointer">' +
    '<div class="l"><div class="name small">' + esc(p.name) + '</div>' +
    '<div class="sub">себестоимость ' + fmtM(p.purchase_price) + ' • цена продажи ' + fmtM(p.retail_price) +
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
    '<div class="field"><label>Себестоимость, ₽</label><input id="pe-pp" inputmode="decimal" value="' +
    (p ? p.purchase_price : '') + '"></div>' +
    '<div class="field"><label>Цена продажи, ₽</label><input id="pe-rp" inputmode="decimal" value="' +
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

const DOCS_STATE = { group: '' };
const DOC_GROUPS = [
  ['', 'Все', null],
  ['draft', 'Черновики', null],
  ['prihod', 'Поступления', ['prihod', 'initial']],
  ['vydacha', 'Выдачи', ['vydacha']],
  ['sdacha', 'Приёмки', ['sdacha']],
  ['transfer', 'Передачи', ['transfer_out', 'transfer_in']],
  ['money', 'Деньги', ['incass', 'cash']],
  ['inv', 'Инвентаризация', ['inventory', 'writeoff', 'surplus']],
  ['price', 'Цены', ['price_change']],
];

async function S_docs() {
  const r = await api('/api/docs?limit=300');
  const g = DOC_GROUPS.find(x => x[0] === DOCS_STATE.group) || DOC_GROUPS[0];
  const docs = r.docs.filter(d =>
    DOCS_STATE.group === 'draft' ? d.status === 'draft'
      : !g[2] || g[2].includes(d.type));
  const chips = DOC_GROUPS.map(t =>
    '<button class="chip' + (DOCS_STATE.group === t[0] ? ' on' : '') + '" data-t="' + t[0] +
    '">' + t[1] + '</button>').join('');
  const el = screen('Документы',
    '<div class="chips">' + chips + '</div>' +
    (docs.length ? docs.map(d => docCard(d, true, true)).join('')
      : '<div class="card hint">Документов в этой группе нет</div>'), true);
  el.addEventListener('click', async e => {
    const post = e.target.closest('[data-docpost]');
    if (post) {
      e.preventDefault();
      if (!(await confirmDlg('Провести «' + post.dataset.docname +
        '»? Документ начнёт влиять на остатки и балансы.'))) return;
      try {
        await api('/api/docs/' + post.dataset.docpost + '/post', 'POST');
        toast('Проведён ✓', true);
        PRODUCTS_CACHE = null;
        render();
      } catch (err) { toast(err.message); }
      return;
    }
    const vd = e.target.closest('[data-docvoid]');
    if (vd) {
      e.preventDefault();
      if (!(await confirmDlg('Отменить «' + vd.dataset.docname +
        '»? Это сторно: документ останется в истории со статусом «Отменён», а его влияние ' +
        'на остатки и балансы будет снято.'))) return;
      try {
        await api('/api/docs/' + vd.dataset.docvoid + '/void', 'POST');
        toast('Документ отменён (сторно) ✓', true);
        PRODUCTS_CACHE = null;
        render();
      } catch (err) { toast(err.message); }
      return;
    }
    const del = e.target.closest('[data-docdel]');
    if (del) {
      e.preventDefault();
      if (!(await confirmDlg('Удалить черновик «' + del.dataset.docname + '»?'))) return;
      try {
        await api('/api/docs/' + del.dataset.docdel, 'DELETE');
        toast('Черновик удалён ✓', true);
        render();
      } catch (err) { toast(err.message); }
      return;
    }
    const c = e.target.closest('.chip[data-t]');
    if (!c) return;
    DOCS_STATE.group = c.dataset.t;
    render();
  });
}

async function S_users() {
  const r = await api('/api/users');
  const allRoles = [['seller', 'Продавец'], ['keeper', 'Кладовщик'], ['owner', 'Совладелец'],
    ['admin', 'Админ']];
  const roles = ME.role === 'admin' ? allRoles : allRoles.slice(0, 2);
  const addBtn = '<button class="btn" id="us-add">+ Добавить пользователя</button>';
  const roleTitle = { seller: 'Продавец', keeper: 'Кладовщик', owner: 'Совладелец',
    admin: 'Админ' };
  const html = '<div class="card">' + r.users.map(u => {
    const locked = ME.role !== 'admin' && (u.role === 'admin' || u.role === 'owner');
    const controls = locked
      ? '<span class="hint small">' + (roleTitle[u.role] || u.role) + '</span>'
      : '<select data-uid="' + u.id + '" style="width:auto;padding:6px 8px;font-size:13px">' +
        roles.map(x => '<option value="' + x[0] + '"' + (u.role === x[0] ? ' selected' : '') +
          '>' + x[1] + '</option>').join('') +
        (u.role === 'admin' && ME.role !== 'admin' ? '' : '') + '</select>' +
        '<button class="chip" data-tgl="' + u.id + '">' + (u.active ? '⏸' : '▶️') + '</button>';
    return '<div class="row"><div class="l"><div class="name small">' +
      esc(u.first_name + ' ' + u.last_name) +
      (u.active ? '' : ' <span class="red">(откл.)</span>') +
      '</div><div class="sub">' +
      (u.username ? '@' + esc(u.username)
        : (u.tg_id > 0 ? 'id ' + u.tg_id : 'создан вручную, без Telegram')) +
      ' • ' + (roleTitle[u.role] || u.role) +
      '</div></div><div class="r" style="display:flex;gap:6px;align-items:center">' +
      controls + '</div></div>';
  }).join('') + '</div>' +
    '<div class="card hint small">Продавец видит только своё. Кладовщик — склад, выдачи, сдачи, ' +
    'инкассации, продавцов. Совладелец — как админ (прибыль, расходы, наличные), но без ' +
    'управления пользователями и настроек. Админ — всё.</div>';
  const el = screen('Пользователи', addBtn + html, true);
  el.querySelector('#us-add').onclick = () => push(S_userAdd, roles);
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

// ручное добавление пользователя
async function S_userAdd(roles) {
  const html =
    '<div class="field"><label>Имя</label><input id="ua-first"></div>' +
    '<div class="field"><label>Фамилия</label><input id="ua-last"></div>' +
    '<div class="field"><label>Роль</label><select id="ua-role">' +
    roles.map(x => '<option value="' + x[0] + '">' + x[1] + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>Ник в Telegram (необязательно)</label>' +
    '<input id="ua-nick" placeholder="@username"></div>' +
    '<div class="field"><label>Telegram ID (необязательно)</label>' +
    '<input id="ua-tgid" inputmode="numeric" placeholder="например, 123456789"></div>' +
    '<div class="card hint small">Укажи ник или Telegram ID — тогда человек при первом входе ' +
    'сразу попадёт в свой аккаунт и будет получать уведомления. ID можно узнать командой ' +
    '/id у бота. Без ника и ID аккаунт работает только внутри системы.</div>' +
    '<button class="btn" id="ua-save">Добавить</button>';
  const el = screen('Новый пользователь', html, true);
  el.querySelector('#ua-save').onclick = async () => {
    try {
      await api('/api/users', 'POST', {
        first_name: el.querySelector('#ua-first').value,
        last_name: el.querySelector('#ua-last').value,
        role: el.querySelector('#ua-role').value,
        username: el.querySelector('#ua-nick').value.trim() || null,
        tg_id: el.querySelector('#ua-tgid').value.trim() || null,
      });
      toast('Пользователь добавлен ✓', true);
      back();
    } catch (e) { toast(e.message); }
  };
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

function applyInsets() {
  // фолбэк: старые клиенты Telegram не ставят CSS-переменные safe-area сами
  if (!tg) return;
  const r = document.documentElement.style;
  const sa = tg.safeAreaInset || {};
  const csa = tg.contentSafeAreaInset || {};
  if (sa.top != null) r.setProperty('--tg-safe-area-inset-top', sa.top + 'px');
  if (sa.bottom != null) r.setProperty('--tg-safe-area-inset-bottom', sa.bottom + 'px');
  if (csa.top != null) r.setProperty('--tg-content-safe-area-inset-top', csa.top + 'px');
}

async function boot() {
  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    applyInsets();
    if (tg.onEvent) {
      tg.onEvent('safeAreaChanged', applyInsets);
      tg.onEvent('contentSafeAreaChanged', applyInsets);
    }
  }
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
