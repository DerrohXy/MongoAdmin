import express, {
    type Request,
    type Response,
    type NextFunction,
} from "express";
import { EJSON } from "bson";
import * as D from "./db";
import {
    loadSession,
    csrfCheck,
    requireAuth,
    requireAdmin,
    loginBlocked,
    loginFailed,
    loginOk,
} from "./auth";
import {
    clientFor,
    dropClient,
    ping,
    dashboardFor,
    parseObject,
    parseArray,
    parseDocs,
    UserError,
} from "./mongo";
import * as V from "./views";
import { SendHTML } from "swiftssr";

D.ensureRootUser();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true");
app.use((_req, res, next) => {
    res.set({
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
    });
    next();
});
app.use(express.urlencoded({ extended: false, limit: "5mb" }));
app.use(loadSession);
app.use(csrfCheck);

// ---------- helpers ----------
const P = (req: Request) => req.params as Record<string, string>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const body = (req: Request) => (req.body ?? {}) as Record<string, string>;
const ctxOf = (req: Request): V.Ctx => ({
    user: req.user,
    csrf: req.csrf,
    ok: s(req.query.ok) || undefined,
    err: s(req.query.err) || undefined,
});
const errMsg = (e: any) =>
    e instanceof UserError || e?.message
        ? String(e.message)
        : "Unexpected error";
const send = (
    req: Request,
    res: Response,
    title: string,
    content: any,
    status = 200,
) => SendHTML(res, V.page(ctxOf(req), title, content), status);

/** Redirect to dest with a flash message. Only same-site paths are accepted. */
function flash(res: Response, dest: string, kind: "ok" | "err", msg: string) {
    const u = new URL(/^\/(?!\/)/.test(dest) ? dest : "/", "http://x");
    u.searchParams.delete("ok");
    u.searchParams.delete("err");
    u.searchParams.set(kind, msg);
    res.redirect(u.pathname + u.search);
}

/** POST handler wrapper: runs fn, then redirects (to body.ret or dflt) with its message or the error. */
const act =
    (
        dflt: (req: Request) => string,
        fn: (req: Request, res: Response) => unknown,
    ) =>
    async (req: Request, res: Response) => {
        const dest = body(req).ret || dflt(req);
        try {
            const m = await fn(req, res);
            if (!res.headersSent)
                flash(res, dest, "ok", typeof m === "string" ? m : "Done");
        } catch (e) {
            flash(res, dest, "err", errMsg(e));
        }
    };

// ---------- auth ----------
app.get("/login", (req, res) =>
    req.user
        ? res.redirect("/")
        : send(req, res, "Sign in", <V.LoginPage ctx={ctxOf(req)} />),
);

app.post("/login", (req, res) => {
    const ip = req.ip ?? "?";
    if (loginBlocked(ip))
        return flash(
            res,
            "/login",
            "err",
            "Too many attempts. Try again later.",
        );
    const user = D.authenticate(s(body(req).username), s(body(req).password));
    if (!user) {
        loginFailed(ip);
        return flash(res, "/login", "err", "Invalid username or password");
    }
    loginOk(ip);
    const { token, maxAge } = D.createSession(user.id);
    res.cookie("sid", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.COOKIE_SECURE === "true",
        maxAge,
        path: "/",
    });
    res.redirect("/");
});

app.post("/logout", (req, res) => {
    if (req.sid) D.deleteSession(req.sid);
    res.clearCookie("sid", { path: "/" });
    res.redirect("/login");
});

app.get("/account", requireAuth, (req, res) =>
    send(req, res, "Account", <V.AccountPage ctx={ctxOf(req)} />),
);

app.post(
    "/account",
    requireAuth,
    act(
        () => "/account",
        (req) => {
            const b = body(req),
                u = req.user!;
            if (!D.checkUserPassword(u.id, s(b.current_password)))
                throw new Error("Current password is incorrect");
            if (b.username && b.username !== u.username)
                D.setUsername(u.id, b.username.trim());
            if (b.new_password) {
                if (b.new_password !== b.confirm)
                    throw new Error("New passwords don't match");
                D.setPassword(u.id, b.new_password);
                D.deleteOtherSessions(u.id, req.sid!);
            }
            return "Account updated";
        },
    ),
);

