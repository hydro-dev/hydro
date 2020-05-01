const {
    VerifyPasswordError, UserAlreadyExistError, InvalidTokenError,
    NotFoundError, MessageNotFoundError,
} = require('../error');
const options = require('../options');
const bus = require('../service/bus');
const { Route, Handler } = require('../service/server');
const md5 = require('../lib/md5');
const contest = require('../model/contest');
const user = require('../model/user');
const setting = require('../model/setting');
const discussion = require('../model/discussion');
const token = require('../model/token');
const training = require('../model/training');
const {
    PERM_VIEW_TRAINING, PERM_VIEW_CONTEST, PERM_VIEW_DISCUSSION,
    PERM_LOGGEDIN,
} = require('../permission');
const { CONTESTS_ON_MAIN, TRAININGS_ON_MAIN, DISCUSSIONS_ON_MAIN } = require('../options').constants;

class HomeHandler extends Handler {
    async contest() {
        if (this.user.hasPerm(PERM_VIEW_CONTEST)) {
            const tdocs = await contest.getMulti()
                .limit(CONTESTS_ON_MAIN)
                .toArray();
            const tsdict = await contest.getListStatus(
                this.user._id, tdocs.map((tdoc) => tdoc._id),
            );
            return [tdocs, tsdict];
        }
        return [[], {}];
    }

    async training() {
        if (this.user.hasPerm(PERM_VIEW_TRAINING)) {
            const tdocs = await training.getMulti()
                .sort('_id', 1)
                .limit(TRAININGS_ON_MAIN)
                .toArray();
            const tsdict = await training.getListStatus(
                this.user._id, tdocs.map((tdoc) => tdoc._id),
            );
            return [tdocs, tsdict];
        }
        return [[], {}];
    }

    async discussion() {
        if (this.user.hasPerm(PERM_VIEW_DISCUSSION)) {
            const ddocs = await discussion.getMulti()
                .limit(DISCUSSIONS_ON_MAIN)
                .toArray();
            const vndict = await discussion.getListVnodes(ddocs, this);
            return [ddocs, vndict];
        }
        return [[], {}];
    }

    async get() {
        const [[tdocs, tsdict], [trdocs, trsdict], [ddocs, vndict]] = await Promise.all([
            this.contest(), this.training(), this.discussion(),
        ]);
        const udict = await user.getList(ddocs.map((ddoc) => ddoc.owner));
        this.response.template = 'main.html';
        this.response.body = {
            tdocs, tsdict, trdocs, trsdict, ddocs, vndict, udict,
        };
    }
}

class HomeSecurityHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM_LOGGEDIN);
    }

    async get() {
        // TODO(iceboy): pagination? or limit session count for uid?
        const sessions = await token.getSessionListByUid(this.user._id);
        const parsed = sessions.map((session) => ({
            ...session,
            updateUa: useragent.parse(session.updateUa || session.createUa || ''),
            updateGeoip: geoip.ip2geo(session.updateIp || session.createIp, this.user.viewLang),
            _id: md5(session._id),
            isCurrent: session._id === this.session._id,
        }));
        this.response.template = 'home_security.html';
        this.response.body = { sessions: parsed };
    }

    async postChangePassword({ current, password, verifyPassword }) {
        if (password !== verifyPassword) throw new VerifyPasswordError();
        await user.changePassword(this.user._id, current, password);
        this.back();
    }

    async postChangeMail({ currentPassword, mail }) {
        this.limitRate('send_mail', 3600, 30);
        this.user.checkPassword(currentPassword);
        const udoc = await user.getByMail(mail);
        if (udoc) throw new UserAlreadyExistError(mail);
        const [rid] = await token.add(
            token.TYPE_CHANGEMAIL,
            options.changemail_token_expire_seconds,
            { uid: this.udoc._id, mail },
        );
        await mail.sendMail(mail, 'Change Email', 'user_changemail_mail.html', {
            url: `/changeMail/${rid}`, uname: this.udoc.uname,
        });
        this.response.template = 'user_changemail_mail_sent.html';
    }

    async postDeleteToken({ tokenDigest }) {
        const sessions = await token.getSessionListByUid(this.user._id);
        for (const session in sessions) {
            if (tokenDigest === md5(session._id)) {
                await token.delete(session._id, token.TYPE_SESSION);
                return this.back();
            }
        }
        throw new InvalidTokenError(tokenDigest);
    }

    async postDeleteAllTokens() {
        await token.deleteByUid(this.user._id);
        this.back();
    }
}

class HomeSettingsHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM_LOGGEDIN);
    }

    async get({ category }) {
        this.response.template = 'home_settings.html';
        if (category === 'preference') {
            this.response.body = {
                category,
                page_name: `home_${category}`,
                settings: setting.PREFERENCE_SETTINGS,
            };
        } else if (category === 'account') {
            this.response.body = {
                category,
                page_name: `home_${category}`,
                settings: setting.ACCOUNT_SETTINGS,
            };
        } else throw new NotFoundError();
    }

    async post(args) {
        // FIXME validation
        await user.setById(this.user._id, args);
        this.back();
    }
}

