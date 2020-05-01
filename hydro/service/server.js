const path = require('path');
const { ObjectID } = require('bson');
const Koa = require('koa');
const morgan = require('koa-morgan');
const Body = require('koa-body');
const Router = require('koa-router');
const cache = require('koa-static-cache');
const sockjs = require('sockjs');
const http = require('http');
const https = require('https');
const options = require('../options');
const validator = require('../lib/validator');
const template = require('../lib/template');
const user = require('../model/user');
const blacklist = require('../model/blacklist');
const token = require('../model/token');
const opcount = require('../model/opcount');
const {
    UserNotFoundError, BlacklistedError, PermissionError,
    UserFacingError, ValidationError,
} = require('../error');

const app = new Koa();
const server = (options.listen.https ? https : http).createServer(app.callback());
app.keys = options.session.keys;
app.use(cache(path.join(process.cwd(), '.uibuild'), {
    maxAge: 365 * 24 * 60 * 60,
}));
app.use(Body({
    multipart: true,
    formidable: {
        maxFileSize: 256 * 1024 * 1024,
    },
}));
const router = new Router();

class Handler {
    /**
     * @param {import('koa').Context} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.request = {
            ip: ctx.request.ip,
            headers: ctx.request.headers,
            cookies: ctx.cookies,
            body: ctx.request.body,
            files: ctx.request.files,
            query: ctx.query,
            path: ctx.path,
        };
        this.response = {
            body: '',
            type: '',
            status: null,
            template: null,
            redirect: null,
            attachment: (name) => ctx.attachment(name),
        };
        this.UIContext = {
            cdn_prefix: '/',
            url_prefix: '/',
        };
        this._handler = {};
        this.session = {};
    }

    renderHTML(name, context) {
        console.time(name);
        this.hasPerm = (perm) => this.user.hasPerm(perm);
        return new Promise((resolve, reject) => {
            template.render(name, Object.assign(context, {
                handler: this,
                _: (str) => (str ? str.toString().translate(this.user.language) : ''),
                user: this.user,
            }), (error, res) => {
                console.timeEnd(name);
                if (error) reject(error);
                else resolve(res);
            });
        });
    }

    async render(name, context) {
        this.response.body = await this.renderHTML(name, context);
        this.response.type = 'text/html';
    }

    renderTitle(str) { // eslint-disable-line class-methods-use-this
        return str;
    }

    checkPerm(...args) {
        for (const i in args) {
            if (args[i] instanceof Array) {
                let p = false;
                for (const j in args) {
                    if (this.user.hasPerm(args[i][j])) {
                        p = true;
                        break;
                    }
                }
                if (!p) throw new PermissionError([args[i]]);
            } else if (!this.user.hasPerm(args[i])) {
                throw new PermissionError([[args[i]]]);
            }
        }
    }

    async limitRate(op, periodSecs, maxOperations) {
        await opcount.inc(op, this.request.ip, periodSecs, maxOperations);
    }

    back(body) {
        if (body) this.response.body = body;
        this.response.redirect = this.request.headers.referer || '/';
    }

    translate(str) {
        return str ? str.toString().translate(this.user.language) : '';
    }

    binary(data, name) {
        this.response.body = data;
        this.response.template = null;
        this.response.type = 'application/octet-stream';
        this.response.disposition = `attachment; filename="${name}"`;
    }

    async ___prepare() {
        this.response.body = {};
        this.now = new Date();
        this._handler.sid = this.request.cookies.get('sid');
        this._handler.save = this.request.cookies.get('save');
        this._handler.tokenType = token.TYPE_SESSION;
        if (this._handler.save) this._handler.expireSeconds = options.session.saved_expire_seconds;
        else this._handler.expireSeconds = options.session.unsaved_expire_seconds;
        this.session = this._handler.sid
            ? await token.update(
                this._handler.sid,
                this._handler.tokenType,
                this._handler.expireSeconds,
                {
                    update_ip: this.request.ip,
                    update_ua: this.request.headers['user-agent'] || '',
                },
            ) : { uid: 1 };
        if (!this.session) this.session = { uid: 1 };
        const bdoc = await blacklist.get(this.request.ip);
        if (bdoc) throw new BlacklistedError(this.request.ip);
        this.user = await user.getById(this.session.uid);
        if (!this.user) throw new UserNotFoundError(this.session.uid);
        [this.csrfToken] = await token.add(token.TYPE_CSRF_TOKEN, 600, { path: this.request.path });
        this.preferJson = (this.request.headers.accept || '').includes('application/json');
    }

    async ___cleanup() {
        try {
            await this.renderBody();
        } catch (error) {
            if (this.preferJson) this.response.body = { error };
            else await this.render(error instanceof UserFacingError ? 'error.html' : 'bsod.html', { error });
        }
        await this.putResponse();
        await this.saveCookie();
    }

    async renderBody() {
        if (!this.response.redirect && !this.preferJson) {
            if (this.response.body || this.response.template) {
                if (this.request.query.noTemplate || this.preferJson) return;
                const templateName = this.request.query.template || this.response.template;
                if (templateName) {
                    this.response.body = this.response.body || {};
                    await this.render(templateName, this.response.body);
                }
            }
        }
    }

    async putResponse() {
        if (this.response.disposition) this.ctx.set('Content-Disposition', this.response.disposition);
        if (this.response.redirect && !this.preferJson) {
            this.ctx.response.type = 'application/octet-stream';
            this.ctx.response.status = 302;
            this.ctx.redirect(this.response.redirect);
        } else {
            if (this.response.body != null) {
                this.ctx.response.body = this.response.body;
                this.ctx.response.status = this.response.status || 200;
            }
            this.ctx.response.type = this.preferJson
                ? 'application/json'
                : this.response.type
                    ? this.response.type
                    : this.ctx.response.type;
        }
    }

    async saveCookie() {
        if (this.session.sid) {
            await token.update(
                this.session.sid,
                this._handler.tokenType,
                this._handler.expireSeconds,
                {
                    updateIp: this.request.ip,
                    updateUa: this.request.headers['user-agent'] || '',
                },
            );
        } else {
            [this.session.sid] = await token.add(
                this._handler.tokenType,
                this._handler.expireSeconds,
                {
                    createIp: this.request.ip,
                    createUa: this.request.headers['user-agent'] || '',
                    updateIp: this.request.ip,
                    updateUa: this.request.headers['user-agent'] || '',
                    ...this.session,
                },
            );
        }
        const cookie = { secure: options.session.secure };
        if (this._handler.save) {
            cookie.expires = this.session.expireAt;
            cookie.maxAge = this._handler.expireSeconds;
            this.request.cookies.set('save', 'true', cookie);
        }
        this.ctx.cookies.set('sid', this.session.sid, cookie);
    }

    async onerror(error) {
        console.error(error.message, error.params);
        console.error(error.stack);
        this.response.template = error instanceof UserFacingError ? 'error.html' : 'bsod.html';
        this.response.body = {
            error: { message: error.message, params: error.params, stack: error.stack },
        };
        await this.___cleanup().catch(() => { });
    }
}

const check = ['tid', 'rid', 'did', 'drid', 'drrid', 'psid', 'psrid', 'docId'];

function Route(route, RouteHandler) {
    router.all(route, async (ctx) => {
        const h = new RouteHandler(ctx);
        try {
            const method = ctx.method.toLowerCase();
            const args = { ...ctx.params, ...ctx.query, ...ctx.request.body };

            if (h.___prepare) await h.___prepare(args);

            for (const l of check) {
                if (args[l]) {
                    args[l] = new ObjectID(args[l]);
                    if (!args[l]) throw new ValidationError(l);
                }
            }
            if (args.content) validator.checkContent(args.content);
            if (args.title) validator.checkContent(args.title);
            if (args.uid) args.uid = parseInt(validator.checkUid(args.uid));
            if (args.password) validator.checkPassword(args.password);
            if (args.mail) validator.checkEmail(args.mail);
            if (args.uname) validator.checkUname(args.uname);
            if (args.page) args.page = parseInt(args.page);
            if (args.duration) args.duration = parseFloat(args.duration);
            if (args.pids) args.pids = args.pids.split(',').map((i) => i.trim());
            if (args.role) validator.checkRole(args.role);
            if (args.roles) {
                for (const i of args.roles) validator.checkRole(i);
            }

            if (h.__prepare) await h.__prepare(args);
            if (h._prepare) await h._prepare(args);
            if (h.prepare) await h.prepare(args);

            if (h[`___${method}`]) await h[`___${method}`](args);
            if (h[`__${method}`]) await h[`__${method}`](args);
            if (h[`_${method}`]) await h[`_${method}`](args);
            if (h[method]) await h[method](args);

            if (method === 'post' && ctx.request.body.operation) {
                const operation = `_${ctx.request.body.operation}`
                    .replace(/_([a-z])/gm, (s) => s[1].toUpperCase());
                if (h[`${method}${operation}`]) await h[`${method}${operation}`](args);
            }

            if (h.cleanup) await h.cleanup(args);
            if (h._cleanup) await h._cleanup(args);
            if (h.__cleanup) await h.__cleanup(args);
            if (h.___cleanup) await h.___cleanup(args);
        } catch (e) {
            if (h.onerror) await h.onerror(e);
        }
    });
}

class ConnectionHandler {
    /**
     * @param {import('sockjs').Connection} conn
     */
    constructor(conn) {
        const that = this;
        this.conn = conn;
        this.request = {
            cookies: {
                get(name) {
                    return that.request.cookies[name];
                },
                set() { },
            },
            params: {},
            headers: conn.headers,
        };
        this._handler = {};
        const p = (conn.url.split('?')[1] || '').split('&');
        for (const i in p) p[i] = p[i].split('=');
        for (const i in p) this.request.params[p[i][0]] = decodeURIComponent(p[i][1]);
    }