// ---------- dashboard ----------
app.get("/", requireAuth, async (req, res) =>
    send(
        req,
        res,
        "Databases",
        <V.DashboardPage
            ctx={ctxOf(req)}
            entries={await dashboardFor(req.user!)}
        />,
    ),
);

// ---------- admin: users ----------
app.get("/admin/users", requireAdmin, (req, res) =>
    send(
        req,
        res,
        "Users",
        <V.UsersPage ctx={ctxOf(req)} users={D.listUsers()} />,
    ),
);

app.post(
    "/admin/users",
    requireAdmin,
    act(
        () => "/admin/users",
        (req) => {
            const b = body(req);
            D.createUser(s(b.username).trim(), s(b.password), !!b.is_admin);
            return "User created";
        },
    ),
);

app.get("/admin/users/:id", requireAdmin, (req, res) => {
    const u = D.getUser(Number(P(req).id));
    if (!u)
        return send(
            req,
            res,
            "Not found",
            <V.ErrorPage code={404} message="User not found" />,
            404,
        );
    send(
        req,
        res,
        u.username,
        <V.UserEditPage
            ctx={ctxOf(req)}
            u={u}
            grants={D.grantsFor(u.id)}
            conns={D.listConnections().map(({ id, name }) => ({ id, name }))}
        />,
    );
});

const userUrl = (req: Request) => `/admin/users/${P(req).id}`;

app.post(
    "/admin/users/:id",
    requireAdmin,
    act(userUrl, (req) => {
        const id = Number(P(req).id),
            b = body(req);
        if (!D.getUser(id)) throw new Error("User not found");
        if (id !== req.user!.id) D.setAdmin(id, !!b.is_admin);
        D.setPerms(id, !!b.can_add, !!b.can_edit, !!b.can_delete);
        if (b.new_password) D.setPassword(id, b.new_password);
        return "Saved";
    }),
);

app.post(
    "/admin/users/:id/grant",
    requireAdmin,
    act(userUrl, (req) => {
        const b = body(req);
        if (!D.getConnection(Number(b.connection_id)))
            throw new Error("Connection not found");
        D.grant(Number(P(req).id), Number(b.connection_id), s(b.db_name));
        return "Access granted";
    }),
);

app.post(
    "/admin/users/:id/revoke",
    requireAdmin,
    act(userUrl, (req) => {
        D.revoke(
            Number(P(req).id),
            Number(body(req).connection_id),
            s(body(req).db_name),
        );
        return "Access revoked";
    }),
);

app.post(
    "/admin/users/:id/delete",
    requireAdmin,
    act(
        () => "/admin/users",
        (req) => {
            const id = Number(P(req).id);
            if (id === req.user!.id)
                throw new Error("You can't delete yourself");
            D.deleteUser(id);
            return "User deleted";
        },
    ),
);

// ---------- connections ----------
const need =
    (k: "add" | "edit" | "del") =>
    (req: Request, res: Response, next: NextFunction) =>
        req.user!.perms[k]
            ? next()
            : void res.status(403).send("You don't have permission to do that");

app.get("/connections", requireAuth, (req, res) => {
    const u = req.user!;
    const open = new Set(
        u.is_admin
            ? D.listConnections().map((c) => c.id)
            : D.grantsFor(u.id).map((g) => g.connection_id),
    );
    const manage = u.perms.add || u.perms.edit || u.perms.del;
    const rows = D.listConnections()
        .filter((c) => manage || open.has(c.id))
        .map((c) => ({
            id: c.id,
            name: c.name,
            masked: D.maskUri(c.uri),
            canOpen: open.has(c.id),
        }));
    send(
        req,
        res,
        "Connections",
        <V.ConnectionsPage ctx={ctxOf(req)} rows={rows} />,
    );
});

app.get("/connections/new", requireAuth, need("add"), (req, res) =>
    send(req, res, "New connection", <V.ConnectionForm ctx={ctxOf(req)} />),
);

