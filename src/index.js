import { DurableObject } from "cloudflare:workers";

// ----------------------------------------------------
// 1. Authentication Helper
// ----------------------------------------------------
function authenticate(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;

  const [scheme, encoded] = authHeader.split(" ");
  if (scheme !== "Basic") return false;

  try {
    const decoded = atob(encoded);
    const [username, password] = decoded.split(":");
    // Validate entering password against DASHBOARD_PASS environment secret
    const passSecret = env.DASHBOARD_PASS || "default-fallback-pass";
    return password === passSecret;
  } catch (e) {
    return false;
  }
}

// ----------------------------------------------------
// 2. Worker Router
// ----------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    // Secure administrative panel route
    if (path === "/stefan") {
      if (!authenticate(request, env)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="Stefan Admin Dashboard"' }
        });
      }
      return new Response(getAdminHTML(url.host), {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    // Serve the lightweight, minimal messenger popup bridge
    if (path === "/messenger") {
      return new Response(getMessengerHTML(), {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    // Proxy WebSocket requests to Durable Object
    if (path === "/ws") {
      const role = url.searchParams.get("role") || "client";
      
      // Enforce security lock on admin web sockets
      if (role === "admin" && !authenticate(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const id = env.STEFAN_DO.idFromName("global-test-session");
      const stub = env.STEFAN_DO.get(id);
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

// ----------------------------------------------------
// 3. Durable Object with Persistent Local Storage
// ----------------------------------------------------
export class StefanDO extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const role = url.searchParams.get("role") || "client";
      const sessionId = crypto.randomUUID();

      this.state.acceptWebSocket(server);

      server.serializeAttachment({
        sessionId,
        role,
        username: "Connecting...",
        path: "Home",
        status: "active"
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not Found", { status: 404 });
  }

  // --- WebSocket Event Forwarding & Storage Handlers ---

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return;
    }

    const attachment = ws.deserializeAttachment() || {};

    if (data.type === "register") {
      attachment.username = data.username || "Anonymous";
      ws.serializeAttachment(attachment);

      this.notifyAdminsOfClientUpdate();
    } 
    
    else if (data.type === "admin_init" && attachment.role === "admin") {
      // Send both active user presence grid and historical metrics table
      this.sendInitialAdminPayload(ws);
    } 
    
    else if (data.type === "presence_update") {
      attachment.path = data.path || "Home";
      attachment.status = data.status || "active";
      ws.serializeAttachment(attachment);

      this.notifyAdminsOfClientUpdate();
    }

    else if (data.type === "track_data") {
      // Ingest 5-minute local aggregation tracking metrics from Bob's tab
      const trackingPayload = data.data || {};
      const dateStr = new Date().toISOString().split('T')[0];
      const storageKey = `user:${attachment.username}:date:${dateStr}`;

      let currentMetrics = await this.state.storage.get(storageKey) || { kyc: 0, processing: 0, audit: 0, idle: 0 };
      
      currentMetrics.kyc += (trackingPayload.kyc || 0);
      currentMetrics.processing += (trackingPayload.processing || 0);
      currentMetrics.audit += (trackingPayload.audit || 0);
      currentMetrics.idle += (trackingPayload.idle || 0);

      await this.state.storage.put(storageKey, currentMetrics);

      // Instantly update active administrator charts/tables
      this.notifyAdminsOfHistoricalUpdate();
    }

    else if (data.type === "reply") {
      this.broadcastToAdmins({
        type: "client_reply",
        sessionId: attachment.sessionId,
        username: attachment.username,
        text: data.text
      });
    } 
    
    else if (data.type === "broadcast" && attachment.role === "admin") {
      this.broadcastToClients({
        type: "broadcast",
        text: data.text
      });
    } 
    
    else if (data.type === "direct_message" && attachment.role === "admin") {
      this.sendToClient(data.targetSessionId, {
        type: "direct_message",
        text: data.text
      });
    }

    else if (data.type === "force_reload_all" && attachment.role === "admin") {
      this.broadcastToClients({ type: "force_reload" });
    }

    else if (data.type === "force_reload_user" && attachment.role === "admin") {
      this.sendToClient(data.targetSessionId, { type: "force_reload" });
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const attachment = ws.deserializeAttachment();
    if (attachment && attachment.role === "client") {
      this.notifyAdminsOfClientUpdate();
    }
  }

  async webSocketError(ws, error) {
    const attachment = ws.deserializeAttachment();
    if (attachment && attachment.role === "client") {
      this.notifyAdminsOfClientUpdate();
    }
  }

  // --- Dispatch Utilities ---

  async sendInitialAdminPayload(ws) {
    // 1. Gather active users grid
    const clients = [];
    const sockets = this.state.getWebSockets();
    for (const s of sockets) {
      const att = s.deserializeAttachment();
      if (att && att.role === "client") {
        clients.push({ 
          sessionId: att.sessionId, 
          username: att.username,
          path: att.path,
          status: att.status
        });
      }
    }

    // 2. Fetch all historical metric logs
    const historyList = [];
    const logs = await this.state.storage.list({ prefix: "user:" });
    for (const [key, val] of logs.entries()) {
      const parts = key.split(":");
      const user = parts[1];
      const date = parts[3];
      historyList.push({ user, date, ...val });
    }

    ws.send(JSON.stringify({ type: "client_list", clients }));
    ws.send(JSON.stringify({ type: "history_list", history: historyList }));
  }

  notifyAdminsOfClientUpdate() {
    const clients = [];
    const sockets = this.state.getWebSockets();
    for (const s of sockets) {
      const att = s.deserializeAttachment();
      if (att && att.role === "client") {
        clients.push({ 
          sessionId: att.sessionId, 
          username: att.username,
          path: att.path,
          status: att.status
        });
      }
    }
    this.broadcastToAdmins({ type: "client_list", clients });
  }

  async notifyAdminsOfHistoricalUpdate() {
    const historyList = [];
    const logs = await this.state.storage.list({ prefix: "user:" });
    for (const [key, val] of logs.entries()) {
      const parts = key.split(":");
      const user = parts[1];
      const date = parts[3];
      historyList.push({ user, date, ...val });
    }
    this.broadcastToAdmins({ type: "history_list", history: historyList });
  }

  broadcastToAdmins(msg) {
    const sockets = this.state.getWebSockets();
    const payload = JSON.stringify(msg);
    for (const ws of sockets) {
      const att = ws.deserializeAttachment();
      if (att && att.role === "admin") {
        ws.send(payload);
      }
    }
  }

  broadcastToClients(msg) {
    const sockets = this.state.getWebSockets();
    const payload = JSON.stringify(msg);
    for (const ws of sockets) {
      const att = ws.deserializeAttachment();
      if (att && att.role === "client") {
        ws.send(payload);
      }
    }
  }

  sendToClient(sessionId, msg) {
    const sockets = this.state.getWebSockets();
    const payload = JSON.stringify(msg);
    for (const ws of sockets) {
      const att = ws.deserializeAttachment();
      if (att && att.role === "client" && att.sessionId === sessionId) {
        ws.send(payload);
        break;
      }
    }
  }
}

// ----------------------------------------------------
// 4. Admin Control Panel Template
// ----------------------------------------------------
function getAdminHTML(host) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stefan's Control Panel</title>
  <style>
    :root {
      --bg-color: #0f172a;
      --card-bg: #1e293b;
      --border-color: #334155;
      --text-color: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #10b981;
      --danger: #ef4444;
      --danger-hover: #dc2626;
    }
    body {
      background-color: var(--bg-color);
      color: var(--text-color);
      font-family: system-ui, -apple-system, sans-serif;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    header {
      border-bottom: 1px solid var(--border-color);
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    header h1 { margin: 0; font-size: 1.25rem; font-weight: 600; }
    .status-badge { display: flex; align-items: center; gap: 12px; font-size: 0.875rem; color: var(--text-muted); }
    .indicator { width: 8px; height: 8px; border-radius: 50%; background-color: #ef4444; }
    .indicator.online { background-color: var(--success); }
    main { flex: 1; display: flex; overflow: hidden; }
    .sidebar { width: 320px; border-right: 1px solid var(--border-color); display: flex; flex-direction: column; padding: 20px; box-sizing: border-box; background-color: #0b0f19; }
    .sidebar h2 { font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-top: 0; margin-bottom: 12px; }
    .user-list { list-style: none; padding: 0; margin: 0; flex: 1; overflow-y: auto; }
    .user-item { padding: 10px 12px; border-radius: 8px; margin-bottom: 8px; cursor: pointer; font-size: 0.9rem; transition: background 0.15s ease; display: flex; justify-content: space-between; align-items: center; }
    .user-item:hover { background-color: var(--card-bg); }
    .user-item-actions { display: flex; gap: 8px; align-items: center; }
    .user-item-btn { background: #1e293b; border: 1px solid var(--border-color); color: var(--text-muted); font-size: 11px; padding: 2px 6px; border-radius: 4px; cursor: pointer; }
    .user-item-btn:hover { color: var(--text-color); background: var(--border-color); }
    .user-item-path { font-size: 11px; color: var(--accent); padding: 1px 4px; border-radius: 4px; background: rgba(59, 130, 246, 0.1); }
    .user-item-idle { color: #f59e0b; background: rgba(245, 158, 11, 0.1); font-size: 11px; padding: 1px 4px; border-radius: 4px; }
    .content { flex: 1; display: flex; flex-direction: column; padding: 24px; overflow-y: auto; box-sizing: border-box; gap: 20px; }
    .section-card { background-color: var(--card-bg); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; }
    .form-group { display: flex; flex-direction: column; gap: 8px; }
    .form-group label { font-size: 0.875rem; font-weight: 500; }
    .input-row { display: flex; gap: 12px; }
    input[type="text"] { flex: 1; background-color: #0f172a; border: 1px solid var(--border-color); color: var(--text-color); padding: 12px 16px; border-radius: 8px; font-size: 0.95rem; outline: none; transition: border-color 0.15s ease; }
    input[type="text"]:focus { border-color: var(--accent); }
    button { background-color: var(--accent); color: #fff; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; cursor: pointer; transition: background-color 0.15s ease; }
    button:hover { background-color: var(--accent-hover); }
    button.danger-btn { background-color: var(--danger); }
    button.danger-btn:hover { background-color: var(--danger-hover); }
    
    /* Historical table styles */
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.9rem; text-align: left; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--border-color); }
    th { color: var(--text-muted); font-weight: 600; }
    tr:hover { background: rgba(255,255,255,0.02); }

    .stream-section h2 { font-size: 1.1rem; margin-top: 0; margin-bottom: 16px; }
    .stream { display: flex; flex-direction: column; gap: 12px; }
    .msg-card { background-color: var(--card-bg); border: 1px solid var(--border-color); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
    .msg-header { display: flex; justify-content: space-between; font-size: 0.85rem; }
    .msg-user { font-weight: 600; color: var(--accent); }
    .msg-time { color: var(--text-muted); }
    .msg-body { font-size: 0.95rem; line-height: 1.4; }
    .reply-area { display: flex; gap: 10px; margin-top: 8px; border-top: 1px solid var(--border-color); padding-top: 12px; }
    .reply-area input { padding: 8px 12px; font-size: 0.875rem; }
    .reply-area button { padding: 8px 16px; font-size: 0.875rem; }
  </style>
</head>
<body>
  <header>
    <h1>Stefan's Control Panel</h1>
    <div class="status-badge">
      <button id="refresh-all-btn" class="user-item-btn danger-btn" style="color:white; padding: 6px 12px;">Refresh All Connected Pages</button>
      <div id="status-indicator" class="indicator"></div>
      <span id="status-text">Disconnected</span>
    </div>
  </header>
  <main>
    <div class="sidebar">
      <h2>Connected Users</h2>
      <ul id="user-list" class="user-list"></ul>
    </div>
    <div class="content">
      <!-- 1. Broadcast Card -->
      <div class="section-card">
        <div class="form-group">
          <label for="broadcast-input">Stefan says... (Broadcast to Everyone)</label>
          <div class="input-row">
            <input type="text" id="broadcast-input" placeholder="Type a message to send to everyone...">
            <button id="broadcast-btn">Say</button>
          </div>
        </div>
      </div>

      <!-- 2. Direct Messaging Card (No Reply Required) -->
      <div class="section-card" id="whisper-card" style="opacity: 0.5;">
        <div class="form-group">
          <label id="whisper-label">Stefan whispers... (Select a user from the sidebar list first)</label>
          <div class="input-row">
            <input type="text" id="whisper-input" placeholder="Select a user to enable direct messaging..." disabled>
            <button id="whisper-btn" disabled>Whisper</button>
          </div>
        </div>
      </div>

      <!-- 3. Historical Analytics Ledger -->
      <div class="section-card">
        <h3>Productivity Ledger (Daily Metrics)</h3>
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Date</th>
              <th>/kyc (Active)</th>
              <th>/processing (Active)</th>
              <th>/audit (Active)</th>
              <th>Idle Duration</th>
              <th>Active Total</th>
            </tr>
          </thead>
          <tbody id="history-table-body">
            <tr>
              <td colspan="7" style="text-align: center; color: var(--text-muted);">No metrics compiled yet.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 4. Activity Feed -->
      <div class="stream-section">
        <h2>Live Activity Feed & Replies</h2>
        <div id="activity-stream" class="stream"></div>
      </div>
    </div>
  </main>

  <script>
    const userList = document.getElementById('user-list');
    const activityStream = document.getElementById('activity-stream');
    const broadcastInput = document.getElementById('broadcast-input');
    const broadcastBtn = document.getElementById('broadcast-btn');
    const whisperCard = document.getElementById('whisper-card');
    const whisperLabel = document.getElementById('whisper-label');
    const whisperInput = document.getElementById('whisper-input');
    const whisperBtn = document.getElementById('whisper-btn');
    const refreshAllBtn = document.getElementById('refresh-all-btn');
    const historyTableBody = document.getElementById('history-table-body');
    const statusIndicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    let ws;
    let selectedUser = null; 
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = \`\${protocol}//\${window.location.host}/ws?role=admin\`;

    function connect() {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        statusIndicator.classList.add('online');
        statusText.textContent = 'Connected';
        ws.send(JSON.stringify({ type: 'admin_init' }));
      };

      ws.onclose = () => {
        statusIndicator.classList.remove('online');
        statusText.textContent = 'Disconnected (Reconnecting...)';
        setTimeout(connect, 3000);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      };
    }

    function handleMessage(msg) {
      if (msg.type === 'client_list') {
        userList.innerHTML = '';
        msg.clients.forEach(addConnectedUser);
      } else if (msg.type === 'client_connected') {
        addConnectedUser(msg);
        addActivity('System', \`\s\${msg.username} connected\`);
      } else if (msg.type === 'client_disconnected') {
        const item = document.getElementById(\`user-\${msg.sessionId}\`);
        if (item) item.remove();
        if (selectedUser && selectedUser.sessionId === msg.sessionId) {
          deselectUser();
        }
        addActivity('System', \`User disconnected\`);
      } else if (msg.type === 'client_reply') {
        addActivity(msg.username, msg.text, msg.sessionId);
      } else if (msg.type === 'history_list') {
        renderHistoryTable(msg.history);
      }
    }

    function addConnectedUser(user) {
      if (document.getElementById(\`user-\${user.sessionId}\`)) return;

      const li = document.createElement('li');
      li.className = 'user-item';
      li.id = \`user-\${user.sessionId}\`;
      
      const pathBadge = user.path !== "Home" ? \`<span class="user-item-path">/\${user.path}</span>\` : '';
      const idleBadge = user.status === "idle" ? \`<span class="user-item-idle">Idle</span>\` : '';

      li.innerHTML = \`
        <div style="display:flex; flex-direction:column; gap:4px;">
          <span class="user-item-name" style="font-weight: 500;">\${escapeHtml(user.username)}</span>
          <div style="display:flex; gap:6px;">\${pathBadge}\${idleBadge}</div>
        </div>
        <div class="user-item-actions">
          <button class="user-item-btn refresh-user-btn" data-id="\${user.sessionId}">Refresh</button>
          <span class="id-label" style="font-size:11px; color:var(--text-muted);">\${user.sessionId.slice(0, 4)}</span>
        </div>
      \`;

      li.addEventListener('click', (e) => {
        if (e.target.classList.contains('refresh-user-btn')) return; 
        selectUser(user);
      });

      li.querySelector('.refresh-user-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(\`Force reload \${user.username}'s active page?\`)) {
          ws.send(JSON.stringify({ type: 'force_reload_user', targetSessionId: user.sessionId }));
        }
      });

      userList.appendChild(li);
    }

    function selectUser(user) {
      selectedUser = user;
      whisperCard.style.opacity = "1";
      whisperLabel.innerHTML = \`Stefan whispers to <strong style="color:var(--accent);">\${escapeHtml(user.username)}</strong>:\`;
      whisperInput.disabled = false;
      whisperBtn.disabled = false;
      whisperInput.placeholder = \`Type a whisper directly to \${user.username}...\`;
      whisperInput.focus();
    }

    function deselectUser() {
      selectedUser = null;
      whisperCard.style.opacity = "0.5";
      whisperLabel.textContent = "Stefan whispers... (Select a user from the sidebar list first)";
      whisperInput.disabled = true;
      whisperBtn.disabled = true;
      whisperInput.value = "";
      whisperInput.placeholder = "Select a user to enable direct messaging...";
    }

    function renderHistoryTable(history) {
      if (!history || history.length === 0) {
        historyTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No metrics compiled yet.</td></tr>';
        return;
      }

      // Sort logs by date desc, then user asc
      history.sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return a.user.localeCompare(b.user);
      });

      historyTableBody.innerHTML = history.map(row => {
        const kycMin = (row.kyc / 60).toFixed(1);
        const procMin = (row.processing / 60).toFixed(1);
        const auditMin = (row.audit / 60).toFixed(1);
        const idleMin = (row.idle / 60).toFixed(1);
        const totalActiveMin = ((row.kyc + row.processing + row.audit) / 60).toFixed(1);

        return \`
          <tr>
            <td style="font-weight:600;">\${escapeHtml(row.user)}</td>
            <td>\${row.date}</td>
            <td>\${kycMin}m</td>
            <td>\${procMin}m</td>
            <td>\${auditMin}m</td>
            <td style="color: #f59e0b;">\${idleMin}m</td>
            <td style="font-weight:600; color:var(--success);">\${totalActiveMin}m</td>
          </tr>
        \`;
      }).join('');
    }

    function addActivity(username, text, sessionId = null) {
      const card = document.createElement('div');
      card.className = 'msg-card';
      const timeStr = new Date().toLocaleTimeString();

      let replyMarkup = '';
      if (sessionId) {
        replyMarkup = \`
          <div class="reply-area">
            <input type="text" id="reply-to-\${sessionId}" placeholder="Reply directly to \${escapeHtml(username)}..." onkeydown="if (event.key === 'Enter') { event.preventDefault(); window.sendDirect('\${sessionId}', '\${username}'); }">
            <button onclick="sendDirect('\${sessionId}', '\${username}')">Send Reply</button>
          </div>
        \`;
      }

      card.innerHTML = \`
        <div class="msg-header">
          <span class="msg-user">\${escapeHtml(username)}</span>
          <span class="msg-time">\${timeStr}</span>
        </div>
        <div class="msg-body">\${escapeHtml(text)}</div>
        \${replyMarkup}
      \`;

      activityStream.insertBefore(card, activityStream.firstChild);
    }

    refreshAllBtn.onclick = () => {
      if (confirm("Force reload all connected client pages?")) {
        ws.send(JSON.stringify({ type: 'force_reload_all' }));
      }
    };

    broadcastInput.onkeydown = function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        broadcastBtn.click();
      }
    };

    broadcastBtn.onclick = () => {
      const text = broadcastInput.value.trim();
      if (text) {
        ws.send(JSON.stringify({ type: 'broadcast', text }));
        addActivity('You (Broadcast)', text);
        broadcastInput.value = '';
      }
    };

    whisperInput.onkeydown = function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        whisperBtn.click();
      }
    };

    whisperBtn.onclick = () => {
      const text = whisperInput.value.trim();
      if (text && selectedUser) {
        ws.send(JSON.stringify({
          type: 'direct_message',
          targetSessionId: selectedUser.sessionId,
          text
        }));
        addActivity(\`You (Whispered to \${selectedUser.username})\`, text);
        whisperInput.value = '';
      }
    };

    window.sendDirect = (sessionId, username) => {
      const input = document.getElementById(\`reply-to-\${sessionId}\`);
      const text = input.value.trim();
      if (text) {
        ws.send(JSON.stringify({
          type: 'direct_message',
          targetSessionId: sessionId,
          text
        }));
        addActivity(\`You (Direct to \${username})\`, text);
        input.value = '';
      }
    };

    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    connect();
  </script>
</body>
</html>`;
}

// ----------------------------------------------------
// 5. Ominous Messenger Popup Helper HTML
// ----------------------------------------------------
function getMessengerHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>...</title>
  <style>
    body {
      background: #090d16;
      color: #475569;
      font-family: -apple-system, system-ui, monospace;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
      user-select: none;
    }
    h3 { color: #94a3b8; font-size: 16px; font-weight: 300; letter-spacing: 0.15em; margin: 0; }
  </style>
</head>
<body>
  <div>
    <h3>I'm watching</h3>
  </div>

  <script>
    const params = new URLSearchParams(window.location.search);
    const username = params.get('username') || 'Guest';

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = \`\${protocol}//\${window.location.host}/ws?role=client\`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', username: username }));
    };

    ws.onmessage = (event) => {
      if (window.opener) {
        window.opener.postMessage({
          source: 'stefan-bridge',
          type: 'ws-message',
          data: JSON.parse(event.data)
        }, '*');
      }
    };

    window.addEventListener('message', (event) => {
      // Respond immediately to the parent's heartbeat ping to bypass background throttling
      if (event.data && event.data.type === 'ping') {
        event.source.postMessage({ type: 'pong' }, event.origin);
      }
      
      // Receive replies from parent and push to WebSocket
      if (event.data && event.data.type === 'reply') {
        ws.send(JSON.stringify({ type: 'reply', text: event.data.text }));
      }
    });
  </script>
</body>
</html>`;
}
