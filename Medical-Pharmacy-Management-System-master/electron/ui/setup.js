/* Setup wizard and Connection & Server Settings (runs on app://braintech, uses window.braintech only). */
(() => {
  'use strict';
  const bt = window.braintech;
  const $ = (sel) => document.querySelector(sel);
  const steps = ['step-mode', 'step-source', 'step-admin', 'step-pair', 'step-done', 'step-manage'];
  let chosenMode = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const errMsg = (e) => String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function go(id) {
    for (const s of steps) $(`#${s}`).classList.toggle('hidden', s !== id);
    hideMessages();
    window.scrollTo(0, 0);
  }
  function showError(e) { const el = $('#error'); el.textContent = errMsg(e); el.classList.remove('hidden'); }
  function showNotice(t) { const el = $('#notice'); el.textContent = t; el.classList.remove('hidden'); }
  function hideMessages() { $('#error').classList.add('hidden'); $('#notice').classList.add('hidden'); }
  async function busy(btn, fn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Please wait...';
    try { return await fn(); } catch (e) { showError(e); return undefined; } finally { btn.disabled = false; btn.textContent = label; }
  }

  // ---------- wizard ----------
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    chosenMode = b.dataset.mode;
    if (chosenMode === 'client') { go('step-pair'); scan(); } else go('step-source');
  }));
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => go(b.dataset.back)));

  $('#startFresh').addEventListener('click', (ev) => busy(ev.currentTarget, async () => {
    const r = await bt.setup.startLocal(chosenMode);
    if (r.needsSetup) go('step-admin'); else done(`This computer already has a pharmacy database${r.storeName ? ` for "${r.storeName}"` : ''}. Sign in with an existing account.`);
  }));

  $('#importLegacy').addEventListener('click', (ev) => busy(ev.currentTarget, async () => {
    const r = await bt.setup.importLegacyDatabase(chosenMode);
    if (!r.imported) return;
    const rows = Object.values(r.rowCounts || {}).reduce((a, b) => a + b, 0);
    if (r.needsSetup) { showNotice(`Imported ${rows} records. The old database has no administrator, so create one now.`); go('step-admin'); }
    else done(`Imported ${rows} records from the previous version (the original file was not changed). Existing users sign in with their usual passwords.`);
  }));

  $('#adminForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    if (f.get('password') !== f.get('password2')) return showError('The two passwords are different.');
    const data = {
      storeName: String(f.get('storeName')), ownerName: String(f.get('ownerName')), username: String(f.get('username')),
      password: String(f.get('password')), phone: String(f.get('phone') || ''), address: String(f.get('address') || ''),
      loadDemoData: f.get('loadDemoData') === 'on',
    };
    busy(ev.submitter || $('#adminForm button'), async () => {
      const r = await bt.setup.createAdmin(data);
      done(`Administrator "${r.username}" created for "${data.storeName}". Sign in with this username and password.`);
    });
  });

  async function scan() {
    const box = $('#hosts');
    box.innerHTML = '<p class="muted">Searching...</p>';
    try {
      const hosts = await bt.setup.discoverHosts();
      if (!hosts.length) { box.innerHTML = '<p class="muted">No server answered. Type its address on the right.</p>'; return; }
      box.innerHTML = '';
      for (const h of hosts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'host';
        b.innerHTML = `<strong>${esc(h.hostName)}</strong><small>${esc(h.address)}:${esc(h.port)} &middot; certificate ${esc(h.fingerprintShort)} &middot; v${esc(h.appVersion)}</small>`;
        b.addEventListener('click', () => { $('#pairForm [name=host]').value = h.address; $('#pairForm [name=port]').value = h.port; $('#pairForm [name=code]').focus(); });
        box.appendChild(b);
      }
    } catch (e) { box.innerHTML = `<p class="muted">Search failed: ${esc(errMsg(e))}</p>`; }
  }
  $('#rescan').addEventListener('click', scan);

  $('#pairForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    busy(ev.submitter || $('#pairForm button'), async () => {
      const r = await bt.setup.pairWithHost({ host: String(f.get('host')).trim(), port: Number(f.get('port')), code: String(f.get('code')).trim(), computerName: String(f.get('computerName')).trim() });
      done(`Connected to "${r.hostName}" (server version ${r.serverVersion}). Certificate ${r.fingerprintShort} is now trusted on this computer. Sign in with your usual pharmacy account.`);
    });
  });

  function done(text) { $('#doneSummary').textContent = text; go('step-done'); }
  $('#finish').addEventListener('click', () => bt.setup.finish());

  // ---------- manage ----------
  const pill = (status) => {
    const good = ['CONNECTED'], warn = ['DEGRADED', 'BACKEND_RESTARTING'];
    return `<span class="pill ${good.includes(status) ? 'good' : warn.includes(status) ? 'warn' : 'bad'}">${esc(status)}</span>`;
  };
  async function renderManage() {
    const body = $('#manageBody');
    body.innerHTML = '<p class="muted">Loading...</p>';
    const [info, st] = await Promise.all([bt.getAppInfo(), bt.server.status()]);
    const mode = { standalone: 'Single computer', host: 'Main pharmacy server', client: 'Connected to a pharmacy server' }[info.mode] || 'Not set up';
    let html = `<div class="panel"><dl><dt>This computer</dt><dd>${esc(info.computerName)}</dd><dt>Used as</dt><dd>${esc(mode)}</dd><dt>Version</dt><dd>${esc(info.version)}</dd><dt>Connection</dt><dd>${pill(st.connection?.status || (st.running ? 'CONNECTED' : 'NOT_CONFIGURED'))} ${esc(st.connection?.detail || '')}</dd></dl></div>`;
    if (st.running) {
      html += `<div class="panel"><h3>Server</h3><dl>
        <dt>Server status</dt><dd>${pill('CONNECTED')} running</dd>
        <dt>Network addresses</dt><dd>${esc((st.addresses || []).join(', ') || '(no network connection)')}</dd>
        <dt>Port</dt><dd>${esc(st.port)}</dd>
        <dt>Database</dt><dd>${st.db?.ok ? pill('CONNECTED') + ' healthy' : pill('ERROR')} &middot; schema v${esc(st.db?.schemaVersion)} &middot; ${(Number(st.db?.sizeBytes || 0) / 1048576).toFixed(1)} MB</dd>
        <dt>Last backup</dt><dd>${st.lastBackup ? esc(new Date(st.lastBackup).toLocaleString()) : '<span class="pill warn">none yet</span> (automatic backups arrive in a later update; use Settings &rsaquo; Backup)'}</dd>
        <dt>Certificate</dt><dd><code>${esc(st.fingerprintShort)}</code></dd>
        <dt>Data folder</dt><dd>${esc(st.dataFolder)}</dd></dl></div>`;
      if (info.mode === 'host') {
        html += `<div class="panel"><h3>Pair another computer</h3>
          <p>On the other computer choose <em>Connect to the pharmacy server</em> and enter:</p>
          <dl><dt>Address</dt><dd><strong>${esc((st.addresses || [])[0] || 'this computer\'s IP address')}</strong> port <strong>${esc(st.port)}</strong></dd>
          <dt>Pairing code</dt><dd><span class="bigcode" id="pcode">${esc(st.pairing?.code)}</span> <small class="muted">valid until ${esc(new Date(st.pairing?.expiresAt).toLocaleTimeString())}</small></dd></dl>
          <div class="actions"><button id="rotate" class="ghost" type="button">New code</button></div>
          <p class="hint">Windows Firewall: ${esc(st.firewallHint)}. See the LAN setup guide.</p></div>`;
        const rows = (st.clients || []).map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.last_ip || '')}</td><td>${c.last_seen_at ? esc(new Date(c.last_seen_at).toLocaleString()) : 'never'}</td><td>${c.revoked_at ? '<span class="pill bad">removed</span>' : `<button class="ghost" data-revoke="${Number(c.id)}" type="button">Remove</button>`}</td></tr>`).join('');
        html += `<div class="panel"><h3>Paired computers (${esc(st.connectedClients)} online now)</h3>${rows ? `<table><tr><th>Name</th><th>Last address</th><th>Last seen</th><th></th></tr>${rows}</table>` : '<p class="muted">None yet.</p>'}</div>`;
      }
    } else if (st.client) {
      html += `<div class="panel"><h3>Pharmacy server</h3><dl><dt>Server</dt><dd>${esc(st.client.hostName)}</dd><dt>Address</dt><dd>${esc(st.client.address)}:${esc(st.client.port)}</dd><dt>Trusted certificate</dt><dd><code>${esc(st.client.fingerprintShort)}</code></dd></dl>
        <p class="hint">If the server's address changed or it shows "certificate changed", choose "Change how this computer is used" and pair again.</p></div>`;
    }
    body.innerHTML = html;
    $('#rotate')?.addEventListener('click', async () => { try { await bt.server.rotatePairingCode(); renderManage(); } catch (e) { showError(e); } });
    body.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => { try { await bt.server.revokeClient(Number(b.dataset.revoke)); renderManage(); } catch (e) { showError(e); } }));
  }
  $('#changeMode').addEventListener('click', async () => { try { await bt.resetConnection(); } catch (e) { showError(e); } });
  $('#backToApp').addEventListener('click', () => bt.setup.finish());

  // ---------- start ----------
  (async () => {
    try {
      const info = await bt.getAppInfo();
      $('#version').textContent = `Version ${info.version}`;
      $('#pairForm [name=computerName]').value = info.computerName || '';
      if (location.hash === '#manage') {
        $('#backToApp').classList.toggle('hidden', !info.mode);
        go('step-manage');
        await renderManage();
        return;
      }
      const st = await bt.setup.getState();
      if (st.mode && st.mode !== 'client' && st.needsSetup) { chosenMode = st.mode; go('step-admin'); return; }
      go('step-mode');
    } catch (e) { go('step-mode'); showError(e); }
  })();
})();