app.post("/connections", requireAuth, need("add"), async (req, res) => {
    try {
        const id = D.createConnection(
            s(body(req).name),
            s(body(req).uri).trim(),
            req.user!.id,
        );
        flash(res, "/connections", "ok", await testMsg(id, "Connection added"));
    } catch (e) {
        flash(res, "/connections/new", "err", errMsg(e));
    }
});

app.get("/connections/:id/edit", requireAuth, need("edit"), (req, res) => {
    const c = D.getConnection(Number(P(req).id));
    if (!c)
        return send(
            req,
            res,
            "Not found",
            <V.ErrorPage code={404} message="Connection not found" />,
            404,
        );
    send(
        req,
        res,
        "Edit connection",
        <V.ConnectionForm
            ctx={ctxOf(req)}
            id={c.id}
            name={c.name}
            masked={D.maskUri(c.uri)}
        />,
    );
});

app.post("/connections/:id", requireAuth, need("edit"), async (req, res) => {
    const id = Number(P(req).id);
    try {
        D.updateConnection(
            id,
            s(body(req).name),
            s(body(req).uri).trim() || null,
        );
        await dropClient(id);
        flash(
            res,
            "/connections",
            "ok",
            await testMsg(id, "Connection updated"),
        );
    } catch (e) {
        flash(res, `/connections/${id}/edit`, "err", errMsg(e));
    }
});

app.post(
    "/connections/:id/delete",
    requireAuth,
    need("del"),
    act(
        () => "/connections",
        async (req) => {
            const id = Number(P(req).id);
            D.deleteConnection(id);
            await dropClient(id);
            return "Connection deleted";
        },
    ),
);

async function testMsg(id: number, saved: string) {
    try {
        await ping(id);
        return `${saved}; connection test OK`;
    } catch (e: any) {
        return `${saved}, but the connection test failed: ${e.message}`;
    }
}

// ---------- explorer ----------
const explorer = express.Router({ mergeParams: true });

app.use(
    "/c/:cid/d/:db",
    requireAuth,
    (req, res, next) => {
        const cid = Number(P(req).cid),
            conn = D.getConnection(cid);
        if (!conn || !D.canAccessDb(req.user!, cid, P(req).db)) {
            return send(
                req,
                res,
                "Not found",
                <V.ErrorPage
                    code={404}
                    message="Database not found or access denied"
                />,
                404,
            );
        }
        res.locals.conn = conn;
        next();
    },
    explorer,
);

const dbOf = async (req: Request) =>
    (await clientFor(Number(P(req).cid))).db(P(req).db);

const colOf = async (req: Request) => (await dbOf(req)).collection(P(req).coll);

const dbUrl = (req: Request) =>
    `/c/${P(req).cid}/d/${encodeURIComponent(P(req).db)}`;

const colUrl = (req: Request) =>
    `${dbUrl(req)}/${encodeURIComponent(P(req).coll)}`;

const parseId = (v: string) => {
    try {
        return EJSON.parse(v);
    } catch {
        throw new UserError("Invalid _id");
    }
};

const PROJECT = { maxTimeMS: 8000 };

explorer.get("/", async (req, res) => {
    const d = await dbOf(req);
    const list = await d.listCollections({}, { nameOnly: false }).toArray();
    const colls = await Promise.all(
        list
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(async (c) => ({
                name: c.name,
                type: c.type ?? "collection",
                count:
                    c.type === "view"
                        ? null
                        : await d
                              .collection(c.name)
                              .estimatedDocumentCount()
                              .catch(() => null),
            })),
    );
    send(
        req,
        res,
        P(req).db,
        <V.DatabasePage
            ctx={ctxOf(req)}
            cid={Number(P(req).cid)}
            connName={res.locals.conn.name}
            db={P(req).db}
            colls={colls}
        />,
    );
});

explorer.post(
    "/create",
    act(dbUrl, async (req) => {
        const name = s(body(req).coll).trim();
        if (!name || /^system\.|\$/.test(name))
            throw new UserError("Invalid collection name");
        await (await dbOf(req)).createCollection(name);
        return `Collection ${name} created`;
    }),
);