class UserChangemailWithCodeHandler extends Handler {
    async get({ code }) {
        const tdoc = await token.get(code, token.TYPE_CHANGEMAIL);
        if (!tdoc || tdoc.uid !== this.user._id) {
            throw new InvalidTokenError(code);
        }
        const udoc = await user.getByEmail(tdoc.mail);
        if (udoc) throw new UserAlreadyExistError(tdoc.mail);
        // TODO(twd2): Ensure mail is unique.
        await user.setEmail(this.user._id, tdoc.mail);
        await token.delete(code, token.TYPE_CHANGEMAIL);
        this.response.redirect = '/home/security';
    }
}

class HomeMessagesHandler extends Handler {
    udoc(udict, key) { // eslint-disable-line class-methods-use-this
        const udoc = udict[key];
        if (!udoc) return;
        const gravatar_url = misc.gravatar_url(udoc.gravatar);
        if (udoc.gravatar) udict[key] = { ...udoc, gravatar_url, gravatar: '' };
    }

    async prepare() {
        this.checkPerm(PERM_LOGGEDIN);
    }

    async get() {
        // TODO(iceboy): projection, pagination.
        const mdocs = await message.getMulti(this.user._id).sort('_id', -1).limit(50).toArray();
        const udict = await user.getList([
            ...mdocs.map((mdoc) => mdoc.from),
            ...mdocs.map((mdoc) => mdoc.to),
        ]);
        // TODO(twd2): improve here:
        for (const mdoc of mdocs) {
            this.modify_udoc(udict, mdoc.from);
            this.modify_udoc(udict, mdoc.to);
        }
        this.response.body = { messages: mdocs, udict };
        this.response.template = 'home_message.html';
    }

    async postSendMessage({ uid, content }) {
        const udoc = await user.getById(uid);
        const mdoc = await message.add(this.user._id, udoc._id, content);
        // TODO(twd2): improve here:
        // projection
        mdoc.from = this.user;
        this.modify_udoc(mdoc, 'from');
        mdoc.to = udoc;
        this.modify_udoc(mdoc, 'to');
        if (this.user._id !== uid) {
            await bus.publish(`user_message-${uid}`, { type: 'new', data: mdoc });
        }
        this.back({ mdoc });
    }

    async postReplyMessage({ message_id, content }) {
        const [mdoc, reply] = await message.addReply(message_id, this.user._id, content);
        if (!mdoc) throw new MessageNotFoundError(message_id);
        if (mdoc.from !== mdoc.to) {
            const other = mdoc.from === this.user._id ? mdoc.from : mdoc.to;
            await bus.publish(`user_message-${other}`, { type: 'reply', data: mdoc });
        }
        mdoc.reply = [reply];
        this.back({ reply });
    }

    async postDeleteMessage({ message_id }) {
        await message.delete(message_id, this.user._id);
        this.back();
    }
}

async function apply() {
    Route('/', module.exports.HomeHandler);
    Route('/home/security', module.exports.HomeSecurityHandler);
    Route('/home/changeMail/:code', module.exports.UserChangemailWithCodeHandler);
    Route('/home/settings/:category', module.exports.HomeSettingsHandler);
}

global.Hydro.handler.home = module.exports = {
    HomeHandler, HomeSecurityHandler, HomeSettingsHandler, UserChangemailWithCodeHandler, apply,
};

/*
@app.connection_route('/home/messages-conn', 'home_messages-conn', global_route=True)
class HomeMessagesConnection(base.Connection):
  @base.require_priv(builtin.PRIV_USER_PROFILE)
  async def on_open(this):
    await super(HomeMessagesConnection, this).on_open()
    bus.subscribe(this.on_message_received, ['message_received-' + str(this.user['_id'])])

  async def on_message_received(this, e):
    this.send(**e['value'])

  async def on_close(this):
    bus.unsubscribe(this.on_message_received)


@app.route('/home/file', 'home_file', global_route=True)
class HomeFileHandler(base.OperationHandler):
  def file_url(this, fdoc):
    return options.cdn_prefix.rstrip('/') + \
      this.reverse_url('fs_get', domain_id=builtin.DOMAIN_ID_SYSTEM,
                       secret=fdoc['metadata']['secret'])

  @base.require_priv(builtin.PRIV_USER_PROFILE)
  async def get(this):
    ufdocs = await userfile.get_multi(owner_uid=this.user['_id']).to_list()
    fdict = await fs.get_meta_dict(ufdoc.get('file_id') for ufdoc in ufdocs)
    this.render('home_file.html', ufdocs=ufdocs, fdict=fdict)

  @base.require_priv(builtin.PRIV_USER_PROFILE)
  @base.post_argument
  @base.require_csrf_token
  @base.sanitize
  async def post_delete(this, *, ufid: document.convert_doc_id):
    ufdoc = await userfile.get(ufid)
    if not this.own(ufdoc, priv=builtin.PRIV_DELETE_FILE_this):
      this.check_priv(builtin.PRIV_DELETE_FILE)
    result = await userfile.delete(ufdoc['doc_id'])
    if result:
      await userfile.dec_usage(this.user['_id'], ufdoc['length'])
    this.redirect(this.referer_or_main)
*/
