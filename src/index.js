import { DurableObject } from "cloudflare:workers";

// ----------------------------------------------------
// 1. Worker Router
// ----------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Normalize path (strips trailing slashes to prevent route mismatch)
    const path = url.pathname.replace(/\/$/, "");

    // Diagnostic Route (Developer Debugging Console)
    if (path === "/debug") {
      return await serveDebugPage(request, env);
    }

    // Serve the live admin control panel
    if (path === "/stefan") {
      return new Response(getAdminHTML(url.host), {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    // Serve the lightweight CSP-Bypass popup messenger
    if (path === "/messenger") {
      return new Response(getMessengerHTML(), {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    // Proxy WebSocket requests to our single coordinator Durable Object
    if (path === "/ws") {
      const id = env.STEFAN_DO.idFromName("global-test-session");
      const stub = env.STEFAN_DO.get(id);
      return stub.fetch(request);
    }

    // Catch-all 404 displaying the exact path evaluated
    return new Response(
      `Route Not Found: "${url.pathname}". Please check your deployment or visit /debug to diagnose.`, 
      { status: 404 }
    );
  }
};

// ----------------------------------------------------
// 2. Durable Object utilizing Hibernation API
// ----------------------------------------------------
export class StefanDO extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Internal loopback route used for health diagnostics
    if (url.pathname === "/test-conn") {
      return new Response("OK", { status: 200 });
    }

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const role = url.searchParams.get("role") || "client";
      const sessionId = crypto.randomUUID();

      this.state.acceptWebSocket(server);

      server.serializeAttachment({
        sessionId,
        role,
        username: "Connecting..."
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not Found", { status: 404 });
  }

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

      this.broadcastToAdmins({
        type: "client_connected",
        sessionId: attachment.sessionId,
        username: attachment.username
      });
    } 
    
    else if (data.type === "admin_init" && attachment.role === "admin") {
      const clients = [];
      const sockets = this.state.getWebSockets();
      for (const s of sockets) {
        const att = s.deserializeAttachment();
        if (att && att.role === "client") {
          clients.push({ sessionId: att.sessionId, username: att.username });
        }
      }
      ws.send(JSON.stringify({ type: "client_list", clients }));
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
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const attachment = ws.deserializeAttachment();
    if (attachment && attachment.role === "client") {
      this.broadcastToAdmins({
        type: "client_disconnected",
        sessionId: attachment.sessionId
      });
    }
  }

  async webSocketError(ws, error) {
    const attachment = ws.deserializeAttachment();
    if (attachment && attachment.role === "client") {
      this.broadcastToAdmins({
        type: "client_disconnected",
        sessionId: attachment.sessionId
      });
    }
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
// 3. Admin Panel HTML Template
// ----------------------------------------------------
function getAdminHTML(host) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stefan's Live Test Control Panel</title>
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
    header h1 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
    }
    .status-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    .indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: #ef4444;
    }
    .indicator.online {
      background-color: var(--success);
    }
    main {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    .sidebar {
      width: 280px;
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      padding: 20px;
      box-sizing: border-box;
      background-color: #0b0f19;
    }
    .sidebar h2 {
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-top: 0;
      margin-bottom: 12px;
    }
    .user-list {
      list-style: none;
      padding: 0;
      margin: 0;
      flex: 1;
      overflow-y: auto;
    }
    .user-item {
      padding: 10px 12px;
      border-radius: 8px;
      margin-bottom: 8px;
      cursor: pointer;
      font-size: 0.9rem;
      transition: background 0.15s ease;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .user-item:hover {
      background-color: var(--card-bg);
    }
    .user-item .id-label {
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 24px;
      overflow-y: auto;
      box-sizing: border-box;
      gap: 24px;
    }
    .broadcast-section {
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 20px;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .form-group label {
      font-size: 0.875rem;
      font-weight: 500;
    }
    .input-row {
      display: flex;
      gap: 12px;
    }
    input[type="text"] {
      flex: 1;
      background-color: #0f172a;
      border: 1px solid var(--border-color);
      color: var(--text-color);
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.15s ease;
    }
    input[type="text"]:focus {
      border-color: var(--accent);
    }
    button {
      background-color: var(--accent);
      color: #fff;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }
    button:hover {
      background-color: var(--accent-hover);
    }
    .stream-section h2 {
      font-size: 1.1rem;
      margin-top: 0;
      margin-bottom: 16px;
    }
    .stream {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .msg-card {
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .msg-header {
      display: flex;
      justify-content: space-between;
      font-size: 0.85rem;
    }
    .msg-user {
      font-weight: 600;
      color: var(--accent);
    }
    .msg-time {
      color: var(--text-muted);
    }
    .msg-body {
      font-size: 0.95rem;
      line-height: 1.4;
    }
    .reply-area {
      display: flex;
      gap: 10px;
      margin-top: 8px;
      border-top: 1px solid var(--border-color);
      padding-top: 12px;
    }
    .reply-area input {
      padding: 8px 12px;
      font-size: 0.875rem;
    }
    .reply-area button {
      padding: 8px 16px;
      font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <header>
    <h1>Stefan's Live Test Control Panel</h1>
    <div class="status-badge">
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
      <div class="broadcast-section">
        <div class="form-group">
          <label for="broadcast-input">Send Global Broadcast Notification</label>
          <div class="input-row">
            <input type="text" id="broadcast-input" placeholder="Type a message to send to all bookmarklet clients...">
            <button id="broadcast-btn">Broadcast</button>
          </div>
        </div>
      </div>
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
    const statusIndicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    let ws;
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
        addActivity('System', \`User disconnected\`);
      } else if (msg.type === 'client_reply') {
        addActivity(msg.username, msg.text, msg.sessionId);
      }
    }

    function addConnectedUser(user) {
      if (document.getElementById(\`user-\${user.sessionId}\`)) return;

      const li = document.createElement('li');
      li.className = 'user-item';
      li.id = \`user-\${user.sessionId}\`;
      li.innerHTML = \`
        <span>\${escapeHtml(user.username)}</span>
        <span class="id-label">\${user.sessionId.slice(0, 4)}</span>
      \`;
      li.onclick = () => {
        const directInput = document.getElementById(\`reply-to-\${user.sessionId}\`);
        if (directInput) {
          directInput.focus();
        } else {
          broadcastInput.value = \`@\${user.username} \`;
          broadcastInput.focus();
        }
      };
      userList.appendChild(li);
    }

    function addActivity(username, text, sessionId = null) {
      const card = document.createElement('div');
      card.className = 'msg-card';
      const timeStr = new Date().toLocaleTimeString();

      let replyMarkup = '';
      if (sessionId) {
        replyMarkup = \`
          <div class="reply-area">
            <input type="text" id="reply-to-\${sessionId}" placeholder="Reply directly to \${escapeHtml(username)}...">
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

    broadcastBtn.onclick = () => {
      const text = broadcastInput.value.trim();
      if (text) {
        ws.send(JSON.stringify({ type: 'broadcast', text }));
        addActivity('You (Global Broadcast)', text);
        broadcastInput.value = '';
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
// 4. Messenger Popup Helper HTML
// ----------------------------------------------------
function getMessengerHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Stefan's Connection Bridge</title>
  <style>
    body {
      background: #0f172a;
      color: #94a3b8;
      font-family: -apple-system, system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
    }
    h3 { color: #f8fafc; margin: 0 0 8px 0; font-size: 16px; }
    p { font-size: 13px; margin: 0; padding: 0 16px; line-height: 1.4; }
    #status { font-weight: 700; color: #ef4444; margin-top: 14px; font-size: 12px; }
  </style>
</head>
<body>
  <div>
    <h3>Connection Active</h3>
    <p>This window routes real-time events to your host tab.</p>
    <p style="color: #64748b; font-size: 11px; margin-top: 4px;">Minimize this window, but do not close it.</p>
    <div id="status">Connecting...</div>
  </div>

  <script>
    const params = new URLSearchParams(window.location.search);
    const username = params.get('username') || 'Guest';

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = \`\${protocol}//\${window.location.host}/ws?role=client\`;
    const ws = new WebSocket(wsUrl);
    const statusEl = document.getElementById('status');

    ws.onopen = () => {
      statusEl.textContent = 'Connected Successfully';
      statusEl.style.color = '#10b981';
      ws.send(JSON.stringify({ type: 'register', username: username }));
    };

    ws.onclose = () => {
      statusEl.textContent = 'Disconnected';
      statusEl.style.color = '#ef4444';
    };

    ws.onerror = () => {
      statusEl.textContent = 'Connection Error';
      statusEl.style.color = '#ef4444';
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
      if (event.data && event.data.type === 'reply') {
        ws.send(JSON.stringify({ type: 'reply', text: event.data.text }));
      }
    });
  </script>
</body>
</html>`;
}

// ----------------------------------------------------
// 5. Developer Mode Diagnostic Console (Self-Contained)
// ----------------------------------------------------
async function serveDebugPage(request, env) {
  let doStatus = "Durable Object binding not found in the environment context.";
  let bindingFound = "No";

  if (env.STEFAN_DO) {
    bindingFound = "Yes (STEFAN_DO exists)";
    try {
      const id = env.STEFAN_DO.idFromName("global-test-session");
      const stub = env.STEFAN_DO.get(id);
      // Run an internal HTTP loopback fetch call to verify that the DO is responding
      const testRes = await stub.fetch(new Request("https://internal/test-conn"));
      if (testRes.status === 200) {
        doStatus = "Active & Healthy (Internal Loopback Verified)";
      } else {
        doStatus = "Unhealthy (Returned status " + testRes.status + ")";
      }
    } catch (e) {
      doStatus = "Failed connecting internally: " + e.message;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Stefan's Developer Diagnostic Console</title>
  <style>
    body { background: #0b0f19; color: #f8fafc; font-family: monospace; padding: 40px; margin: 0; line-height: 1.5; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 24px; max-width: 700px; margin: 0 auto; }
    h1 { color: #3b82f6; border-bottom: 1px solid #334155; padding-bottom: 12px; margin-top: 0; font-size: 1.5rem; }
    .metric { margin-bottom: 16px; display: flex; justify-content: space-between; border-bottom: 1px dashed #334155; padding-bottom: 8px; }
    .label { color: #94a3b8; font-weight: bold; }
    .val { color: #10b981; }
    .val.error { color: #ef4444; }
    .routes { margin-top: 24px; }
    ul { padding-left: 20px; }
    li { margin-bottom: 6px; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Stefan's Diagnostic Console</h1>
    
    <div class="metric">
      <span class="label">Incoming Request Path:</span>
      <span class="val">${new URL(request.url).pathname}</span>
    </div>

    <div class="metric">
      <span class="label">STEFAN_DO Environment Binding:</span>
      <span class="val ${env.STEFAN_DO ? 'success' : 'error'}">${bindingFound}</span>
    </div>

    <div class="metric">
      <span class="label">Durable Object Health Test:</span>
      <span class="val ${doStatus.includes('Healthy') ? 'success' : 'error'}">${doStatus}</span>
    </div>

    <div class="metric">
      <span class="label">Deployment Domain:</span>
      <span class="val">${new URL(request.url).host}</span>
    </div>

    <div class="routes">
      <h3>Active Router Routes:</h3>
      <ul>
        <li><strong>Control Panel:</strong> <a href="/stefan">/stefan</a></li>
        <li><strong>Popup Messenger Bridge:</strong> <a href="/messenger">/messenger</a></li>
        <li><strong>WebSocket Entry Point:</strong> /ws</li>
        <li><strong>Developer Diagnostics:</strong> <a href="/debug">/debug</a></li>
      </ul>
    </div>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}