explorer.post(
    "/drop",
    act(dbUrl, async (req) => {
        const name = s(body(req).coll);
        await (await dbOf(req)).dropCollection(name);
        return `Collection ${name} dropped`;
    }),
);

explorer.get("/:coll", async (req, res) => {
    const q = req.query,
        tab = ["documents", "indexes", "aggregate", "stats"].includes(s(q.tab))
            ? s(q.tab)
            : "documents";
    const limit = [10, 25, 50, 100].includes(Number(q.limit))
        ? Number(q.limit)
        : 25;
    const pg = Math.max(1, Math.floor(Number(q.page)) || 1);
    const col = await colOf(req);
    const p: V.CollProps = {
        ctx: ctxOf(req),
        cid: Number(P(req).cid),
        connName: res.locals.conn.name,
        db: P(req).db,
        coll: P(req).coll,
        tab,
        ret: req.originalUrl
            .replace(/([?&])(ok|err)=[^&]*/g, "$1")
            .replace(/[?&]$/, ""),
        filter: s(q.filter) || "{}",
        sort: s(q.sort),
        projection: s(q.projection),
        limit,
        pg,
        docs: [],
        total: null,
        indexes: [],
        stats: [],
        pipeline:
            s(q.pipeline) || '[\n  { "$match": {} },\n  { "$limit": 20 }\n]',
        topField: s(q.top),
        top: [],
    };
    try {
        if (tab === "documents") {
            const filter = parseObject(p.filter, "Filter");
            const sort = parseObject(p.sort, "Sort");
            const projection = parseObject(p.projection, "Projection");
            p.total = await col
                .countDocuments(filter, PROJECT)
                .catch(() => null);
            p.docs = await col
                .find(filter, {
                    sort,
                    projection,
                    skip: (pg - 1) * limit,
                    limit,
                    ...PROJECT,
                })
                .toArray();
        } else if (tab === "indexes") {
            p.indexes = await col.indexes();
        } else if (tab === "aggregate" && q.pipeline !== undefined) {
            const cur = col.aggregate(parseArray(p.pipeline, "Pipeline"), {
                maxTimeMS: 15000,
                allowDiskUse: true,
            });
            const out: unknown[] = [];
            for await (const d of cur) {
                out.push(d);
                if (out.length >= 200) break;
            }
            await cur.close();
            p.aggOut = EJSON.stringify(out, { relaxed: true }, 2);
        } else if (tab === "stats") {
            let st: any = {};
            try {
                st =
                    (
                        await col
                            .aggregate([{ $collStats: { storageStats: {} } }])
                            .toArray()
                    )[0]?.storageStats ?? {};
            } catch {}
            const n =
                st.count ?? (await col.estimatedDocumentCount().catch(() => 0));
            const kb = (v: any) =>
                v === undefined
                    ? "-"
                    : v > 1048576
                      ? `${(v / 1048576).toFixed(1)} MB`
                      : `${(v / 1024).toFixed(1)} KB`;
            p.stats = [
                ["Documents", String(n)],
                ["Data size", kb(st.size)],
                [
                    "Avg doc size",
                    st.avgObjSize !== undefined ? `${st.avgObjSize} B` : "-",
                ],
                ["Storage size", kb(st.storageSize)],
                ["Indexes", String(st.nindexes ?? "-")],
                ["Total index size", kb(st.totalIndexSize)],
            ];
            if (p.topField) {
                if (!/^[A-Za-z0-9_.-]+$/.test(p.topField))
                    throw new UserError("Invalid field name");
                p.top = await col
                    .aggregate(
                        [
                            {
                                $group: {
                                    _id: "$" + p.topField,
                                    count: { $sum: 1 },
                                },
                            },
                            { $sort: { count: -1 } },
                            { $limit: 20 },
                        ],
                        { maxTimeMS: 10000 },
                    )
                    .toArray();
            }
        }
    } catch (e) {
        p.error = errMsg(e);
        if (tab === "aggregate") p.aggOut = undefined;
    }
    send(req, res, `${P(req).db}.${P(req).coll}`, <V.CollectionPage {...p} />);
});