    renderHTML(name, context) {
        console.time(name);
        this.hasPerm = (perm) => this.user.hasPerm(perm);
        return new Promise((resolve, reject) => {
            template.render(name, Object.assign(context, {
                handler: this,
                _: (str) => (str ? str.toString().translate(this.user.language) : ''),
                user: this.user,
            }), (error, res) => {
                console.timeEnd(name);
                if (error) reject(error);
                else resolve(res);
            });
        });
    }

    send(data) {
        this.conn.write(JSON.stringify(data));
    }

    close(code, reason) {
        this.conn.close(code, reason);
    }

    async ___prepare() {
        await new Promise((resolve, reject) => {
            this.conn.once('data', (msg) => {
                for (const i of msg.split(';')) {
                    const [k, v] = i.trim().split('=');
                    this.request.cookies[k] = v;
                }
                resolve();
            });
            setTimeout(reject, 5000);
        });
        this._handler.sid = this.request.cookies.get('sid');
        this.session = this._handler.sid
            ? await token.get(this._handler.sid, token.TYPE_SESSION)
            : { uid: 1 };
        if (!this.session) this.session = { uid: 1 };
        const bdoc = await blacklist.get(this.request.ip);
        if (bdoc) throw new BlacklistedError(this.request.ip);
        this.user = await user.getById(this.session.uid);
        if (!this.user) throw new UserNotFoundError(this.session.uid);
    }
}
function Connection(prefix, RouteConnHandler) {
    const sock = sockjs.createServer({ prefix });
    sock.on('connection', async (conn) => {
        const h = new RouteConnHandler(conn);
        try {
            const args = { ...h.request.params };

            if (args.uid) args.uid = parseInt(validator.checkUid(args.uid));
            if (args.page) args.page = parseInt(args.page);
            if (args.rid) args.rid = new ObjectID(args.rid);
            if (args.tid) args.tid = new ObjectID(args.tid);

            if (h.___prepare) await h.___prepare(args);
            if (h.__prepare) await h.__prepare(args);
            if (h._prepare) await h._prepare(args);
            if (h.prepare) await h.prepare(args);
            if (h.message) {
                conn.on('data', (data) => {
                    h.message(JSON.parse(data));
                });
            }
            conn.on('close', async () => {
                if (h.cleanup) await h.cleanup(args);
                if (h._cleanup) await h._cleanup(args);
                if (h.__cleanup) await h.__cleanup(args);
                if (h.___cleanup) await h.___cleanup(args);
            });
        } catch (e) {
            console.log(e);
            if (h.onerror) await h.onerror(e);
        }
    });
    sock.installHandlers(server);
}

exports.Handler = Handler;
exports.ConnectionHandler = ConnectionHandler;
exports.Route = Route;
exports.Connection = Connection;
exports.start = function start() {
    app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));
    app.use(router.routes()).use(router.allowedMethods());
    Route('*', Handler);
    server.listen(options.listen.port);
    console.log('Server listening at: %s', options.listen.port);
};
