import { Document, EmbeddedJS, EmbeddedCSS } from "swiftssr";
import { EJSON } from "bson";
import type { User, Grant } from "./db";
import type { DashEntry } from "./mongo";

type C = any;
export interface Ctx {
    user?: User;
    csrf?: string;
    ok?: string;
    err?: string;
}

const BS_CSS =
    "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css";
const BS_JS =
    "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js";

const css = `
body {
    background: #f4f6f9;
}
.navbar-brand {
    font-weight: 600;
}
textarea.json-editor {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.85rem;
    tab-size: 2;
}
td.cell {
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.8rem;
}
pre.out {
    background: #0f172a;
    color: #e2e8f0;
    padding: 1rem;
    border-radius: 0.5rem;
    max-height: 480px;
    overflow: auto;
    font-size: 0.8rem;
}
`;

// Client-side: JSON editor enhancement (validate / format / Tab indent) and confirm dialogs.
const clientJs = `
document.querySelectorAll("textarea.json-editor").forEach(function (ta) {
    var bar = document.createElement("div");
    bar.className = "d-flex gap-2 align-items-center mb-1 small";
    var fmt = document.createElement("button");
    fmt.type = "button";
    fmt.className = "btn btn-sm btn-outline-secondary py-0";
    fmt.textContent = "Format";
    var st = document.createElement("span");
    bar.appendChild(fmt);
    bar.appendChild(st);
    ta.parentNode.insertBefore(bar, ta);
    function check() {
        var v = ta.value.trim();
        ta.classList.remove("is-invalid");
        st.textContent = "";
        if (!v) return;
        try {
            JSON.parse(v);
            st.textContent = "valid JSON";
            st.className = "text-success";
        } catch (e) {
            st.textContent = e.message;
            st.className = "text-danger";
            ta.classList.add("is-invalid");
        }
    }
    fmt.addEventListener("click", function () {
        try {
            ta.value = JSON.stringify(JSON.parse(ta.value), null, 2);
        } catch (e) {}
        check();
    });
    ta.addEventListener("input", check);
    ta.addEventListener("keydown", function (e) {
        if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
        }
    });
    check();
});
document.addEventListener("submit", function (e) {
    var m = e.target.getAttribute && e.target.getAttribute("data-confirm");
    if (m && !confirm(m)) e.preventDefault();
});
`;

export function page(ctx: Ctx, title: string, body: C): string {
    const u = ctx.user;
    return Document({
        title: `${title} · Mongo Admin`,
        head: [<link rel="stylesheet" href={BS_CSS} />, EmbeddedCSS(css)],
        body: (
            <>
                <nav className="navbar navbar-expand navbar-dark bg-dark px-3">
                    <a className="navbar-brand" href="/">
                        Mongo Admin
                    </a>
                    {u && (
                        <>
                            <ul className="navbar-nav me-auto">
                                <li className="nav-item">
                                    <a className="nav-link" href="/">
                                        Databases
                                    </a>
                                </li>
                                <li className="nav-item">
                                    <a className="nav-link" href="/connections">
                                        Connections
                                    </a>
                                </li>
                                {u.is_admin && (
                                    <li className="nav-item">
                                        <a
                                            className="nav-link"
                                            href="/admin/users"
                                        >
                                            Users
                                        </a>
                                    </li>
                                )}
                            </ul>
                            <a
                                className="nav-link text-light me-3"
                                href="/account"
                            >
                                {u.username}
                                {u.is_admin ? " (admin)" : ""}
                            </a>
                            <Form ctx={ctx} action="/logout">
                                <button className="btn btn-sm btn-outline-light">
                                    Sign out
                                </button>
                            </Form>
                        </>
                    )}
                </nav>
                <main className="container-fluid py-4 px-4">
                    {ctx.ok && (
                        <div className="alert alert-success">{ctx.ok}</div>
                    )}
                    {ctx.err && (
                        <div className="alert alert-danger">{ctx.err}</div>
                    )}
                    {body}
                </main>
                <script src={BS_JS}></script>
                {EmbeddedJS(clientJs)}
            </>
        ),
    });
}

