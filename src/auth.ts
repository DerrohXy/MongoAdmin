import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { getSession, getUser, type User } from "./db";

declare global {
    namespace Express {
        interface Request {
            user?: User;
            csrf?: string;
            sid?: string;
        }
    }
}

export function readCookie(req: Request, name: string) {
    for (const part of (req.headers.cookie ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0 && part.slice(0, i).trim() === name)
            return decodeURIComponent(part.slice(i + 1).trim());
    }
}

export function loadSession(req: Request, _res: Response, next: NextFunction) {
    const tok = readCookie(req, "sid");
    const s = tok && getSession(tok);
    if (s) {
        const u = getUser(s.user_id);
        if (u) {
            req.user = u;
            req.csrf = s.csrf;
            req.sid = tok;
        }
    }
    next();
}

export function csrfCheck(req: Request, res: Response, next: NextFunction) {
    if (req.method !== "POST" || req.path === "/login") return next();
    const t = String(req.body?._csrf ?? "");
    const ok =
        req.csrf &&
        t.length === req.csrf.length &&
        crypto.timingSafeEqual(Buffer.from(t), Buffer.from(req.csrf));
    if (!ok)
        return void res
            .status(403)
            .send(
                "Invalid or missing CSRF token. Go back, reload the page and try again.",
            );
    next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!req.user) return void res.redirect("/login");
    next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (!req.user) return void res.redirect("/login");
    if (!req.user.is_admin) return void res.status(403).send("Admins only");
    next();
}

// tiny in-memory login throttle: 10 failures / 15 min per IP
const fails = new Map<string, { n: number; reset: number }>();

export const loginBlocked = (ip: string) => {
    const f = fails.get(ip);
    return !!f && f.reset > Date.now() && f.n >= 10;
};

export function loginFailed(ip: string) {
    const f = fails.get(ip);
    if (!f || f.reset < Date.now())
        fails.set(ip, { n: 1, reset: Date.now() + 15 * 60_000 });
    else f.n++;
}

export const loginOk = (ip: string) => void fails.delete(ip);
