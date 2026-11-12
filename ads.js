/* Full-screen ad gate: shown on every app load, then dismissed by the user.
   - If AdSense isn't configured, a labelled placeholder is shown.
   - If the device is offline or no ad fills, the gate closes itself so the app
     never gets stuck behind an empty screen. */
(function () {
  'use strict';
  var cfg = window.CRIMSONCUT_CONFIG || {};
  var gate = document.getElementById('adGate');
  var body = document.getElementById('adBody');
  var btn = document.getElementById('adClose');
  var count = document.getElementById('adCount');
  if (!gate) return;

  var configured = /^ca-pub-\d{10,}$/.test(cfg.adsenseClient || '') && !/^ca-pub-0+$/.test(cfg.adsenseClient) &&
                   /^\d{6,}$/.test(cfg.adsenseSlot || '') && !/^0+$/.test(cfg.adsenseSlot);
  var secs = Math.max(3, cfg.adSeconds || 5);
  var closed = false, timer = null;

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    gate.classList.add('hide');
    setTimeout(function () { gate.remove(); }, 400);
  }

  function startCountdown() {
    if (timer) return;
    var left = secs;
    count.textContent = left;
    timer = setInterval(function () {
      left--;
      if (left > 0) { count.textContent = left; return; }
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = 'Continue ›';
    }, 1000);
  }

  btn.addEventListener('click', close);

  if (!configured) {
    var ph = document.createElement('div');
    ph.className = 'ph';
    ph.innerHTML = '<b>Ad space</b><span>Add your AdSense publisher ID and ad unit slot to <code>config.js</code> and a real full-screen ad appears here.</span>';
    body.innerHTML = '';
    body.appendChild(ph);
    startCountdown();
    return;
  }

  if (!navigator.onLine) { close(); return; }

  var ins = document.createElement('ins');
  ins.className = 'adsbygoogle';
  ins.setAttribute('data-ad-client', cfg.adsenseClient);
  ins.setAttribute('data-ad-slot', cfg.adsenseSlot);
  ins.setAttribute('data-ad-format', 'auto');
  ins.setAttribute('data-full-width-responsive', 'true');
  body.innerHTML = '';
  body.appendChild(ins);

  var s = document.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(cfg.adsenseClient);
  s.onerror = close;
  s.onload = function () {
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { close(); }
  };
  document.head.appendChild(s);

  var mo = new MutationObserver(function () {
    var st = ins.getAttribute('data-ad-status');
    if (st === 'unfilled') { mo.disconnect(); close(); }
    else if (st === 'filled') { mo.disconnect(); clearTimeout(fallback); startCountdown(); }
  });
  mo.observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] });

  // If nothing fills within 6s, don't trap the user.
  var fallback = setTimeout(function () { mo.disconnect(); close(); }, 6000);
})();
