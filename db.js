function getAllWebviews() {
    return new Promise((resolve, reject) => {
        db.all('SELECT webviewuuid, rows, columns, width, height, created_at, display_mode FROM webviews ORDER BY created_at DESC', [], (err, rows) => {
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
    db.run('CREATE TABLE IF NOT EXISTS webviews (id INTEGER PRIMARY KEY AUTOINCREMENT, webviewuuid TEXT UNIQUE NOT NULL, rows INTEGER DEFAULT 10, columns INTEGER DEFAULT 10, width INTEGER DEFAULT 100, height INTEGER DEFAULT 100, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, display_mode TEXT DEFAULT "flow")');
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
    ensureColumn('display_mode', 'ALTER TABLE webviews ADD COLUMN display_mode TEXT DEFAULT "flow"');
    db.run('UPDATE webviews SET display_mode = "flow" WHERE display_mode IS NULL', (err) => {
        if (err && !/no such column/i.test(err.message)) {
            console.warn('Could not backfill display_mode:', err.message);
        }
    });
    db.run('CREATE TABLE IF NOT EXISTS uuids (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, webviewuuid TEXT, email TEXT, link_index INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    ensureUuidColumnNullable();
    // Ensure email column exists for older databases
    db.run('ALTER TABLE uuids ADD COLUMN email TEXT', (err) => {
        if (err && !/duplicate column/i.test(err.message)) {
            console.warn('Could not add email column to uuids table:', err.message);
        }
    });
    db.run('ALTER TABLE uuids ADD COLUMN link_index INTEGER', (err) => {
        if (err && !/duplicate column/i.test(err.message)) {
            console.warn('Could not add link_index column to uuids table:', err.message);
        }
    });
    backfillLinkIndices();
    db.run('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)');
});
function ensureUuidColumnNullable() {
    db.all('PRAGMA table_info(uuids)', (err, columns) => {
        if (err || !Array.isArray(columns)) {
            return;
        }
        const uuidCol = columns.find(col => col.name === 'uuid');
        if (!uuidCol || uuidCol.notnull === 0) {
            return;
        }
        db.serialize(() => {
            db.run('ALTER TABLE uuids RENAME TO uuids__old', (renameErr) => {
                if (renameErr) {
                    console.warn('Could not rename uuids table during migration:', renameErr.message);
                    return;
                }
                db.run('CREATE TABLE uuids (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, webviewuuid TEXT, email TEXT, link_index INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)', (createErr) => {
                    if (createErr) {
                        console.warn('Could not recreate uuids table during migration:', createErr.message);
                        return;
                    }
                    db.run('INSERT INTO uuids (id, uuid, webviewuuid, email, link_index, created_at) SELECT id, uuid, webviewuuid, email, link_index, created_at FROM uuids__old', (copyErr) => {
                        if (copyErr) {
                            console.warn('Could not copy uuids data during migration:', copyErr.message);
                            return;
                        }
                        db.run('DROP TABLE uuids__old', (dropErr) => {
                            if (dropErr) {
                                console.warn('Could not drop old uuids table during migration:', dropErr.message);
                            }
                        });
                        db.get('SELECT MAX(id) as maxId FROM uuids', (seqErr, row) => {
                            if (seqErr || !row) {
                                return;
                            }
                            const maxId = row.maxId || 0;
                            db.run('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', [maxId, 'uuids']);
                        });
                    });
                });
            });
        });
    });
}
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
                claimSlotForDb(db, webviewuuid, uuid, email, (slotErr, slotIndex) => {
                    if (slotErr) {
                        reject(slotErr);
                    } else {
                        resolve(slotIndex);
                    }
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

function claimSlotForDb(targetDb, webviewuuid, uuidValue, emailValue, callback) {
    if (!webviewuuid) {
        callback(new Error('Missing webviewuuid'));
        return;
    }
    targetDb.get('SELECT id, link_index FROM uuids WHERE webviewuuid = ? AND (uuid IS NULL OR uuid = "") ORDER BY link_index ASC LIMIT 1', [webviewuuid], (err, row) => {
        if (err) {
            callback(err);
            return;
        }
        if (!row) {
            getNextLinkIndexForDb(targetDb, webviewuuid, (indexErr, nextIndex) => {
                if (indexErr) {
                    callback(indexErr);
                    return;
                }
                targetDb.run('INSERT INTO uuids (uuid, webviewuuid, email, link_index) VALUES (?, ?, ?, ?)', [uuidValue, webviewuuid, emailValue, nextIndex], function (insertErr) {
                    if (insertErr) {
                        callback(insertErr);
                        return;
                    }
                    callback(null, nextIndex);
                });
            });
            return;
        }
        targetDb.run('UPDATE uuids SET uuid = ?, email = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?', [uuidValue, emailValue, row.id], function (updateErr) {
            if (updateErr) {
                callback(updateErr);
                return;
            }
            callback(null, row.link_index);
        });
    });
}

function getNextLinkIndexForDb(targetDb, webviewuuid, callback) {
    if (!webviewuuid) {
        callback(null, null);
        return;
    }
    targetDb.get('SELECT MAX(link_index) as maxIndex, COUNT(*) as total FROM uuids WHERE webviewuuid = ?', [webviewuuid], (err, row) => {
        if (err) {
            callback(err);
            return;
        }
        const lastIndex = row && row.maxIndex ? row.maxIndex : (row ? row.total : 0);
        callback(null, lastIndex + 1);
    });
}

function backfillLinkIndices() {
    db.all('SELECT DISTINCT webviewuuid FROM uuids WHERE webviewuuid IS NOT NULL', (err, rows) => {
        if (err || !rows) {
            return;
        }
        rows.forEach(({ webviewuuid }) => {
            db.all('SELECT id FROM uuids WHERE webviewuuid = ? ORDER BY id ASC', [webviewuuid], (rowErr, uuidRows) => {
                if (rowErr || !uuidRows) {
                    return;
                }
                uuidRows.forEach((uuidRow, index) => {
                    db.run('UPDATE uuids SET link_index = ? WHERE id = ?', [index + 1, uuidRow.id]);
                });
            });
        });
    });
}

// --- Insert default test webviewuuid and uuids on startup ---
const TEST_WEBVIEWUUID = 'testuuid';
const TEST_UUID_COUNT = 100;
resetTestWebview();

function resetTestWebview() {
    const rows = 10;
    const columns = 10;
    const width = 100;
    const height = 100;
    const totalSlots = TEST_UUID_COUNT;
    db.serialize(() => {
        db.run(`INSERT INTO webviews (webviewuuid, rows, columns, width, height)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(webviewuuid) DO UPDATE SET
                  rows = excluded.rows,
                  columns = excluded.columns,
                  width = excluded.width,
                  height = excluded.height`,
            [TEST_WEBVIEWUUID, rows, columns, width, height], (err) => {
                if (err) {
                    console.warn('Failed to upsert test webview:', err.message);
                }
            });
        db.run('DELETE FROM uuids WHERE webviewuuid = ?', [TEST_WEBVIEWUUID], (deleteErr) => {
            if (deleteErr) {
                console.warn('Failed to reset test uuids:', deleteErr.message);
                return;
            }
            const stmt = db.prepare('INSERT INTO uuids (uuid, webviewuuid, email, link_index) VALUES (?, ?, ?, ?)');
            for (let i = 0; i < totalSlots; i++) {
                stmt.run(i.toString(), TEST_WEBVIEWUUID, null, i + 1);
            }
            stmt.finalize((finalizeErr) => {
                if (finalizeErr) {
                    console.warn('Failed to finalize test uuid seeding:', finalizeErr.message);
                } else {
                    console.log('Reset testuuid with 100 sample uuids.');
                }
            });
        });
    });
}

module.exports = { saveUUID, createUser, verifyUser, getAllWebviews };