function Form(p: {
    ctx: Ctx;
    action: string;
    ret?: string;
    confirm?: string;
    cls?: string;
    children?: C;
}) {
    return (
        <form
            method="post"
            action={p.action}
            className={p.cls}
            data-confirm={p.confirm}
        >
            <input type="hidden" name="_csrf" value={p.ctx.csrf ?? ""} />
            {p.ret && <input type="hidden" name="ret" value={p.ret} />}
            {p.children}
        </form>
    );
}

const Field = (p: { label: string; children?: C }) => (
    <div className="mb-3">
        <label className="form-label fw-semibold">{p.label}</label>
        {p.children}
    </div>
);

const Json = (p: { name: string; value?: string; rows?: number }) => (
    <textarea
        className="form-control json-editor"
        name={p.name}
        rows={p.rows ?? 3}
        spellcheck="false"
    >
        {p.value ?? ""}
    </textarea>
);

const Card = (p: { title: string; children?: C; cls?: string }) => (
    <div className={`card shadow-sm mb-4 ${p.cls ?? ""}`}>
        <div className="card-header fw-semibold">{p.title}</div>
        <div className="card-body">{p.children}</div>
    </div>
);

const enc = encodeURIComponent;

// ---------------- auth / account ----------------
export const LoginPage = (p: { ctx: Ctx }) => (
    <div className="row justify-content-center">
        <div className="col-md-4 mt-5">
            <Card title="Sign in">
                <form method="post" action="/login">
                    <Field label="Username">
                        <input
                            className="form-control"
                            name="username"
                            autocomplete="username"
                            required
                            autofocus
                        />
                    </Field>
                    <Field label="Password">
                        <input
                            className="form-control"
                            type="password"
                            name="password"
                            autocomplete="current-password"
                            required
                        />
                    </Field>
                    <button className="btn btn-primary w-100">Sign in</button>
                </form>
            </Card>
        </div>
    </div>
);

export const AccountPage = (p: { ctx: Ctx }) => (
    <div className="row">
        <div className="col-md-5">
            <Card title="Account settings">
                <Form ctx={p.ctx} action="/account">
                    <Field label="Username">
                        <input
                            className="form-control"
                            name="username"
                            value={p.ctx.user!.username}
                            required
                        />
                    </Field>
                    <Field label="New password (leave blank to keep)">
                        <input
                            className="form-control"
                            type="password"
                            name="new_password"
                            autocomplete="new-password"
                        />
                    </Field>
                    <Field label="Confirm new password">
                        <input
                            className="form-control"
                            type="password"
                            name="confirm"
                            autocomplete="new-password"
                        />
                    </Field>
                    <hr />
                    <Field label="Current password (required)">
                        <input
                            className="form-control"
                            type="password"
                            name="current_password"
                            autocomplete="current-password"
                            required
                        />
                    </Field>
                    <button className="btn btn-primary">Save</button>
                </Form>
            </Card>
        </div>
    </div>
);

// ---------------- dashboard / connections ----------------
export const DashboardPage = (p: { ctx: Ctx; entries: DashEntry[] }) => (
    <>
        <h4 className="mb-3">Your databases</h4>
        {!p.entries.length && (
            <div className="alert alert-info">
                You don't have access to any databases yet. Ask an admin to
                grant access.
            </div>
        )}
        <div className="row">
            {p.entries.map((e) => (
                <div className="col-md-4">
                    <Card title={e.name}>
                        {e.error && (
                            <div className="text-danger small mb-2">
                                {e.error}
                            </div>
                        )}
                        {!e.dbs.length && !e.error && (
                            <div className="text-muted">No databases</div>
                        )}
                        <div className="list-group">
                            {e.dbs.map((d) => (
                                <a
                                    className="list-group-item list-group-item-action"
                                    href={`/c/${e.id}/d/${enc(d)}`}
                                >
                                    {d}
                                </a>
                            ))}
                        </div>
                    </Card>
                </div>
            ))}
        </div>
    </>
);

