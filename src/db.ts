import Database from "better-sqlite3";
import crypto from "node:crypto";

if (!process.env.SECRET || process.env.SECRET.length < 16) {
    throw new Error("SECRET env var (min 16 chars) is required");
}
const KEY = crypto.scryptSync(process.env.SECRET, "mongo-admin-v1", 32);

/** AES-256-GCM: base64(iv | tag | ciphertext) */
const enc = (t: string) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
    const ct = Buffer.concat([c.update(t, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
};
const dec = (s: string) => {
    const b = Buffer.from(s, "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(
        "utf8",
    );
};

export const db = new Database(process.env.SQLITE_PATH ?? "data.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS connections(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, uri_enc TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
-- which user may open which database of which connection ('*' = every database)
CREATE TABLE IF NOT EXISTS connection_access(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  db_name TEXT NOT NULL DEFAULT '*', PRIMARY KEY(user_id, connection_id, db_name));
-- who may add / edit / delete connection records
CREATE TABLE IF NOT EXISTS connection_perms(
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  can_add INTEGER NOT NULL DEFAULT 0, can_edit INTEGER NOT NULL DEFAULT 0,
  can_delete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, expires INTEGER NOT NULL);
`);

// ---------- passwords ----------
const hashPassword = (pw: string) => {
    const salt = crypto.randomBytes(16);
    return (
        salt.toString("hex") +
        ":" +
        crypto.scryptSync(pw, salt, 64).toString("hex")
    );
};

const checkPassword = (pw: string, stored: string) => {
    const [s, h] = stored.split(":");
    const x = crypto.scryptSync(pw, Buffer.from(s, "hex"), 64);
    return crypto.timingSafeEqual(x, Buffer.from(h, "hex"));
};

const DUMMY = hashPassword("dummy-password");

// ---------- users ----------
export interface User {
    id: number;
    username: string;
    is_admin: boolean;
    perms: { add: boolean; edit: boolean; del: boolean };
}

const toUser = (r: any): User | undefined =>
    r && {
        id: r.id,
        username: r.username,
        is_admin: !!r.is_admin,
        perms: r.is_admin
            ? { add: true, edit: true, del: true }
            : { add: !!r.can_add, edit: !!r.can_edit, del: !!r.can_delete },
    };

const USER_SQL = `SELECT u.id,u.username,u.is_admin,p.can_add,p.can_edit,p.can_delete
  FROM users u LEFT JOIN connection_perms p ON p.user_id=u.id`;

export const getUser = (id: number) =>
    toUser(db.prepare(USER_SQL + " WHERE u.id=?").get(id));

export const listUsers = () =>
    (db.prepare(USER_SQL + " ORDER BY u.username").all() as any[]).map(
        (r) => toUser(r)!,
    );

export function authenticate(username: string, password: string): User | null {
    const r = db
        .prepare("SELECT id,password_hash FROM users WHERE username=?")
        .get(username) as any;
    const ok = checkPassword(password, r?.password_hash ?? DUMMY);
    return r && ok ? getUser(r.id)! : null;
}

export function checkUserPassword(id: number, pw: string) {
    const r = db
        .prepare("SELECT password_hash FROM users WHERE id=?")
        .get(id) as any;
    return !!r && checkPassword(pw, r.password_hash);
}

export const validUsername = (u: string) => /^[\w.@-]{3,64}$/.test(u);

export function createUser(
    username: string,
    password: string,
    isAdmin: boolean,
) {
    if (!validUsername(username))
        throw new Error(
            "Username must be 3-64 characters: letters, digits, . _ - @",
        );
    if (password.length < 8)
        throw new Error("Password must be at least 8 characters");
    try {
        return Number(
            db
                .prepare(
                    "INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,?)",
                )
                .run(username, hashPassword(password), isAdmin ? 1 : 0)
                .lastInsertRowid,
        );
    } catch (e: any) {
        if (String(e.code).startsWith("SQLITE_CONSTRAINT"))
            throw new Error("That username is already taken");
        throw e;
    }
}

export function setPassword(id: number, pw: string) {
    if (pw.length < 8)
        throw new Error("Password must be at least 8 characters");
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
        hashPassword(pw),
        id,
    );
}

export function setUsername(id: number, username: string) {
    if (!validUsername(username)) throw new Error("Invalid username");
    try {
        db.prepare("UPDATE users SET username=? WHERE id=?").run(username, id);
    } catch {
        throw new Error("That username is already taken");
    }
}

const adminCount = () =>
    (db.prepare("SELECT COUNT(*) c FROM users WHERE is_admin=1").get() as any)
        .c as number;

export function setAdmin(id: number, isAdmin: boolean) {
    if (!isAdmin && getUser(id)?.is_admin && adminCount() <= 1)
        throw new Error("Can't remove the last admin");
    db.prepare("UPDATE users SET is_admin=? WHERE id=?").run(
        isAdmin ? 1 : 0,
        id,
    );
}

export function deleteUser(id: number) {
    if (getUser(id)?.is_admin && adminCount() <= 1)
        throw new Error("Can't delete the last admin");
    db.prepare("DELETE FROM users WHERE id=?").run(id);
}

export function setPerms(
    id: number,
    add: boolean,
    edit: boolean,
    del: boolean,
) {
    db.prepare(
        `INSERT INTO connection_perms(user_id,can_add,can_edit,can_delete) VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET can_add=excluded.can_add,can_edit=excluded.can_edit,can_delete=excluded.can_delete`,
    ).run(id, +add, +edit, +del);
}

export function ensureRootUser() {
    const name = process.env.ROOT_USERNAME,
        pw = process.env.ROOT_PASSWORD;
    if (!name || !pw) {
        if (!adminCount())
            throw new Error(
                "No admin exists: set ROOT_USERNAME and ROOT_PASSWORD",
            );
        return;
    }
    const r = db
        .prepare("SELECT id FROM users WHERE username=?")
        .get(name) as any;
    if (!r) createUser(name, pw, true);
    else db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(r.id);
}

// ---------- sessions ----------
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const SESSION_MS = 12 * 3600_000;

export function createSession(userId: number) {
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
        sha(token),
        userId,
        crypto.randomBytes(24).toString("hex"),
        Date.now() + SESSION_MS,
    );
    return { token, maxAge: SESSION_MS };
}

export function getSession(token: string) {
    return db
        .prepare(
            "SELECT user_id,csrf FROM sessions WHERE token_hash=? AND expires>?",
        )
        .get(sha(token), Date.now()) as
        | { user_id: number; csrf: string }
        | undefined;
}

export const deleteSession = (token: string) =>
    void db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha(token));

export const deleteOtherSessions = (userId: number, keep: string) =>
    void db
        .prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?")
        .run(userId, sha(keep));

// ---------- connections ----------
export interface Conn {
    id: number;
    name: string;
    uri: string;
    created_by: number | null;
}

const toConn = (r: any): Conn | undefined =>
    r && {
        id: r.id,
        name: r.name,
        uri: dec(r.uri_enc),
        created_by: r.created_by,
    };

export const getConnection = (id: number) =>
    toConn(db.prepare("SELECT * FROM connections WHERE id=?").get(id));

export const listConnections = () =>
    (db.prepare("SELECT * FROM connections ORDER BY name").all() as any[]).map(
        (r) => toConn(r)!,
    );

export const maskUri = (u: string) =>
    u.replace(/(\/\/[^:@/]+:)[^@]*@/, "$1***@");

function checkConn(name: string, uri: string) {
    if (!name.trim()) throw new Error("Name is required");
    if (!/^mongodb(\+srv)?:\/\//.test(uri))
        throw new Error("URI must start with mongodb:// or mongodb+srv://");
}

const uniq = (e: any): never => {
    if (String(e.code).startsWith("SQLITE_CONSTRAINT"))
        throw new Error("A connection with that name already exists");
    throw e;
};

export function createConnection(name: string, uri: string, userId: number) {
    checkConn(name, uri);
    try {
        const id = Number(
            db
                .prepare(
                    "INSERT INTO connections(name,uri_enc,created_by) VALUES(?,?,?)",
                )
                .run(name.trim(), enc(uri), userId).lastInsertRowid,
        );
        db.prepare(
            "INSERT OR IGNORE INTO connection_access VALUES(?,?,'*')",
        ).run(userId, id); // creator can open it
        return id;
    } catch (e) {
        return uniq(e);
    }
}

export function updateConnection(id: number, name: string, uri: string | null) {
    const cur = getConnection(id);
    if (!cur) throw new Error("Connection not found");
    const newUri = uri || cur.uri;
    checkConn(name, newUri);
    try {
        db.prepare("UPDATE connections SET name=?,uri_enc=? WHERE id=?").run(
            name.trim(),
            enc(newUri),
            id,
        );
    } catch (e) {
        uniq(e);
    }
}

export const deleteConnection = (id: number) =>
    void db.prepare("DELETE FROM connections WHERE id=?").run(id);

// ---------- access ----------
export interface Grant {
    connection_id: number;
    name: string;
    db_name: string;
}

export function grantsFor(userId: number): Grant[] {
    return db
        .prepare(
            `SELECT a.connection_id,c.name,a.db_name FROM connection_access a
    JOIN connections c ON c.id=a.connection_id WHERE a.user_id=? ORDER BY c.name,a.db_name`,
        )
        .all(userId) as Grant[];
}

export const grant = (u: number, c: number, d: string) =>
    void db
        .prepare("INSERT OR IGNORE INTO connection_access VALUES(?,?,?)")
        .run(u, c, d.trim() || "*");

export const revoke = (u: number, c: number, d: string) =>
    void db
        .prepare(
            "DELETE FROM connection_access WHERE user_id=? AND connection_id=? AND db_name=?",
        )
        .run(u, c, d);

export function canAccessDb(user: User, connId: number, dbName: string) {
    if (user.is_admin) return true;
    return !!db
        .prepare(
            "SELECT 1 FROM connection_access WHERE user_id=? AND connection_id=? AND db_name IN (?, '*')",
        )
        .get(user.id, connId, dbName);
}