explorer.post(
    "/:coll/insert",
    act(colUrl, async (req) => {
        const docs = parseDocs(s(body(req).docs));
        const col = await colOf(req);
        if (docs.length === 1) await col.insertOne(docs[0]);
        else await col.insertMany(docs);
        return `Inserted ${docs.length} document(s)`;
    }),
);

explorer.post(
    "/:coll/update",
    act(colUrl, async (req) => {
        const b = body(req),
            filter = parseObject(s(b.filter), "Filter");
        const update = parseObject(s(b.update), "Update");
        if (
            !Object.keys(update).length ||
            Object.keys(update).some((k) => !k.startsWith("$"))
        )
            throw new UserError(
                'Update must use operators, e.g. {"$set": {"field": 1}}',
            );
        const col = await colOf(req);
        const r =
            b.mode === "one"
                ? await col.updateOne(filter, update)
                : await col.updateMany(filter, update);
        return `Matched ${r.matchedCount}, modified ${r.modifiedCount}`;
    }),
);

explorer.post(
    "/:coll/delete",
    act(colUrl, async (req) => {
        const b = body(req),
            filter = parseObject(s(b.filter), "Filter"),
            col = await colOf(req);
        if (b.mode === "one")
            return `Deleted ${(await col.deleteOne(filter)).deletedCount} document(s)`;
        if (b.confirm !== "DELETE")
            throw new UserError(
                "Type DELETE in the box to delete all matching documents",
            );
        return `Deleted ${(await col.deleteMany(filter)).deletedCount} document(s)`;
    }),
);

explorer.get("/:coll/doc", async (req, res) => {
    const idJson = s(req.query.id),
        col = await colOf(req);
    const doc = await col.findOne({ _id: parseId(idJson) });
    const ret = colUrl(req);
    if (!doc) return flash(res, ret, "err", "Document not found");
    send(
        req,
        res,
        "Edit document",
        <V.DocEditPage
            ctx={ctxOf(req)}
            cid={Number(P(req).cid)}
            connName={res.locals.conn.name}
            db={P(req).db}
            coll={P(req).coll}
            idJson={idJson}
            json={EJSON.stringify(doc, { relaxed: true }, 2)}
            ret={colUrl(req)}
        />,
    );
});

explorer.post(
    "/:coll/doc/save",
    act(colUrl, async (req) => {
        const id = parseId(s(body(req).id));
        const [doc] = parseDocs(s(body(req).doc));
        if (doc._id === undefined) doc._id = id;
        const r = await (await colOf(req)).replaceOne({ _id: id }, doc);
        if (!r.matchedCount) throw new UserError("Document no longer exists");
        return "Document saved";
    }),
);

explorer.post(
    "/:coll/doc/delete",
    act(colUrl, async (req) => {
        await (await colOf(req)).deleteOne({ _id: parseId(s(body(req).id)) });
        return "Document deleted";
    }),
);

explorer.post(
    "/:coll/index/create",
    act(colUrl, async (req) => {
        const b = body(req),
            keys = parseObject(s(b.keys), "Keys");
        const name = await (
            await colOf(req)
        ).createIndex(keys as any, {
            unique: !!b.unique,
            ...(b.name ? { name: b.name } : {}),
        });
        return `Index ${name} created`;
    }),
);

explorer.post(
    "/:coll/index/drop",
    act(colUrl, async (req) => {
        await (await colOf(req)).dropIndex(s(body(req).name));
        return "Index dropped";
    }),
);

// ---------- errors ----------
app.use((req, res) =>
    send(
        req,
        res,
        "Not found",
        <V.ErrorPage code={404} message="Page not found" />,
        404,
    ),
);

app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    send(
        req,
        res,
        "Error",
        <V.ErrorPage code={500} message={errMsg(err)} />,
        500,
    );
});

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () =>
    console.log(`Mongo Admin running on http://localhost:${port}`),
);