export interface ConnRow {
    id: number;
    name: string;
    masked: string;
    canOpen: boolean;
}

export const ConnectionsPage = (p: { ctx: Ctx; rows: ConnRow[] }) => {
    const u = p.ctx.user!;
    return (
        <>
            <div className="d-flex justify-content-between mb-3">
                <h4>Connections</h4>
                {u.perms.add && (
                    <a className="btn btn-primary" href="/connections/new">
                        Add connection
                    </a>
                )}
            </div>
            <table className="table table-hover bg-white shadow-sm">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>URI</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {p.rows.map((r) => (
                        <tr>
                            <td>{r.name}</td>
                            <td className="font-monospace small">{r.masked}</td>
                            <td className="text-end">
                                {u.perms.edit && (
                                    <a
                                        className="btn btn-sm btn-outline-secondary me-1"
                                        href={`/connections/${r.id}/edit`}
                                    >
                                        Edit
                                    </a>
                                )}
                                {u.perms.del && (
                                    <Form
                                        ctx={p.ctx}
                                        action={`/connections/${r.id}/delete`}
                                        cls="d-inline"
                                        confirm={`Delete connection "${r.name}"?`}
                                    >
                                        <button className="btn btn-sm btn-outline-danger">
                                            Delete
                                        </button>
                                    </Form>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </>
    );
};

export const ConnectionForm = (p: {
    ctx: Ctx;
    id?: number;
    name?: string;
    masked?: string;
}) => (
    <div className="row">
        <div className="col-md-7">
            <Card title={p.id ? "Edit connection" : "New connection"}>
                <Form
                    ctx={p.ctx}
                    action={p.id ? `/connections/${p.id}` : "/connections"}
                >
                    <Field label="Name">
                        <input
                            className="form-control"
                            name="name"
                            value={p.name ?? ""}
                            required
                        />
                    </Field>
                    <Field
                        label={
                            p.id
                                ? `Connection URI (current: ${p.masked}) - leave blank to keep`
                                : "Connection URI"
                        }
                    >
                        <input
                            className="form-control font-monospace"
                            name="uri"
                            placeholder="mongodb://user:pass@host:27017/db"
                            required={!p.id}
                            autocomplete="off"
                        />
                    </Field>
                    <button className="btn btn-primary me-2">Save</button>
                    <a className="btn btn-link" href="/connections">
                        Cancel
                    </a>
                </Form>
            </Card>
        </div>
    </div>
);

// ---------------- admin: users ----------------
export const UsersPage = (p: { ctx: Ctx; users: User[] }) => (
    <div className="row">
        <div className="col-md-8">
            <table className="table table-hover bg-white shadow-sm">
                <thead>
                    <tr>
                        <th>User</th>
                        <th>Role</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {p.users.map((u) => (
                        <tr>
                            <td>{u.username}</td>
                            <td>
                                {u.is_admin ? (
                                    <span className="badge bg-danger">
                                        admin
                                    </span>
                                ) : (
                                    <span className="badge bg-secondary">
                                        user
                                    </span>
                                )}
                            </td>
                            <td className="text-end">
                                <a
                                    className="btn btn-sm btn-outline-secondary me-1"
                                    href={`/admin/users/${u.id}`}
                                >
                                    Access
                                </a>
                                {u.id !== p.ctx.user!.id && (
                                    <Form
                                        ctx={p.ctx}
                                        action={`/admin/users/${u.id}/delete`}
                                        cls="d-inline"
                                        confirm={`Delete user ${u.username}?`}
                                    >
                                        <button className="btn btn-sm btn-outline-danger">
                                            Delete
                                        </button>
                                    </Form>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
        <div className="col-md-4">
            <Card title="Add user">
                <Form ctx={p.ctx} action="/admin/users">
                    <Field label="Username">
                        <input
                            className="form-control"
                            name="username"
                            required
                        />
                    </Field>
                    <Field label="Password (min 8)">
                        <input
                            className="form-control"
                            type="password"
                            name="password"
                            autocomplete="new-password"
                            required
                        />
                    </Field>
                    <div className="form-check mb-3">
                        <input
                            className="form-check-input"
                            type="checkbox"
                            name="is_admin"
                            id="isadm"
                        />
                        <label className="form-check-label" htmlFor="isadm">
                            Administrator
                        </label>
                    </div>
                    <button className="btn btn-primary">Create</button>
                </Form>
            </Card>
        </div>
    </div>
);

export const UserEditPage = (p: {
    ctx: Ctx;
    u: User;
    grants: Grant[];
    conns: { id: number; name: string }[];
}) => {
    const self = p.u.id === p.ctx.user!.id;
    const act = `/admin/users/${p.u.id}`;
    return (
        <>
            <h4 className="mb-3">
                <a href="/admin/users">Users</a> / {p.u.username}
            </h4>
            <div className="row">
                <div className="col-md-4">
                    <Card title="Role &amp; connection permissions">
                        <Form ctx={p.ctx} action={act}>
                            <div className="form-check mb-2">
                                <input
                                    className="form-check-input"
                                    type="checkbox"
                                    name="is_admin"
                                    id="a"
                                    checked={p.u.is_admin}
                                    disabled={self}
                                />
                                <label className="form-check-label" htmlFor="a">
                                    Administrator
                                </label>
                            </div>
                            <div className="small text-muted mb-1">
                                May manage connection records:
                            </div>
                            <div className="form-check">
                                <input
                                    className="form-check-input"
                                    type="checkbox"
                                    name="can_add"
                                    id="pa"
                                    checked={p.u.perms.add}
                                />
                                <label
                                    className="form-check-label"
                                    htmlFor="pa"
                                >
                                    Add
                                </label>
                            </div>
                            <div className="form-check">
                                <input
                                    className="form-check-input"
                                    type="checkbox"
                                    name="can_edit"
                                    id="pe"
                                    checked={p.u.perms.edit}
                                />
                                <label
                                    className="form-check-label"
                                    htmlFor="pe"
                                >
                                    Edit / update
                                </label>
                            </div>
                            <div className="form-check mb-3">
                                <input
                                    className="form-check-input"
                                    type="checkbox"
                                    name="can_delete"
                                    id="pd"
                                    checked={p.u.perms.del}
                                />
                                <label
                                    className="form-check-label"
                                    htmlFor="pd"
                                >
                                    Delete
                                </label>
                            </div>
                            <Field label="Reset password (optional)">
                                <input
                                    className="form-control"
                                    type="password"
                                    name="new_password"
                                    autocomplete="new-password"
                                />
                            </Field>
                            <button className="btn btn-primary">Save</button>
                        </Form>
                    </Card>
                </div>
                <div className="col-md-8">
                    <Card title="Database access">
                        {p.u.is_admin && (
                            <div className="text-muted small mb-2">
                                Admins can open every database on every
                                connection.
                            </div>
                        )}
                        <table className="table table-sm">
                            <thead>
                                <tr>
                                    <th>Connection</th>
                                    <th>Database</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {p.grants.map((g) => (
                                    <tr>
                                        <td>{g.name}</td>
                                        <td>
                                            {g.db_name === "*"
                                                ? "* (all)"
                                                : g.db_name}
                                        </td>
                                        <td className="text-end">
                                            <Form
                                                ctx={p.ctx}
                                                action={`${act}/revoke`}
                                                cls="d-inline"
                                            >
                                                <input
                                                    type="hidden"
                                                    name="connection_id"
                                                    value={String(
                                                        g.connection_id,
                                                    )}
                                                />
                                                <input
                                                    type="hidden"
                                                    name="db_name"
                                                    value={g.db_name}
                                                />
                                                <button className="btn btn-sm btn-outline-danger py-0">
                                                    Revoke
                                                </button>
                                            </Form>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <Form ctx={p.ctx} action={`${act}/grant`} cls="row g-2">
                            <div className="col-md-5">
                                <select
                                    className="form-select"
                                    name="connection_id"
                                    required
                                >
                                    {p.conns.map((c) => (
                                        <option value={String(c.id)}>
                                            {c.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="col-md-4">
                                <input
                                    className="form-control"
                                    name="db_name"
                                    value="*"
                                    placeholder="database or *"
                                />
                            </div>
                            <div className="col-md-3">
                                <button className="btn btn-primary w-100">
                                    Grant
                                </button>
                            </div>
                        </Form>
                    </Card>
                </div>
            </div>
        </>
    );
};

// ---------------- explorer ----------------
const Crumbs = (p: {
    cid: number;
    connName: string;
    db: string;
    coll?: string;
}) => (
    <nav className="mb-3 text-muted">
        <a href="/">Databases</a> / {p.connName} /{" "}
        <a href={`/c/${p.cid}/d/${enc(p.db)}`}>{p.db}</a>
        {p.coll && (
            <>
                {" "}
                / <strong>{p.coll}</strong>
            </>
        )}
    </nav>
);

export interface CollRow {
    name: string;
    type: string;
    count: number | null;
}

export const DatabasePage = (p: {
    ctx: Ctx;
    cid: number;
    connName: string;
    db: string;
    colls: CollRow[];
}) => {
    const base = `/c/${p.cid}/d/${enc(p.db)}`;
    return (
        <>
            <Crumbs {...p} />
            <div className="row">
                <div className="col-md-8">
                    <table className="table table-hover bg-white shadow-sm">
                        <thead>
                            <tr>
                                <th>Collection</th>
                                <th>Type</th>
                                <th className="text-end">Documents (est.)</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {p.colls.map((c) => (
                                <tr>
                                    <td>
                                        <a href={`${base}/${enc(c.name)}`}>
                                            {c.name}
                                        </a>
                                    </td>
                                    <td>{c.type}</td>
                                    <td className="text-end">
                                        {c.count ?? "-"}
                                    </td>
                                    <td className="text-end">
                                        <Form
                                            ctx={p.ctx}
                                            action={`${base}/drop`}
                                            cls="d-inline"
                                            confirm={`Drop collection ${c.name} and all its data?`}
                                        >
                                            <input
                                                type="hidden"
                                                name="coll"
                                                value={c.name}
                                            />
                                            <button className="btn btn-sm btn-outline-danger py-0">
                                                Drop
                                            </button>
                                        </Form>
                                    </td>
                                </tr>
                            ))}
                            {!p.colls.length && (
                                <tr>
                                    <td colspan={4} className="text-muted">
                                        No collections
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
                <div className="col-md-4">
                    <Card title="Create collection">
                        <Form ctx={p.ctx} action={`${base}/create`}>
                            <Field label="Name">
                                <input
                                    className="form-control"
                                    name="coll"
                                    required
                                />
                            </Field>
                            <button className="btn btn-primary">Create</button>
                        </Form>
                    </Card>
                </div>
            </div>
        </>
    );
};

const show = (v: any): string => {
    if (v === undefined) return "";
    if (typeof v === "string") return v;
    const s = EJSON.stringify(v, { relaxed: true });
    return s;
};

export interface CollProps {
    ctx: Ctx;
    cid: number;
    connName: string;
    db: string;
    coll: string;
    tab: string;
    ret: string;
    filter: string;
    sort: string;
    projection: string;
    limit: number;
    pg: number;
    docs: any[];
    total: number | null;
    error?: string;
    indexes: any[];
    stats: [string, string][];
    pipeline: string;
    aggOut?: string;
    topField: string;
    top: any[];
}

export function CollectionPage(p: CollProps) {
    const base = `/c/${p.cid}/d/${enc(p.db)}/${enc(p.coll)}`;
    const tabs = ["documents", "indexes", "aggregate", "stats"];
    const qs = (o: Record<string, string | number>) =>
        "?" +
        new URLSearchParams(
            Object.fromEntries(
                Object.entries({
                    tab: "documents",
                    filter: p.filter,
                    sort: p.sort,
                    projection: p.projection,
                    limit: p.limit,
                    page: p.pg,
                    ...o,
                }).map(([k, v]) => [k, String(v)]),
            ),
        ).toString();
    return (
        <>
            <Crumbs {...p} />
            <ul className="nav nav-tabs mb-3">
                {tabs.map((t) => (
                    <li className="nav-item">
                        <a
                            className={`nav-link ${p.tab === t ? "active" : ""}`}
                            href={`${base}?tab=${t}`}
                        >
                            {t[0].toUpperCase() + t.slice(1)}
                        </a>
                    </li>
                ))}
            </ul>
            {p.tab === "documents" && <DocsTab {...p} base={base} qs={qs} />}
            {p.tab === "indexes" && <IndexesTab {...p} base={base} />}
            {p.tab === "aggregate" && (
                <>
                    <Card title="Aggregation pipeline">
                        <form method="get" action={base}>
                            <input type="hidden" name="tab" value="aggregate" />
                            <Json name="pipeline" value={p.pipeline} rows={8} />
                            <button className="btn btn-primary mt-2">
                                Run (max 200 results)
                            </button>
                        </form>
                    </Card>
                    {p.aggOut !== undefined && (
                        <pre className="out">{p.aggOut}</pre>
                    )}
                </>
            )}
            {p.tab === "stats" && (
                <div className="row">
                    <div className="col-md-5">
                        <Card title="Collection stats">
                            <table className="table table-sm mb-0">
                                <tbody>
                                    {p.stats.map(([k, v]) => (
                                        <tr>
                                            <th>{k}</th>
                                            <td>{v}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </Card>
                    </div>
                    <div className="col-md-7">
                        <Card title="Top values of a field">
                            <form
                                method="get"
                                action={base}
                                className="d-flex gap-2 mb-3"
                            >
                                <input type="hidden" name="tab" value="stats" />
                                <input
                                    className="form-control"
                                    name="top"
                                    value={p.topField}
                                    placeholder="field.name"
                                />
                                <button className="btn btn-primary">
                                    Count
                                </button>
                            </form>
                            {p.error && (
                                <div className="text-danger">{p.error}</div>
                            )}
                            {!!p.top.length && (
                                <table className="table table-sm">
                                    <thead>
                                        <tr>
                                            <th>Value</th>
                                            <th className="text-end">Count</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {p.top.map((r) => (
                                            <tr>
                                                <td className="cell">
                                                    {show(r._id)}
                                                </td>
                                                <td className="text-end">
                                                    {r.count}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </Card>
                    </div>
                </div>
            )}
        </>
    );
}

function DocsTab(
    p: CollProps & {
        base: string;
        qs: (o: Record<string, string | number>) => string;
    },
) {
    const keys: string[] = ["_id"];
    for (const d of p.docs)
        for (const k of Object.keys(d))
            if (!keys.includes(k) && keys.length < 8) keys.push(k);
    const pages =
        p.total !== null ? Math.max(1, Math.ceil(p.total / p.limit)) : null;
    return (
        <>
            <Card title="Query">
                <form method="get" action={p.base}>
                    <input type="hidden" name="tab" value="documents" />
                    <div className="row">
                        <div className="col-md-6">
                            <label className="form-label small fw-semibold">
                                Filter
                            </label>
                            <Json name="filter" value={p.filter} rows={4} />
                        </div>
                        <div className="col-md-3">
                            <label className="form-label small fw-semibold">
                                Sort
                            </label>
                            <Json name="sort" value={p.sort} rows={4} />
                        </div>
                        <div className="col-md-3">
                            <label className="form-label small fw-semibold">
                                Projection
                            </label>
                            <Json
                                name="projection"
                                value={p.projection}
                                rows={4}
                            />
                        </div>
                    </div>
                    <div className="d-flex gap-2 align-items-center mt-2">
                        <button className="btn btn-primary">Run query</button>
                        <select className="form-select w-auto" name="limit">
                            {[10, 25, 50, 100].map((n) => (
                                <option
                                    value={String(n)}
                                    selected={n === p.limit}
                                >
                                    {n} / page
                                </option>
                            ))}
                        </select>
                        <span className="text-muted ms-2">
                            {p.total !== null
                                ? `${p.total} matching document(s)`
                                : ""}
                        </span>
                    </div>
                </form>
                <div className="small text-muted mt-2">
                    Extended JSON is supported, e.g.{" "}
                    {`{"_id": {"$oid": "..."}}`} or{" "}
                    {`{"created": {"$gte": {"$date": "2026-01-01T00:00:00Z"}}}`}
                    .
                </div>
            </Card>
            {p.error && <div className="alert alert-danger">{p.error}</div>}
            <div className="table-responsive bg-white shadow-sm mb-2">
                <table className="table table-sm table-hover mb-0">
                    <thead>
                        <tr>
                            {keys.map((k) => (
                                <th>{k}</th>
                            ))}
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {p.docs.map((d) => (
                            <tr>
                                {keys.map((k) => (
                                    <td className="cell" title={show(d[k])}>
                                        {show(d[k])}
                                    </td>
                                ))}
                                <td className="text-end text-nowrap">
                                    <a
                                        className="btn btn-sm btn-outline-primary py-0 me-1"
                                        href={`${p.base}/doc?id=${enc(EJSON.stringify(d._id))}`}
                                    >
                                        Edit
                                    </a>
                                    <Form
                                        ctx={p.ctx}
                                        action={`${p.base}/doc/delete`}
                                        ret={p.ret}
                                        cls="d-inline"
                                        confirm="Delete this document?"
                                    >
                                        <input
                                            type="hidden"
                                            name="id"
                                            value={EJSON.stringify(d._id)}
                                        />
                                        <button className="btn btn-sm btn-outline-danger py-0">
                                            Delete
                                        </button>
                                    </Form>
                                </td>
                            </tr>
                        ))}
                        {!p.docs.length && (
                            <tr>
                                <td
                                    colspan={keys.length + 1}
                                    className="text-muted p-3"
                                >
                                    No documents
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
            <div className="d-flex gap-2 align-items-center mb-4">
                {p.pg > 1 && (
                    <a
                        className="btn btn-sm btn-outline-secondary"
                        href={p.qs({ page: p.pg - 1 })}
                    >
                        Prev
                    </a>
                )}
                <span className="small">
                    Page {p.pg}
                    {pages ? ` of ${pages}` : ""}
                </span>
                {(pages ? p.pg < pages : p.docs.length === p.limit) && (
                    <a
                        className="btn btn-sm btn-outline-secondary"
                        href={p.qs({ page: p.pg + 1 })}
                    >
                        Next
                    </a>
                )}
            </div>

            <div className="row">
                <div className="col-md-4">
                    <Card title="Insert document(s)">
                        <Form
                            ctx={p.ctx}
                            action={`${p.base}/insert`}
                            ret={p.ret}
                        >
                            <Json name="docs" value={"{\n  \n}"} rows={8} />
                            <div className="small text-muted my-1">
                                An object, or an array of objects.
                            </div>
                            <button className="btn btn-success">Insert</button>
                        </Form>
                    </Card>
                </div>
                <div className="col-md-4">
                    <Card title="Update by query">
                        <Form
                            ctx={p.ctx}
                            action={`${p.base}/update`}
                            ret={p.ret}
                            confirm="Run this update?"
                        >
                            <label className="form-label small fw-semibold">
                                Filter
                            </label>
                            <Json name="filter" value={p.filter} rows={3} />
                            <label className="form-label small fw-semibold mt-2">
                                Update
                            </label>
                            <Json
                                name="update"
                                value={'{ "$set": {  } }'}
                                rows={4}
                            />
                            <div className="d-flex gap-2 mt-2">
                                <select
                                    className="form-select w-auto"
                                    name="mode"
                                >
                                    <option value="many">All matches</option>
                                    <option value="one">First match</option>
                                </select>
                                <button className="btn btn-warning">
                                    Update
                                </button>
                            </div>
                        </Form>
                    </Card>
                </div>
                <div className="col-md-4">
                    <Card title="Delete by query">
                        <Form
                            ctx={p.ctx}
                            action={`${p.base}/delete`}
                            ret={p.ret}
                        >
                            <label className="form-label small fw-semibold">
                                Filter
                            </label>
                            <Json name="filter" value={p.filter} rows={3} />
                            <div className="d-flex gap-2 mt-2">
                                <select
                                    className="form-select w-auto"
                                    name="mode"
                                >
                                    <option value="many">All matches</option>
                                    <option value="one">First match</option>
                                </select>
                                <input
                                    className="form-control"
                                    name="confirm"
                                    placeholder="type DELETE"
                                    autocomplete="off"
                                />
                                <button className="btn btn-danger">
                                    Delete
                                </button>
                            </div>
                        </Form>
                    </Card>
                </div>
            </div>
        </>
    );
}

function IndexesTab(p: CollProps & { base: string }) {
    return (
        <div className="row">
            <div className="col-md-8">
                <table className="table table-sm bg-white shadow-sm">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Keys</th>
                            <th>Options</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {p.indexes.map((i) => (
                            <tr>
                                <td>{i.name}</td>
                                <td className="font-monospace small">
                                    {JSON.stringify(i.key)}
                                </td>
                                <td className="small">
                                    {[
                                        i.unique && "unique",
                                        i.sparse && "sparse",
                                        i.expireAfterSeconds !== undefined &&
                                            `ttl ${i.expireAfterSeconds}s`,
                                    ]
                                        .filter(Boolean)
                                        .join(", ")}
                                </td>
                                <td className="text-end">
                                    {i.name !== "_id_" && (
                                        <Form
                                            ctx={p.ctx}
                                            action={`${p.base}/index/drop`}
                                            ret={p.ret}
                                            cls="d-inline"
                                            confirm={`Drop index ${i.name}?`}
                                        >
                                            <input
                                                type="hidden"
                                                name="name"
                                                value={i.name}
                                            />
                                            <button className="btn btn-sm btn-outline-danger py-0">
                                                Drop
                                            </button>
                                        </Form>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="col-md-4">
                <Card title="Create index">
                    <Form
                        ctx={p.ctx}
                        action={`${p.base}/index/create`}
                        ret={p.ret}
                    >
                        <Field label="Keys">
                            <Json
                                name="keys"
                                value={'{ "field": 1 }'}
                                rows={3}
                            />
                        </Field>
                        <div className="form-check mb-2">
                            <input
                                className="form-check-input"
                                type="checkbox"
                                name="unique"
                                id="uq"
                            />
                            <label className="form-check-label" htmlFor="uq">
                                Unique
                            </label>
                        </div>
                        <Field label="Name (optional)">
                            <input className="form-control" name="name" />
                        </Field>
                        <button className="btn btn-primary">Create</button>
                    </Form>
                </Card>
            </div>
        </div>
    );
}

export const DocEditPage = (p: {
    ctx: Ctx;
    cid: number;
    connName: string;
    db: string;
    coll: string;
    idJson: string;
    json: string;
    ret: string;
}) => {
    const base = `/c/${p.cid}/d/${enc(p.db)}/${enc(p.coll)}`;
    return (
        <>
            <Crumbs {...p} />
            <Card title={`Edit document ${p.idJson}`}>
                <Form ctx={p.ctx} action={`${base}/doc/save`} ret={p.ret}>
                    <input type="hidden" name="id" value={p.idJson} />
                    <Json name="doc" value={p.json} rows={24} />
                    <div className="small text-muted my-2">
                        Saving replaces the whole document. <code>_id</code>{" "}
                        cannot be changed.
                    </div>
                    <button className="btn btn-primary me-2">Save</button>
                    <a className="btn btn-link" href={p.ret}>
                        Cancel
                    </a>
                </Form>
            </Card>
        </>
    );
};

export const ErrorPage = (p: { code: number; message: string }) => (
    <div className="text-center mt-5">
        <h1>{p.code}</h1>
        <p className="text-muted">{p.message}</p>
        <a href="/">Home</a>
    </div>
);
