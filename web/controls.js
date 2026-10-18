/* 自定义下拉框：原生 select 展开的列表由系统绘制，深浅主题都压不住样式。
   控件依旧读写原 select，取值逻辑不用改。 */
(function () {
  'use strict';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function itemsOf(select) {
    return Array.from(select.options).map((o) => ({
      value: o.value,
      label: o.textContent.trim(),
      // 色带这类选项带 data-grad，列表和按钮上都画一条真实的渐变
      grad: o.getAttribute('data-grad') || '',
    }));
  }

  function closeAll() {
    document.querySelectorAll('.combo.open').forEach((w) => {
      w.classList.remove('open');
      w.querySelector('.combo-btn').setAttribute('aria-expanded', 'false');
    });
  }

  function moveActive(select, step) {
    const list = select.__combo.list;
    const opts = Array.from(list.querySelectorAll('.combo-opt'));
    if (!opts.length) return;
    let i = opts.findIndex((o) => o.classList.contains('active'));
    i = (i + step + opts.length) % opts.length;
    opts.forEach((o, n) => o.classList.toggle('active', n === i));
    opts[i].scrollIntoView({ block: 'nearest' });
  }

  function choose(select, value) {
    select.value = value;
    closeAll();
    syncSelect(select);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function build(select) {
    const wrap = el('div', 'combo');
    const btn = el('button', 'combo-btn');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    const btnTxt = el('span', 'combo-label');
    const btnBar = el('span', 'combo-bar');
    btn.appendChild(btnTxt);
    btn.appendChild(btnBar);
    const list = el('div', 'combo-list');
    list.setAttribute('role', 'listbox');
    wrap.appendChild(btn);
    wrap.appendChild(list);
    select.parentNode.insertBefore(wrap, select.nextSibling);
    select.classList.add('combo-source');
    select.tabIndex = -1;
    select.__combo = { wrap: wrap, btn: btn, txt: btnTxt, bar: btnBar, list: list };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = wrap.classList.contains('open');
      closeAll();
      if (wasOpen) return;
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      /* 列表改成按视口定位的浮层：用绝对定位时它会被设置页弹窗裁掉，
         长列表还会把弹窗顶出一条纵向滚动条（展开"浮窗停留时间"就能看到）。
         固定定位不参与祖先的滚动高度，天然脱离弹窗 */
      const r = btn.getBoundingClientRect();
      list.style.position = 'fixed';
      list.style.left = Math.round(r.left) + 'px';
      list.style.width = Math.round(r.width) + 'px';
      list.style.right = 'auto';
      list.style.top = Math.round(r.bottom + 4) + 'px';
      const lh = list.getBoundingClientRect().height;
      if (r.bottom + 4 + lh > window.innerHeight - 8) {
        list.style.top = Math.round(Math.max(8, r.top - lh - 4)) + 'px';
      }
      const picked = list.querySelector('.combo-opt.selected') || list.querySelector('.combo-opt');
      list.querySelectorAll('.combo-opt').forEach((o) => o.classList.remove('active'));
      if (picked) picked.classList.add('active');
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(select, 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(select, -1); }
      else if (e.key === 'Enter') {
        const active = list.querySelector('.combo-opt.active');
        if (active) { e.preventDefault(); choose(select, active.dataset.value); }
      }
    });
  }

  function paintBar(node, grad) {
    if (!node) return;
    if (grad) {
      node.style.background = 'linear-gradient(90deg,' + grad + ')';
      node.hidden = false;
    } else {
      node.style.background = '';
      node.hidden = true;
    }
  }

  function syncSelect(select) {
    if (!select || !select.__combo) return;
    const c = select.__combo;
    const items = itemsOf(select);
    const current = items.filter((i) => i.value === select.value)[0] || items[0];
    c.txt.textContent = current ? current.label : '';
    paintBar(c.bar, current ? current.grad : '');
    c.btn.disabled = !items.length;
    c.wrap.classList.toggle('has-bar', !!(current && current.grad));
    c.list.textContent = '';
    items.forEach((item) => {
      const opt = el('div', 'combo-opt');
      opt.setAttribute('role', 'option');
      opt.appendChild(el('span', 'combo-label', item.label));
      if (item.grad) {
        const bar = el('span', 'combo-bar');
        paintBar(bar, item.grad);
        opt.appendChild(bar);
      }
      opt.dataset.value = item.value;
      if (item.value === select.value) opt.classList.add('selected');
      opt.addEventListener('click', (e) => { e.stopPropagation(); choose(select, item.value); });
      c.list.appendChild(opt);
    });
    c.wrap.hidden = select.hidden;
  }

  function enhanceAll() {
    document.querySelectorAll('select').forEach((select) => {
      if (!select.__combo) build(select);
      syncSelect(select);
    });
  }

  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  // 列表是视口定位的，页面一滚或窗口一变就得收起来，不然会飘在别处。
  // 列表自己内部滚动（选项多）不算，否则滚一下选项菜单就没了
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('.combo-list')) return;
    closeAll();
  }, true);
  window.addEventListener('resize', closeAll);

  window.enhanceAll = enhanceAll;
  window.syncSelect = syncSelect;
}());
