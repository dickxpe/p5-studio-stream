
const http = require("http");
const fs = require("fs");
const path = require("path");
const sqlite3 = require('sqlite3').verbose();
const { URLSearchParams } = require('url');
let uuidv4;
const { saveUUID } = require("./db");
const dbPath = path.join(__dirname, 'uuids.db');
const sharedDb = new sqlite3.Database(dbPath);
let shuttingDown = false;
const staticFileCache = new Map();
const STATIC_CACHE_MAX_AGE_SECONDS = 3600;
const gracefulClose = () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  sharedDb.close(() => {
    process.exit(0);
  });
};
process.once('SIGINT', gracefulClose);
process.once('SIGTERM', gracefulClose);
process.once('exit', () => {
  if (shuttingDown) {
    return;
  }
  try {
    sharedDb.close();
  } catch (err) {
    // ignore close errors during exit
  }
});


const server = http.createServer((req, res) => {
  // Endpoint to get all uuids for a webviewuuid, ordered by insertion
  if (/^\/uuids\/[a-zA-Z0-9]{8}$/.test(req.url)) {
    const webviewuuid = req.url.split("/uuids/")[1];
    sharedDb.all('SELECT uuid, link_index FROM uuids WHERE webviewuuid = ? ORDER BY link_index ASC', [webviewuuid], (err, rows) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
      }
    });
    return;
  }


  if (/^\/webviews\/[a-zA-Z0-9]{8}\/display-mode$/.test(req.url) && req.method === 'POST') {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
      res.end('Authentication required');
      return;
    }
    const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
    const [user, pass] = credentials.split(':');
    const { verifyUser } = require('./db');
    verifyUser(user, pass).then(valid => {
      if (!valid) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
        res.end('Invalid credentials');
        return;
      }
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1e4) {
          req.connection.destroy();
        }
      });
      req.on('end', () => {
        let displayMode = 'flow';
        try {
          const parsed = JSON.parse(body || '{}');
          if (typeof parsed.displayMode === 'string') {
            displayMode = parsed.displayMode.toLowerCase();
          }
        } catch (e) {
          // ignore malformed payloads
        }
        if (displayMode === 'random') {
          displayMode = 'random-fixed';
        }
        const allowedModes = ['flow', 'fixed', 'random-flow', 'random-fixed'];
        if (!allowedModes.includes(displayMode)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid display mode' }));
          return;
        }
        const parts = req.url.split('/');
        const webviewuuid = parts[2];
        sharedDb.run('UPDATE webviews SET display_mode = ? WHERE webviewuuid = ?', [displayMode, webviewuuid], function (err) {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
          }
          if (this.changes === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'UUID not found' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        });
      });
    });
    return;
  }

  // Temporary endpoint to create admin user
  if (req.url === "/create-admin") {
    const { createUser } = require('./db');
    createUser('admin', 'admin')
      .then(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Admin user created: admin / admin');
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error creating admin: ' + err.message);
      });
    return;
  }
  // ...existing code...
  // Handle create-webview POST (must come first)
  if ((req.url === "/create-webview" || req.url === "/create-webview/") && req.method === "POST") {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
      res.end('Authentication required');
      return;
    }
    if (!auth || !auth.startsWith('Basic ')) {
      console.error('Authorization header missing or invalid:', auth);
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
      res.end('Authentication required');
      return;
    }
    const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
    const [user, pass] = credentials.split(':');
    const { verifyUser } = require('./db');
    verifyUser(user, pass).then(valid => {
      if (!valid) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
        res.end('Invalid credentials');
        return;
      }
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1e5) {
          req.connection.destroy();
        }
      });
      req.on('end', () => {
        let rows = 10, columns = 10, width = 100, height = 100;
        try {
          const parsed = body ? JSON.parse(body) : {};
          rows = Math.max(1, Math.min(200, parseInt(parsed.rows, 10) || rows));
          columns = Math.max(1, Math.min(200, parseInt(parsed.columns, 10) || columns));
          width = Math.max(5, Math.min(6000, parseInt(parsed.width, 10) || width));
          height = Math.max(5, Math.min(6000, parseInt(parsed.height, 10) || height));
        } catch (e) { }
        // Generate a new webviewuuid (8 chars)
        const webviewuuid = Array.from({ length: 8 }, () =>
          Math.random().toString(36).charAt(2)
        ).join("");
        const created_at = new Date().toISOString();
        const displayMode = 'flow';
        // Insert new webview into webviews table
        sharedDb.run('INSERT INTO webviews (webviewuuid, rows, columns, width, height, created_at, display_mode) VALUES (?, ?, ?, ?, ?, ?, ?)', [webviewuuid, rows, columns, width, height, created_at, displayMode], function (err) {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('DB error: ' + err.message);
            return;
          }
          seedEmptySlotsForWebview(webviewuuid, rows, columns)
            .then(() => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ uuid: webviewuuid, rows, columns, width, height, created_at, display_mode: displayMode }));
            })
            .catch((seedErr) => {
              res.writeHead(500, { 'Content-Type': 'text/plain' });
              res.end('Failed to initialize slots: ' + seedErr.message);
            });
        });
      });
    });
    return;
  }
  if (req.url.startsWith('/delete-webview/') && req.method === 'DELETE') {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
      res.end('Authentication required');
      return;
    }
    const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
    const [user, pass] = credentials.split(':');
    const { verifyUser } = require('./db');
    verifyUser(user, pass).then(valid => {
      if (!valid) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
        res.end('Invalid credentials');
        return;
      }
      const webviewuuid = req.url.split('/delete-webview/')[1];
      if (!/^[a-zA-Z0-9]{8}$/.test(webviewuuid)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid webviewuuid' }));
        return;
      }
      sharedDb.serialize(() => {
        sharedDb.run('DELETE FROM uuids WHERE webviewuuid = ?', [webviewuuid], function (err1) {
          if (err1) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err1.message }));
            return;
          }
          sharedDb.run('DELETE FROM webviews WHERE webviewuuid = ?', [webviewuuid], function (err2) {
            if (err2) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err2.message }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          });
        });
      });
    });
    return;
  }
  // Endpoint to return all webviews as JSON for AJAX refresh
  if ((req.url === "/manage-webviews" || req.url === "/manage-webviews/") && req.method === "GET") {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
      res.end('Authentication required');
      return;
    }
    const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
    const [user, pass] = credentials.split(':');
    const { verifyUser, getAllWebviews } = require('./db');
    verifyUser(user, pass).then(valid => {
      if (!valid) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
        res.end('Invalid credentials');
        return;
      }
      getAllWebviews().then(webviews => {
        // For each webview, count linked uuids
        const getCounts = (webviews) => Promise.all(webviews.map(w => new Promise((resolve) => {
          sharedDb.get('SELECT COUNT(*) as count FROM uuids WHERE webviewuuid = ? AND uuid IS NOT NULL AND uuid <> ""', [w.webviewuuid], (err, row) => {
            resolve({ ...w, uuidCount: row ? row.count : 0 });
          });
        })));
        getCounts(webviews).then(webviewsWithCounts => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(webviewsWithCounts));
        });
      });
    });
    return;
  }
  // Basic HTTP Auth for /manage
  if (req.url === "/manage") {
    const auth = req.headers['authorization'];
    if ((req.url === "/manage-webviews" || req.url === "/manage-webviews/") && req.method === "GET") {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
      res.end('Authentication required');
      return;
    }
    if (!auth || !auth.startsWith('Basic ')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
      res.end('Authentication required');
      return;
    }
    const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
    const [user, pass] = credentials.split(':');
    const { verifyUser } = require('./db');
    const { getAllWebviews } = require('./db');
    verifyUser(user, pass).then(valid => {
      if (!valid) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Manage"' });
        res.end('Invalid credentials');
        return;
      }
      getAllWebviews().then(webviews => {
        // For each webview, count linked uuids
        const getCounts = (webviews) => Promise.all(webviews.map(w => new Promise((resolve) => {
          sharedDb.get('SELECT COUNT(*) as count FROM uuids WHERE webviewuuid = ? AND uuid IS NOT NULL AND uuid <> ""', [w.webviewuuid], (err, row) => {
            resolve({ ...w, uuidCount: row ? row.count : 0 });
          });
        })));
        getCounts(webviews).then(webviewsWithCounts => {
          const formatDate = (iso) => {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return iso;
            const pad = (n) => String(n).padStart(2, '0');
            return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          };
          const buildModeOptions = (currentMode) => {
            const normalized = (currentMode || 'flow').toLowerCase();
            return ['flow', 'fixed', 'random-flow', 'random-fixed']
              .map(mode => `<option value="${mode}" ${mode === normalized ? 'selected' : ''}>${mode}</option>`)
              .join('');
          };
          const webviewsHtml = webviewsWithCounts.map(w => {
            const y = (w.rows || 10) * (w.columns || 10);
            const createdAt = formatDate(w.created_at);
            const resolution = `${w.width || 100}x${w.height || 100}px`;
            const gridSize = `${w.columns || 10}x${w.rows || 10}`;
            const deleteBtn = w.webviewuuid === 'testuuid'
              ? ''
              : `<button type="button" class="delete-btn" aria-label="Delete" data-uuid="${w.webviewuuid}"><img src="/trash-bin.png" alt="Delete" /></button>`;
            const modeSelector = `<label class="mode-picker">mode
              <select class="mode-select" data-uuid="${w.webviewuuid}">
                ${buildModeOptions(w.display_mode)}
              </select>
            </label>`;
            return `<div class="webview-item">
              <div class="webview-main">
                <div class="webview-heading">
                  <div class="webview-id">
                    <a href="/${w.webviewuuid}" class="webview-link"><span>${w.webviewuuid}</span></a>
                    <span class="webview-count">(${w.uuidCount}/${y} linked)</span>
                  </div>
                </div>
                <div class="webview-meta">
                  <span class="meta-pill">grid ${gridSize}</span>
                  <span class="meta-pill">canvas ${resolution}</span>
                  <span class="meta-pill">created ${createdAt}</span>
                </div>
              </div>
              <div class="webview-actions">${modeSelector}${deleteBtn}</div>
            </div>`;
          }).join('');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <title>Manage Webviews</title>
            <style>
              body {
                font-family: 'Segoe UI', Arial, sans-serif;
                background: #f7fbfd;
                margin: 0;
                padding: 0;
                min-height: 100vh;
                display: flex;
                flex-direction: column;
                align-items: center;
              }
              h1 {
                margin-top: 5vh;
                color: #225577;
                letter-spacing: 1px;
              }
              #webviews {
                margin-top: 2em;
                width: 100%;
                max-width: 640px;
                display: flex;
                flex-direction: column;
                gap: 1em;
              }
              .webview-item {
                background: #fff;
                border-radius: 12px;
                box-shadow: 0 4px 16px rgba(34,102,153,0.08);
                padding: 1em 1.25em;
                display: flex;
                align-items: stretch;
                justify-content: space-between;
                gap: 1em;
                font-size: 1em;
              }
              .webview-main {
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: 0.55em;
              }
              .webview-heading {
                display: flex;
                align-items: center;
                gap: 0.6em;
                flex-wrap: wrap;
              }
              .webview-id {
                display: flex;
                align-items: baseline;
                gap: 0.45em;
                flex-wrap: wrap;
              }
              .webview-link span {
                color: #1f4e79;
                font-weight: 700;
                font-family: monospace;
                font-size: 1.1em;
              }
              .webview-count {
                color: #4b6a85;
                font-size: 0.9em;
                font-weight: 600;
              }
              .webview-meta {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 0.45em;
                font-size: 0.85em;
                color: #587da3;
              }
              .meta-pill {
                background: #eef5fb;
                color: #2a4c6a;
                padding: 0.2em 0.75em;
                border-radius: 999px;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                font-size: 0.74em;
                font-weight: 600;
              }
              button {
                padding: 0.6em 1.5em;
                font-size: 1.1em;
                cursor: pointer;
                border-radius: 6px;
                border: 1px solid #336699;
                background: #eaf4fa;
                color: #225577;
                font-weight: 500;
                margin-top: 1em;
                transition: background 0.2s, color 0.2s;
              }
              button:hover {
                background: #d2e9fa;
                color: #113355;
              }
              .delete-btn {
                margin-top: 0;
                width: 24px;
                height: 24px;
                padding: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
              background:none;
                border:none;
   
              }
              .delete-btn img {
                width: 22px;
                height: 22px;
                pointer-events: none;
              }
              .delete-btn:hover {
                background:none;
              }
              .delete-btn.deleting {
                opacity: 0.5;
                cursor: wait;
              }
              .webview-actions {
                display: flex;
                align-items: center;
                gap: 0.75em;
                flex-wrap: wrap;
                justify-content: flex-end;
              }
              .mode-picker {
                display: flex;
                align-items: center;
                gap: 0.4em;
                font-size: 0.85em;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: #446688;
              }
              .mode-picker select {
                border-radius: 6px;
                border: 1px solid #bcd3e6;
                padding: 0.2em 0.8em;
                font-size: 0.95em;
                text-transform: none;
              }
            </style>
          </head>
          <body>
            <h1>Manage Webviews</h1>
            <div style="margin-bottom:1em; display: flex; flex-wrap: wrap; gap: 1em; align-items: center;">
              <label for="rows">Rows:</label>
              <input id="rows" type="number" min="1" max="800" value="3" style="width:60px;">
              <label for="columns">Columns:</label>
              <input id="columns" type="number" min="1" max="600" value="3" style="width:60px;">
              <label for="width">Width:</label>
              <input id="width" type="number" min="1" max="800" value="600" style="width:60px;">
              <label for="height">Height:</label>
              <input id="height" type="number" min="1" max="600" value="400" style="width:60px;">
            </div>
            <button onclick="createWebview()">Create Webview</button>
            <div id="webviews">${webviewsHtml}</div>
            <script>
              function authenticatedFetch(url, options) {
                const opts = Object.assign({ credentials: 'same-origin' }, options || {});
                if (opts.headers) {
                  opts.headers = Object.assign({}, opts.headers);
                }
                return fetch(url, opts).then(response => {
                  if (response.status === 401) {
                    alert('Session expired. Please reload this page and sign in again.');
                    throw new Error('Unauthorized');
                  }
                  return response;
                });
              }
              function buildModeSelectHTML(webviewuuid, currentMode) {
                var normalized = (currentMode || 'flow').toLowerCase();
                var options = ['flow','fixed','random-flow','random-fixed'].map(function(mode) {
                  var selected = mode === normalized ? ' selected' : '';
                  return '<option value="' + mode + '"' + selected + '>' + mode + '</option>';
                }).join('');
                return '<label class="mode-picker">mode <select class="mode-select" data-uuid="' + webviewuuid + '">' + options + '</select></label>';
              }
              function formatDateDisplay(iso) {
                var d = new Date(iso);
                if (isNaN(d.getTime())) return iso;
                var pad = function(n) { return String(n).padStart(2, '0'); };
                return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' - ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
              }
              function refreshWebviews() {
                authenticatedFetch('/manage-webviews')
                  .then(r => r.json())
                  .then(webviews => {
                    const container = document.getElementById('webviews');
                    container.innerHTML = webviews.map(function(w) {
                      var totalSlots = (w.rows || 10) * (w.columns || 10);
                      var resolution = (w.width || 100) + 'x' + (w.height || 100) + 'px';
                      var gridSize = (w.columns || 10) + 'x' + (w.rows || 10);
                      var createdAt = formatDateDisplay(w.created_at);
                      var deleteBtn = w.webviewuuid === 'testuuid' ? '' : '<button type="button" class="delete-btn" aria-label="Delete" data-uuid="' + w.webviewuuid + '"><img src="/trash-bin.png" alt="Delete" /></button>';
                      var modeSelector = buildModeSelectHTML(w.webviewuuid, w.display_mode);
                      return '' +
                        '<div class="webview-item">' +
                          '<div class="webview-main">' +
                            '<div class="webview-heading">' +
                              '<div class="webview-id">' +
                                '<a href="/' + w.webviewuuid + '" class="webview-link"><span>' + w.webviewuuid + '</span></a>' +
                                '<span class="webview-count">' + (w.uuidCount || 0) + '/' + totalSlots + ' linked</span>' +
                              '</div>' +
                            '</div>' +
                            '<div class="webview-meta">' +
                              '<span class="meta-pill">grid ' + gridSize + '</span>' +
                              '<span class="meta-pill">canvas ' + resolution + '</span>' +
                              '<span class="meta-pill">created ' + createdAt + '</span>' +
                            '</div>' +
                          '</div>' +
                          '<div class="webview-actions">' + modeSelector + deleteBtn + '</div>' +
                        '</div>';
                    }).join('');
                  });
              }
              function updateDisplayMode(webviewuuid, mode, selectEl) {
                if (!webviewuuid) {
                  return;
                }
                const allowed = ['flow','fixed','random-flow','random-fixed'];
                if (allowed.indexOf(mode) === -1) {
                  alert('Invalid mode.');
                  return;
                }
                if (selectEl) {
                  selectEl.disabled = true;
                }
                authenticatedFetch('/webviews/' + encodeURIComponent(webviewuuid) + '/display-mode', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ displayMode: mode })
                })
                  .then(r => r.json())
                  .then(data => {
                    if (data && data.error) {
                      alert('Update failed: ' + data.error);
                      refreshWebviews();
                    }
                  })
                  .catch(err => {
                    alert('Update failed: ' + err.message);
                    refreshWebviews();
                  })
                  .finally(() => {
                    if (selectEl) {
                      selectEl.disabled = false;
                    }
                  });
              }
              function createWebview() {
                const payload = {
                  rows: parseInt(document.getElementById('rows').value, 10) || 10,
                  columns: parseInt(document.getElementById('columns').value, 10) || 10,
                  width: parseInt(document.getElementById('width').value, 10) || 100,
                  height: parseInt(document.getElementById('height').value, 10) || 100
                };
                authenticatedFetch('/create-webview', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify(payload)
                })
                  .then(r => r.json())
                  .then(data => {
                    if(data && data.uuid) {
                      refreshWebviews();
                    }
                  });
              }
              function deleteWebview(webviewuuid, btn) {
                if (!confirm('Delete webview ' + webviewuuid + ' and all linked uuids?')) return;
                if (btn) {
                  btn.disabled = true;
                  btn.classList.add('deleting');
                }
                authenticatedFetch('/delete-webview/' + encodeURIComponent(webviewuuid), {
                  method: 'DELETE',
                })
                  .then(r => r.json())
                  .then(data => {
                    if (data && data.success) {
                      refreshWebviews();
                    } else if (data && data.error) {
                      alert('Delete failed: ' + data.error);
                    }
                  })
                  .catch(err => {
                    alert('Delete failed: ' + err.message);
                  })
                  .finally(() => {
                    if (btn) {
                      btn.disabled = false;
                      btn.classList.remove('deleting');
                    }
                  });
              }

              document.getElementById('webviews').addEventListener('click', function(event) {
                const btn = event.target.closest('.delete-btn');
                if (!btn || !btn.dataset.uuid) return;
                deleteWebview(btn.dataset.uuid, btn);
              });
              document.getElementById('webviews').addEventListener('change', function(event) {
                const select = event.target.closest('.mode-select');
                if (!select || !select.dataset.uuid) return;
                updateDisplayMode(select.dataset.uuid, select.value.toLowerCase(), select);
              });
            </script>
          </body>
          </html>`);
        });
      });
    });
    return;
  }
  else if (req.url.startsWith("/show/")) {
    // Extract uuid from URL
    const uuid = req.url.split("/show/")[1];
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>UUID</title>
          <style>
            body{font-family:sans-serif;text-align:center;margin-top:10vh;}
            .uuid{font-size:2em;color:#336699;margin:1em 0;}
            .copy-btn{padding:0.5em 1.2em;font-size:1em;cursor:pointer;border-radius:5px;border:1px solid #336699;background:#f0f6fa;color:#336699;transition:background 0.2s;}
            .copy-btn:hover{background:#e0eaff;}
          </style>
        </head>
        <body>
          <h1>Your UUID</h1>
          <div class="uuid" id="uuid">${uuid}</div>
          <button class="copy-btn" onclick="copyUUID()">Copy</button>
          <script>
            function copyUUID() {
              const uuid = document.getElementById('uuid').innerText;
              navigator.clipboard.writeText(uuid).then(() => {
                const btn = document.querySelector('.copy-btn');
                btn.textContent = 'Copied!';
                setTimeout(() => {btn.textContent = 'Copy'; }, 1200);
              });
            }
          </script>
        </body>
      </html>`);
  } else if (/^\/link\//.test(req.url)) {
    const [linkPath, queryString = ''] = req.url.split('?');
    if (!/^\/link\/[a-zA-Z0-9]{8}$/.test(linkPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    // /link/webviewuuid: generate a uuid, save with link to webviewuuid
    const webviewuuid = linkPath.split("/link/")[1];
    const params = new URLSearchParams(queryString);
    const email = (params.get('email') || '').trim();
    const uuid = Array.from({ length: 8 }, () =>
      Math.random().toString(36).charAt(2)
    ).join("");
    // Save uuid with reference to webviewuuid, add counter, and check for full webview
    sharedDb.get('SELECT rows, columns FROM webviews WHERE webviewuuid = ?', [webviewuuid], (err, webview) => {
      if (err || !webview) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid webviewuuid');
        return;
      }
      const maxSlots = (webview.rows || 10) * (webview.columns || 10);
      claimNextAvailableSlot(webviewuuid, uuid, email || null, webview.rows, webview.columns)
        .then((assignedIndex) => countAssignedSlots(webviewuuid).then((usedCount) => ({ assignedIndex, usedCount })))
        .then(({ assignedIndex, usedCount }) => {
          const fullMsg = usedCount >= maxSlots && maxSlots > 0
            ? '<div style="color:#b00;margin-top:1em;font-weight:bold;">This webview is full.</div>'
            : '';
          const renderPage = () => `<!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <title>UUID Created</title>
              <style>
                body { font-family: 'Segoe UI', Arial, sans-serif; background: #f7fbfd; text-align: center; margin: 0; padding: 0; }
                h1 { color: #225577; margin-top: 10vh; }
                .uuid { font-size: 2.2em; color: #336699; margin: 1em 0; font-family: monospace; }
                .copy-btn { padding: 0.6em 1.5em; font-size: 1.1em; cursor: pointer; border-radius: 6px; border: 1px solid #336699; background: #eaf4fa; color: #225577; font-weight: 500; margin-top: 1em; transition: background 0.2s, color 0.2s; }
                .copy-btn:hover { background: #d2e9fa; color: #113355; }
                .webview-link { color: #888; font-size: 1.1em; margin-top: 1em; display: block; }
              </style>
            </head>
            <body>
              <h1>Your UUID</h1>
              <div class="uuid" id="uuid">${uuid}</div>
              <button class="copy-btn" onclick="copyUUID()">Copy</button>
              <div class="webview-link">Linked to webview: <b>${webviewuuid}</b></div>
              <div style="margin-top:1em;">Counter: <b>${assignedIndex}</b></div>
              ${fullMsg}
              <script>
                function copyUUID() {
                  const uuid = document.getElementById('uuid').innerText;
                  navigator.clipboard.writeText(uuid).then(() => {
                    const btn = document.querySelector('.copy-btn');
                    btn.textContent = 'Copied!';
                    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
                  });
                }
              </script>
            </body>
            </html>`;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(renderPage());
        })
        .catch((errInsert) => {
          if (errInsert && errInsert.code === 'NO_AVAILABLE_SLOTS') {
            res.writeHead(409, { 'Content-Type': 'text/plain' });
            res.end('This webview is full.');
            return;
          }
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('DB error: ' + errInsert.message);
        });
    });
  } else if (req.url === "/" || req.url === "/index.html") {
    // Show a welcome page with input for webviewuuid
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Welcome</title>
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; background: #f7fbfd; text-align: center; margin: 0; padding: 0; min-height: 100vh; }
          h1 { color: #225577; margin-top: 10vh; }
          p { color: #336699; font-size: 1.2em; margin-top: 2em; }
          .input-wrap { margin-top: 1.5em; display: flex; flex-direction: column; gap: 0.35em; align-items: center; }
          .field-label { font-size: 0.95em; color: #225577; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
          input[type=text], input[type=email] { font-size: 1.1em; padding: 0.5em 1em; border-radius: 6px; border: 1px solid #336699; width: 240px; text-align: center; }
          button { font-size: 1.1em; padding: 0.6em 2.4em; border-radius: 6px; border: 1px solid #336699; background: #eaf4fa; color: #225577; cursor: pointer; width: 240px; white-space: nowrap; }
          button:hover { background: #d2e9fa; color: #113355; }
          .error { color: #b00; margin-top: 1em; }
          .top-link { position: fixed; top: 18px; right: 24px; font-size: 0.95em; letter-spacing: 0.04em; text-transform: uppercase; text-decoration: none; color: #1b4c72; background: rgba(255,255,255,0.92); padding: 0.4em 0.95em; border-radius: 999px; border: 1px solid rgba(34,85,119,0.25); font-weight: 600; box-shadow: 0 3px 10px rgba(17,51,85,0.12); transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease; }
          .top-link:hover { background: #ffffff; color: #0f2e46; transform: translateY(-1px); box-shadow: 0 6px 18px rgba(17,51,85,0.18); }
        </style>
      </head>
      <body>
        <a class="top-link" href="/manage">Manage Streams</a>
        <h1>Welcome to p5 Studio Streaming</h1>
        <p>Enter your email and a stream code to join a stream:</p>
        <div class="input-wrap">
          <label for="emailInput" class="field-label">Email</label>
          <input id="emailInput" type="email" placeholder="Enter your email" required />
        </div>
        <div class="input-wrap">
          <label for="uuidInput" class="field-label">Stream Code</label>
          <input id="uuidInput" type="text" placeholder="Enter stream code" maxlength="32" />
        </div>
        <div class="input-wrap">
          <button onclick="goToWebview()">Request User Code</button>
        </div>
        <div class="error" id="error"></div>
        <script>
          function goToWebview() {
            var uuidField = document.getElementById('uuidInput');
            var uuid = uuidField.value.trim();
            var emailField = document.getElementById('emailInput');
            var email = emailField.value.trim();
            uuidField.setCustomValidity('');
            if (!uuid) {
              showError('Please enter a webviewuuid.');
              uuidField.focus();
              return;
            }
            if (!email) {
              showError('Please enter your email.');
              emailField.focus();
              return;
            }
            if (!emailField.checkValidity()) {
              showError('Please enter a valid email address.');
              emailField.focus();
              return;
            }
            fetch('/check-webviewuuid/' + encodeURIComponent(uuid))
              .then(r => r.json())
              .then(data => {
                if (!data.exists) {
                  showError('Webview UUID not found.');
                  uuidField.setCustomValidity('Stream code not found.');
                  uuidField.reportValidity();
                  uuidField.focus();
                  return;
                }
                if (data.full) {
                  var capacityMsg = (typeof data.used === 'number' && typeof data.capacity === 'number')
                    ? ' (' + data.used + '/' + data.capacity + ' slots used)'
                    : '';
                  showError('This stream is full.' + capacityMsg);
                  uuidField.setCustomValidity('This stream is full.');
                  uuidField.reportValidity();
                  uuidField.focus();
                  return;
                }
                uuidField.setCustomValidity('');
                var params = new URLSearchParams({ email: email });
                window.location.href = '/link/' + encodeURIComponent(uuid) + '?' + params.toString();
              })
              .catch(() => showError('Error checking webviewuuid.'));
          }
          function showError(msg) {
            document.getElementById('error').textContent = msg;
          }
        </script>
      </body>
      </html>`);
  } else if (req.url.startsWith("/check-webviewuuid/")) {
    // AJAX endpoint to check if a webviewuuid exists and whether it's full
    const uuid = decodeURIComponent(req.url.split("/check-webviewuuid/")[1] || "");
    sharedDb.get('SELECT rows, columns FROM webviews WHERE webviewuuid = ?', [uuid], (err, webview) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      if (!webview) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exists: false }));
        return;
      }
      sharedDb.get('SELECT COUNT(*) as count FROM uuids WHERE webviewuuid = ? AND uuid IS NOT NULL AND uuid <> ""', [uuid], (countErr, row) => {
        if (countErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: countErr.message }));
          return;
        }
        const used = row ? row.count : 0;
        const capacity = (webview.rows || 10) * (webview.columns || 10);
        const full = used >= capacity;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exists: true, full, used, capacity }));
      });
    });
  } else if (/^\/[a-zA-Z0-9]{8}$/.test(req.url)) {
    // Serve the grid page at /:uuid and expose uuid to frontend
    const uuid = req.url.slice(1);
    sharedDb.get('SELECT rows, columns, width, height, display_mode FROM webviews WHERE webviewuuid = ?', [uuid], (err, row) => {
      if (err || !row) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Webview not found');
        return;
      }
      fs.readFile(path.join(__dirname, "index.html"), "utf8", (err2, data) => {
        if (err2) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Error loading index.html");
        } else {
          // Inject a script to expose uuid, rows, columns, width, height
          const mode = row.display_mode || 'flow';
          const injected = data.replace('<body>', `<body><script>window.uuid = '${uuid}'; window.gridRows = ${row.rows || 10}; window.gridCols = ${row.columns || 10}; window.gridWidth = ${row.width || 100}; window.gridHeight = ${row.height || 100}; window.displayMode = '${mode}';</script>`);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(injected);
        }
      });
    });
  } else if (req.url.startsWith("/p5/")) {
    const filePath = path.join(__dirname, req.url);
    serveStaticFile(req, res, filePath);
  } else if (req.url === "/trash-bin.png") {
    const filePath = path.join(__dirname, "trash-bin.png");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("File not found: trash-bin.png");
      } else {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(data);
      }
    });
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

function serveStaticFile(req, res, filePath) {
  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found: ' + req.url);
      return;
    }
    const cached = staticFileCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
      sendStaticResponse(res, cached.data, filePath);
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to read file');
        return;
      }
      staticFileCache.set(filePath, { data, mtimeMs: stats.mtimeMs });
      sendStaticResponse(res, data, filePath);
    });
  });
}

function sendStaticResponse(res, data, filePath) {
  res.writeHead(200, {
    'Content-Type': detectContentType(filePath),
    'Content-Length': data.length,
    'Cache-Control': `public, max-age=${STATIC_CACHE_MAX_AGE_SECONDS}`
  });
  res.end(data);
}

function detectContentType(filePath) {
  if (filePath.endsWith('.js')) return 'application/javascript';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.html')) return 'text/html';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function countAssignedSlots(webviewuuid) {
  return new Promise((resolve, reject) => {
    if (!webviewuuid) {
      resolve(0);
      return;
    }
    sharedDb.get('SELECT COUNT(*) as count FROM uuids WHERE webviewuuid = ? AND uuid IS NOT NULL AND uuid <> ""', [webviewuuid], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row && typeof row.count === 'number' ? row.count : 0);
    });
  });
}

function claimNextAvailableSlot(webviewuuid, uuidValue, emailValue, rows, columns) {
  return new Promise((resolve, reject) => {
    const tryClaim = (attemptedReseed) => {
      sharedDb.get('SELECT id, link_index FROM uuids WHERE webviewuuid = ? AND (uuid IS NULL OR uuid = "") ORDER BY link_index ASC LIMIT 1', [webviewuuid], (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        if (!row) {
          if (attemptedReseed || !rows || !columns) {
            const noSlotsErr = new Error('NO_AVAILABLE_SLOTS');
            noSlotsErr.code = 'NO_AVAILABLE_SLOTS';
            reject(noSlotsErr);
            return;
          }
          seedEmptySlotsForWebview(webviewuuid, rows, columns)
            .then(() => tryClaim(true))
            .catch(reject);
          return;
        }
        sharedDb.run('UPDATE uuids SET uuid = ?, email = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?', [uuidValue, emailValue, row.id], function (updateErr) {
          if (updateErr) {
            reject(updateErr);
            return;
          }
          resolve(row.link_index);
        });
      });
    };
    tryClaim(false);
  });
}

function seedEmptySlotsForWebview(webviewuuid, rows, columns) {
  return new Promise((resolve, reject) => {
    const totalSlots = Math.max(0, Math.floor(rows || 0)) * Math.max(0, Math.floor(columns || 0));
    if (!webviewuuid || !totalSlots) {
      resolve();
      return;
    }
    sharedDb.all('SELECT link_index FROM uuids WHERE webviewuuid = ?', [webviewuuid], (err, existingRows) => {
      if (err) {
        reject(err);
        return;
      }
      const existing = new Set();
      if (Array.isArray(existingRows)) {
        existingRows.forEach((entry) => {
          const idx = Number(entry.link_index);
          if (Number.isFinite(idx)) {
            existing.add(idx);
          }
        });
      }
      const missing = [];
      for (let i = 1; i <= totalSlots; i++) {
        if (!existing.has(i)) {
          missing.push(i);
        }
      }
      if (!missing.length) {
        resolve();
        return;
      }
      sharedDb.serialize(() => {
        const stmt = sharedDb.prepare('INSERT INTO uuids (uuid, webviewuuid, email, link_index) VALUES (?, ?, ?, ?)');
        let cancelled = false;
        const insertNext = (position) => {
          if (cancelled) {
            return;
          }
          if (position >= missing.length) {
            stmt.finalize((finalizeErr) => {
              if (finalizeErr) {
                reject(finalizeErr);
              } else {
                resolve();
              }
            });
            return;
          }
          const slotIndex = missing[position];
          stmt.run(null, webviewuuid, null, slotIndex, (runErr) => {
            if (runErr) {
              cancelled = true;
              stmt.finalize(() => reject(runErr));
              return;
            }
            insertNext(position + 1);
          });
        };
        insertNext(0);
      });
    });
  });
}
