
const http = require("http");
const fs = require("fs");
const path = require("path");
const sqlite3 = require('sqlite3').verbose();
const { URLSearchParams } = require('url');
let uuidv4;
const { saveUUID } = require("./db");


const server = http.createServer((req, res) => {
  // Endpoint to get all uuids for a webviewuuid, ordered by insertion
  if (/^\/uuids\/[a-zA-Z0-9]{8}$/.test(req.url)) {
    const webviewuuid = req.url.split("/uuids/")[1];
    const dbPath = require('path').join(__dirname, 'uuids.db');
    const db = new sqlite3.Database(dbPath);
    db.all('SELECT uuid FROM uuids WHERE webviewuuid = ? ORDER BY id ASC', [webviewuuid], (err, rows) => {
      db.close();
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows.map(r => r.uuid)));
      }
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
        // Insert new webview into webviews table
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = require('path').join(__dirname, 'uuids.db');
        const db = new sqlite3.Database(dbPath);
        db.run('INSERT INTO webviews (webviewuuid, rows, columns, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)', [webviewuuid, rows, columns, width, height, created_at], function (err) {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('DB error: ' + err.message);
            db.close();
            return;
          }
          db.close();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ uuid: webviewuuid, rows, columns, width, height, created_at }));
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
      const sqlite3 = require('sqlite3').verbose();
      const dbPath = require('path').join(__dirname, 'uuids.db');
      const db = new sqlite3.Database(dbPath);
      db.serialize(() => {
        db.run('DELETE FROM uuids WHERE webviewuuid = ?', [webviewuuid], function (err1) {
          if (err1) {
            db.close();
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err1.message }));
            return;
          }
          db.run('DELETE FROM webviews WHERE webviewuuid = ?', [webviewuuid], function (err2) {
            db.close();
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
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = require('path').join(__dirname, 'uuids.db');
        const db = new sqlite3.Database(dbPath);
        const getCounts = (webviews) => Promise.all(webviews.map(w => new Promise((resolve) => {
          db.get('SELECT COUNT(*) as count FROM uuids WHERE webviewuuid = ?', [w.webviewuuid], (err, row) => {
            resolve({ ...w, uuidCount: row ? row.count : 0 });
          });
        })));
        getCounts(webviews).then(webviewsWithCounts => {
          db.close();
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
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = require('path').join(__dirname, 'uuids.db');
        const db = new sqlite3.Database(dbPath);
        const getCounts = (webviews) => Promise.all(webviews.map(w => new Promise((resolve) => {
          db.get('SELECT COUNT(*) as count FROM uuids WHERE webviewuuid = ?', [w.webviewuuid], (err, row) => {
            resolve({ ...w, uuidCount: row ? row.count : 0 });
          });
        })));
        getCounts(webviews).then(webviewsWithCounts => {
          db.close();
          const formatDate = (iso) => {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return iso;
            const pad = (n) => String(n).padStart(2, '0');
            return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          };
          const webviewsHtml = webviewsWithCounts.map(w => {
            const y = (w.rows || 10) * (w.columns || 10);
            const createdAt = formatDate(w.created_at);
            const deleteBtn = w.webviewuuid === 'testuuid'
              ? ''
              : `<button type="button" class="delete-btn" aria-label="Delete" data-uuid="${w.webviewuuid}"><img src="/trash-bin.png" alt="Delete" /></button>`;
            return `<div class="webview-item"><div class="webview-info"><a href="/${w.webviewuuid}" class="webview-link"><span>${w.webviewuuid}</span></a> <span class="webview-count">(${w.uuidCount}/${y})</span><small>${createdAt}</small></div>${deleteBtn}</div>`;
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
                max-width: 500px;
                display: flex;
                flex-direction: column;
                gap: 1em;
              }
              .webview-item {
                background: #fff;
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(34,102,153,0.07);
                padding: 1em 1.5em;
                display: flex;
                align-items: center;
                justify-content: space-between;
                font-size: 1.1em;
              }
              .webview-info {
                display: flex;
                align-items: center;
                gap: 0.5em;
                flex-wrap: wrap;
              }
              .webview-item span {
                color: #336699;
                font-weight: bold;
                font-family: monospace;
              }
              .webview-count {
                color: #888;
                font-size: 0.95em;
              }
              .webview-item small {
                color: #888;
                font-size: 0.95em;
                margin-left: 1em;
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
                width: 42px;
                height: 42px;
                padding: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: #ffecec;
                border: 1px solid #e6aaaa;
                border-radius: 10px;
              }
              .delete-btn img {
                width: 22px;
                height: 22px;
                pointer-events: none;
              }
              .delete-btn:hover {
                background: #ffd4d4;
              }
              .delete-btn.deleting {
                opacity: 0.5;
                cursor: wait;
              }
            </style>
          </head>
          <body>
            <h1>Manage Webviews</h1>
            <div style="margin-bottom:1em; display: flex; flex-wrap: wrap; gap: 1em; align-items: center;">
              <label for="rows">Rows:</label>
              <input id="rows" type="number" min="1" max="200" value="10" style="width:60px;">
              <label for="columns">Columns:</label>
              <input id="columns" type="number" min="1" max="200" value="10" style="width:60px;">
              <label for="width">Width:</label>
              <input id="width" type="number" min="5" max="5000" value="100" style="width:60px;">
              <label for="height">Height:</label>
              <input id="height" type="number" min="5" max="5000" value="100" style="width:60px;">
            </div>
            <button onclick="createWebview()">Create Webview</button>
            <div id="webviews">${webviewsHtml}</div>
            <script>
              // Store credentials in sessionStorage for reuse
              function getAuthHeader() {
                let auth = sessionStorage.getItem('auth');
                if (!auth) {
                  const user = prompt('Username:', 'admin');
                  const pass = prompt('Password:', 'admin');
                  if (user && pass) {
                    auth = 'Basic ' + btoa(user + ':' + pass);
                    sessionStorage.setItem('auth', auth);
                  }
                }
                return auth;
              }
              function formatDateDisplay(iso) {
                var d = new Date(iso);
                if (isNaN(d.getTime())) return iso;
                var pad = function(n) { return String(n).padStart(2, '0'); };
                return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' - ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
              }
              function refreshWebviews() {
                const auth = getAuthHeader();
                fetch('/manage-webviews', { headers: { Authorization: auth } })
                  .then(r => r.json())
                  .then(webviews => {
                    const container = document.getElementById('webviews');
                    container.innerHTML = webviews.map(function(w) {
                      var y = (w.rows || 10) * (w.columns || 10);
                      var deleteBtn = w.webviewuuid === 'testuuid' ? '' : '<button type="button" class="delete-btn" aria-label="Delete" data-uuid="' + w.webviewuuid + '"><img src="/trash-bin.png" alt="Delete" /></button>';
                      return '<div class="webview-item"><div class="webview-info"><a href="/' + w.webviewuuid + '" class="webview-link"><span>' + w.webviewuuid + '</span></a> <span class="webview-count">(' + (w.uuidCount || 0) + '/' + y + ')</span><small>' + formatDateDisplay(w.created_at) + '</small></div>' + deleteBtn + '</div>';
                    }).join('');
                  });
              }
              function createWebview() {
                const auth = getAuthHeader();
                const payload = {
                  rows: parseInt(document.getElementById('rows').value, 10) || 10,
                  columns: parseInt(document.getElementById('columns').value, 10) || 10,
                  width: parseInt(document.getElementById('width').value, 10) || 100,
                  height: parseInt(document.getElementById('height').value, 10) || 100
                };
                fetch('/create-webview', {
                  method: 'POST',
                  headers: {
                    Authorization: auth,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify(payload)
                })
                  .then(r => {
                    if (r.status === 401) {
                      sessionStorage.removeItem('auth');
                      alert('Session expired. Please try again.');
                      return {};
                    }
                    return r.json();
                  })
                  .then(data => {
                    if(data && data.uuid) {
                      refreshWebviews();
                    }
                  });
              }
              function deleteWebview(webviewuuid, btn) {
                if (!confirm('Delete webview ' + webviewuuid + ' and all linked uuids?')) return;
                const auth = getAuthHeader();
                if (!auth) {
                  alert('Authorization required.');
                  return;
                }
                if (btn) {
                  btn.disabled = true;
                  btn.classList.add('deleting');
                }
                fetch('/delete-webview/' + encodeURIComponent(webviewuuid), {
                  method: 'DELETE',
                  headers: { Authorization: auth }
                })
                  .then(r => {
                    if (r.status === 401) {
                      sessionStorage.removeItem('auth');
                      alert('Session expired. Please try again.');
                      return {};
                    }
                    return r.json();
                  })
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
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = require('path').join(__dirname, 'uuids.db');
    const db = new sqlite3.Database(dbPath);
    db.get('SELECT rows, columns FROM webviews WHERE webviewuuid = ?', [webviewuuid], (err, webview) => {
      if (err || !webview) {
        db.close();
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid webviewuuid');
        return;
      }
      db.run('INSERT INTO uuids (uuid, webviewuuid, email) VALUES (?, ?, ?)', [uuid, webviewuuid, email || null], function (err3) {
        if (err3) {
          db.close();
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('DB error: ' + err3.message);
          return;
        }
        // Now count how many uuids are linked (including the one just added)
        db.get('SELECT COUNT(*) as count FROM uuids WHERE webviewuuid = ?', [webviewuuid], (err2, row) => {
          db.close();
          if (err2) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('DB error: ' + err2.message);
            return;
          }
          const displayCounter = row ? row.count : 1;
          const max = (webview.rows || 10) * (webview.columns || 10);
          let fullMsg = '';
          if (displayCounter > max) {
            fullMsg = '<div style="color:#b00;margin-top:1em;font-weight:bold;">This webview is full.</div>';
          }
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
              <div style="margin-top:1em;">Counter: <b>${displayCounter}</b></div>
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
        });
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
          body { font-family: 'Segoe UI', Arial, sans-serif; background: #f7fbfd; text-align: center; margin: 0; padding: 0; }
          h1 { color: #225577; margin-top: 10vh; }
          p { color: #336699; font-size: 1.2em; margin-top: 2em; }
          .input-wrap { margin-top: 2em; }
          input[type=text], input[type=email] { font-size: 1.1em; padding: 0.5em 1em; border-radius: 6px; border: 1px solid #336699; width: 220px; }
          button { font-size: 1.1em; padding: 0.5em 1.5em; border-radius: 6px; border: 1px solid #336699; background: #eaf4fa; color: #225577; margin-left: 1em; cursor: pointer; }
          button:hover { background: #d2e9fa; color: #113355; }
          .error { color: #b00; margin-top: 1em; }
        </style>
      </head>
      <body>
        <h1>Welcome to p5 Studio Stream</h1>
        <p>Paste a webview UUID to join:</p>
        <div class="input-wrap">
          <input id="emailInput" type="email" placeholder="Enter your email" required />
        </div>
        <div class="input-wrap">
          <input id="uuidInput" type="text" placeholder="Enter webviewuuid" maxlength="32" />
          <button onclick="goToWebview()">Go</button>
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
                  uuidField.setCustomValidity('Webview UUID not found.');
                  uuidField.reportValidity();
                  uuidField.focus();
                  return;
                }
                if (data.full) {
                  var capacityMsg = (typeof data.used === 'number' && typeof data.capacity === 'number')
                    ? ' (' + data.used + '/' + data.capacity + ' slots used)'
                    : '';
                  showError('This webview is full.' + capacityMsg);
                  uuidField.setCustomValidity('This webview is full.');
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
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = require('path').join(__dirname, 'uuids.db');
    const db = new sqlite3.Database(dbPath);
    db.get('SELECT rows, columns FROM webviews WHERE webviewuuid = ?', [uuid], (err, webview) => {
      if (err) {
        db.close();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      if (!webview) {
        db.close();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exists: false }));
        return;
      }
      db.get('SELECT COUNT(*) as count FROM uuids WHERE webviewuuid = ?', [uuid], (countErr, row) => {
        db.close();
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
    const dbPath = require('path').join(__dirname, 'uuids.db');
    const db = new sqlite3.Database(dbPath);
    db.get('SELECT rows, columns, width, height FROM webviews WHERE webviewuuid = ?', [uuid], (err, row) => {
      db.close();
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
          const injected = data.replace('<body>', `<body><script>window.uuid = '${uuid}'; window.gridRows = ${row.rows || 10}; window.gridCols = ${row.columns || 10}; window.gridWidth = ${row.width || 100}; window.gridHeight = ${row.height || 100};</script>`);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(injected);
        }
      });
    });
  } else if (req.url.startsWith("/p5/")) {
    const filePath = path.join(__dirname, req.url);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("File not found: " + req.url);
      } else {
        // Set content type based on file extension
        let contentType = "application/octet-stream";
        if (filePath.endsWith(".js")) contentType = "application/javascript";
        else if (filePath.endsWith(".css")) contentType = "text/css";
        else if (filePath.endsWith(".html")) contentType = "text/html";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      }
    });
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
