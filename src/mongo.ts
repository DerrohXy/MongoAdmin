import { MongoClient } from "mongodb";
import { EJSON } from "bson";
import { getConnection, grantsFor, listConnections, type User } from "./db";

export class UserError extends Error {}

const clients = new Map<number, Promise<MongoClient>>();

export function clientFor(connId: number): Promise<MongoClient> {
    let p = clients.get(connId);
    if (!p) {
        const c = getConnection(connId);
        if (!c) throw new UserError("Connection not found");
        p = new MongoClient(c.uri, {
            serverSelectionTimeoutMS: 6000,
            maxPoolSize: 5,
            appName: "mongo-admin",
        }).connect();
        p.catch(() => clients.delete(connId));
        clients.set(connId, p);
    }
    return p;
}

export async function dropClient(connId: number) {
    const p = clients.get(connId);
    clients.delete(connId);
    if (p) await p.then((c) => c.close()).catch(() => {});
}

export async function ping(connId: number) {
    const c = await clientFor(connId);
    await c.db("admin").command({ ping: 1 });
}

export interface DashEntry {
    id: number;
    name: string;
    dbs: string[];
    error?: string;
}

/** Databases the user may open, grouped by connection. */
export async function dashboardFor(user: User): Promise<DashEntry[]> {
    const perConn = new Map<
        number,
        { name: string; names: Set<string>; all: boolean }
    >();
    if (user.is_admin)
        for (const c of listConnections())
            perConn.set(c.id, { name: c.name, names: new Set(), all: true });
    else
        for (const g of grantsFor(user.id)) {
            const e = perConn.get(g.connection_id) ?? {
                name: g.name,
                names: new Set<string>(),
                all: false,
            };
            if (g.db_name === "*") e.all = true;
            else e.names.add(g.db_name);
            perConn.set(g.connection_id, e);
        }
    return Promise.all(
        [...perConn].map(async ([id, e]): Promise<DashEntry> => {
            const names = new Set(e.names);
            let error: string | undefined;
            if (e.all) {
                try {
                    const client = await clientFor(id);
                    const r = await client
                        .db("admin")
                        .admin()
                        .listDatabases({ nameOnly: true });
                    r.databases.forEach((d) => names.add(d.name));
                } catch (err: any) {
                    error = err.message;
                    try {
                        names.add((await clientFor(id)).db().databaseName);
                    } catch {}
                }
            }
            return { id, name: e.name, dbs: [...names].sort(), error };
        }),
    );
}

// ---------- query parsing ----------
const FORBIDDEN = new Set([
    "$where",
    "$function",
    "$accumulator",
    "$out",
    "$merge",
]);

/** Reject operators that execute server-side JS or write outside the opened collection/database. */
export function assertSafe(v: any): void {
    if (Array.isArray(v)) return v.forEach(assertSafe);
    if (v && typeof v === "object" && !(v instanceof Date)) {
        for (const [k, x] of Object.entries(v)) {
            if (FORBIDDEN.has(k))
                throw new UserError(`Operator ${k} is not allowed`);
            if (
                (k === "$lookup" || k === "$unionWith") &&
                x &&
                typeof x === "object" &&
                "db" in (x as object)
            )
                throw new UserError(`Cross-database ${k} is not allowed`);
            assertSafe(x);
        }
    }
}

function parse(s: string, fallback: string, what: string): any {
    try {
        return EJSON.parse(s.trim() || fallback);
    } catch (e: any) {
        throw new UserError(`${what}: invalid JSON (${e.message})`);
    }
}

export function parseObject(
    s: string,
    what: string,
    fallback = "{}",
): Record<string, any> {
    const v = parse(s, fallback, what);
    if (!v || typeof v !== "object" || Array.isArray(v))
        throw new UserError(`${what} must be a JSON object`);
    assertSafe(v);
    return v;
}

export function parseArray(s: string, what: string): any[] {
    const v = parse(s, "[]", what);
    if (!Array.isArray(v)) throw new UserError(`${what} must be a JSON array`);
    assertSafe(v);
    return v;
}

export function parseDocs(s: string): Record<string, any>[] {
    const v = parse(s, "", "Document");
    const arr = Array.isArray(v) ? v : [v];
    if (
        !arr.length ||
        arr.some((d) => !d || typeof d !== "object" || Array.isArray(d))
    )
        throw new UserError("Provide a JSON object, or an array of objects");
    arr.forEach(assertSafe);
    return arr;
}
