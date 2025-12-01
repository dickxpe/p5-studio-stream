function getAllWebviews() {
    return new Promise((resolve, reject) => {
        db.all('SELECT webviewuuid, rows, columns, width, height, created_at FROM webviews ORDER BY created_at DESC', [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'uuids.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run('CREATE TABLE IF NOT EXISTS webviews (id INTEGER PRIMARY KEY AUTOINCREMENT, webviewuuid TEXT UNIQUE NOT NULL, rows INTEGER DEFAULT 10, columns INTEGER DEFAULT 10, width INTEGER DEFAULT 100, height INTEGER DEFAULT 100, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    // Ensure new columns exist for older installations
    const ensureColumn = (name, sql) => {
        db.run(sql, err => {
            if (err && !/duplicate column/i.test(err.message)) {
                console.warn(`Could not add column ${name} to webviews table:`, err.message);
            }
        });
    };
    ensureColumn('rows', 'ALTER TABLE webviews ADD COLUMN rows INTEGER DEFAULT 10');
    ensureColumn('columns', 'ALTER TABLE webviews ADD COLUMN columns INTEGER DEFAULT 10');
    ensureColumn('width', 'ALTER TABLE webviews ADD COLUMN width INTEGER DEFAULT 100');
    ensureColumn('height', 'ALTER TABLE webviews ADD COLUMN height INTEGER DEFAULT 100');
    db.run('CREATE TABLE IF NOT EXISTS uuids (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL, webviewuuid TEXT, email TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    // Ensure email column exists for older databases
    db.run('ALTER TABLE uuids ADD COLUMN email TEXT', (err) => {
        if (err && !/duplicate column/i.test(err.message)) {
            console.warn('Could not add email column to uuids table:', err.message);
        }
    });
    db.run('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)');
});
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function createUser(username, password) {
    return new Promise((resolve, reject) => {
        const hash = hashPassword(password);
        db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash], function (err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
    });
}

function verifyUser(username, password) {
    return new Promise((resolve, reject) => {
        const hash = hashPassword(password);
        db.get('SELECT * FROM users WHERE username = ? AND password_hash = ?', [username, hash], function (err, row) {
            if (err) reject(err);
            else resolve(!!row);
        });
    });
}

function saveUUID(uuid, webviewuuid, email = null) {
    return new Promise((resolve, reject) => {
        if (webviewuuid) {
            // Ensure the webview exists
            db.run('INSERT OR IGNORE INTO webviews (webviewuuid) VALUES (?)', [webviewuuid], function (err) {
                if (err) return reject(err);
                db.run('INSERT INTO uuids (uuid, webviewuuid, email) VALUES (?, ?, ?)', [uuid, webviewuuid, email], function (err2) {
                    if (err2) reject(err2);
                    else resolve(this.lastID);
                });
            });
        } else {
            db.run('INSERT INTO uuids (uuid, email) VALUES (?, ?)', [uuid, email], function (err) {
                if (err) reject(err);
                else resolve(this.lastID);
            });
        }
    });
}

// --- Insert default test webviewuuid and uuids on startup ---
const TEST_WEBVIEWUUID = 'testuuid';
const TEST_UUID_COUNT = 100;
db.serialize(() => {
    db.get('SELECT 1 FROM webviews WHERE webviewuuid = ?', [TEST_WEBVIEWUUID], (err, row) => {
        if (!row) {
            db.run('INSERT INTO webviews (webviewuuid) VALUES (?)', [TEST_WEBVIEWUUID], function (err2) {
                if (!err2) {
                    const stmt = db.prepare('INSERT INTO uuids (uuid, webviewuuid, email) VALUES (?, ?, ?)');
                    for (let i = 0; i < TEST_UUID_COUNT; i++) {
                        stmt.run(i.toString(), TEST_WEBVIEWUUID, null);
                    }
                    stmt.finalize();
                    console.log('Inserted test webviewuuid and 100 uuids for test case.');
                }
            });
        }
    });
});

module.exports = { saveUUID, createUser, verifyUser, getAllWebviews };
