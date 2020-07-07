import { PRIV } from '../model/builtin';
import * as file from '../model/file';
import * as user from '../model/user';
import * as markdown from '../lib/markdown';
import * as db from '../service/db';
import { Route, Handler } from '../service/server';

const coll = db.collection('status');

class FileDownloadHandler extends Handler {
    async get({ docId, secret, name }) {
        if (name) name = Buffer.from(name, 'base64').toString();
        this.response.attachment(name || docId);
        this.response.body = await file.getWithSecret(docId, secret);
    }
}

class StatusHandler extends Handler {
    async get() {
        const stats = await coll.find().sort({ type: 1, updateAt: -1 }).toArray();
        for (const i in stats) {
            let desc = '';
            const online = new Date(stats[i].updateAt).getTime() > new Date().getTime() - 300000;
            if (!online) desc = 'Offline';
            desc = desc || 'Online';
            stats[i].isOnline = online;
            stats[i].status = desc;
        }
        const path = [
            ['Hydro', 'homepage'],
            ['status', null],
        ];
        this.response.body = { stats, path };
        this.response.template = 'status.html';
    }
}

class StatusUpdateHandler extends Handler {
    async post(args) {
        this.checkPerm(PRIV.PRIV_JUDGE);
        args.type = 'judger';
        return coll.updateOne(
            { mid: args.mid, type: 'judger' },
            { $set: args },
            { upsert: true },
        );
    }
}

class SwitchLanguageHandler extends Handler {
    async get({ lang }) {
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            await user.setById(this.user._id, { viewLang: lang });
        } else this.session.viewLang = lang;
        this.back();
    }
}

class MarkdownHandler extends Handler {
    async post({ text, safe = true }) {
        this.response.body = safe
            ? markdown.safe.render(text)
            : markdown.unsafe.render(text);
    }
}

class SockToken extends Handler {
    async get() {
        this.response.body = { token: this.csrfToken };
    }
}

export async function apply() {
    Route('file_download', '/fs/:docId/:secret', FileDownloadHandler);
    Route('file_download_with_name', '/fs/:docId/:name/:secret', FileDownloadHandler);
    Route('status', '/status', StatusHandler);
    Route('status_update', '/status/update', StatusUpdateHandler);
    Route('switch_language', '/language/:lang', SwitchLanguageHandler);
    Route('markdown', '/markdown', MarkdownHandler);
    Route('token', '/token', SockToken);
}

apply.updateStatus = function updateStatus(args) {
    args.type = 'judger';
    return coll.updateOne(
        { mid: args.mid, type: 'judger' },
        { $set: args },
        { upsert: true },
    );
};

global.Hydro.handler.misc = apply;