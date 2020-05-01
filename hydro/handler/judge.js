const { PERM_JUDGE } = require('../permission');
const record = require('../model/record');
const problem = require('../model/problem');
const builtin = require('../model/builtin');
const contest = require('../model/contest');
const user = require('../model/user');
const bus = require('../service/bus');
const queue = require('../service/queue');
const {
    Route, Handler, Connection, ConnectionHandler,
} = require('../service/server');

queue.assert('judge');

async function _postJudge(rdoc) {
    const accept = rdoc.status === builtin.STATUS_ACCEPTED;
    bus.publish('record_change', rdoc);
    const tasks = [];
    if (rdoc.tid) {
        tasks.push(
            contest.updateStatus(rdoc.tid, rdoc.uid, rdoc._id, rdoc.pid, accept, rdoc.score),
        );
    }
    if (!rdoc.rejudged) {
        if (await problem.updateStatus(rdoc.pid, rdoc.uid, rdoc._id, rdoc.status)) {
            if (accept) {
                tasks.push(
                    problem.inc(rdoc.pid, 'nAccept', 1),
                    user.inc(rdoc.uid, 'nAccept', 1),
                );
            }
        }
    }
    await Promise.all(tasks);
}

async function next(body) {
    let rdoc = await record.get(body.rid);
    const $set = {};
    const $push = {};
    if (body.case) {
        rdoc.testCases.push(body.case);
        $push.testCases = body.case;
    }
    if (body.judge_text) {
        rdoc.judgeTexts.push(body.judge_text);
        $push.judgeTexts = body.judge_text;
    }
    if (body.compiler_text) {
        rdoc.compilerTexts.push(body.compiler_text);
        $push.compilerTexts = body.compiler_text;
    }
    if (body.status) $set.status = body.status;
    if (body.score) $set.score = body.score;
    if (body.time_ms) $set.time = body.time_ms;
    if (body.memory_kb) $set.memory = body.memory_kb;
    rdoc = await record.update(body.rid, $set, $push);
    bus.publish('record_change', rdoc);
}
async function end(body) {
    let rdoc = await record.get(body.rid);
    const $set = {};
    const $push = {};
    if (body.case) {
        rdoc.testCases.push(body.case);
        $push.testCases = body.case;
    }
    if (body.judge_text) {
        rdoc.judgeTexts.push(body.judge_text);
        $push.judgeTexts = body.judge_text;
    }
    if (body.compiler_text) {
        rdoc.compilerTexts.push(body.compiler_text);
        $push.compilerTexts = body.compiler_text;
    }
    if (body.status) $set.status = body.status;
    if (body.score) $set.score = body.score;
    if (body.time_ms) $set.time = body.time_ms;
    if (body.memory_kb) $set.memory = body.memory_kb;
    $set.judgeAt = new Date();
    $set.judger = body.judger;
    rdoc = await record.update(body.rid, $set, $push);
    await _postJudge(rdoc);
    rdoc = await record.update(body.rid, $set, $push);
}

class JudgeHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM_JUDGE);
    }

    async get({ check = false }) {
        if (check) return;
        const tasks = [];
        let rid = await queue.get('judge', false);
        while (rid) {
            const rdoc = await record.get(rid); // eslint-disable-line no-await-in-loop
            let task;
            if (!rdoc.input) {
                // eslint-disable-next-line no-await-in-loop
                const pdoc = await problem.getById(rdoc.pid);
                task = {
                    event: 'judge',
                    rid,
                    type: 0,
                    pid: rdoc.pid,
                    data: pdoc.data,
                    lang: rdoc.lang,
                    code: rdoc.code,
                };
            } else {
                task = {
                    event: 'pretest',
                    rid,
                    type: 0,
                    input: rdoc.input,
                    lang: rdoc.lang,
                    code: rdoc.code,
                };
            }
            tasks.push(task);
            rid = await queue.get('judge', false); // eslint-disable-line no-await-in-loop
        }
        this.response.body = { tasks };
    }

    async postNext() {
        await next(this.request.body);
    }

    async postEnd() {
        this.request.body.judger = this.user._id;
        await end(this.request.body);
    }
}
class JudgeConnectionHandler extends ConnectionHandler {
    async prepare() {
        this.checkPerm(PERM_JUDGE);
    }

    async message(msg) {
        if (msg.key === 'next') await next(msg);
        else if (msg.key === 'end') {
            await end({ judger: this.user._id, ...msg });
            this.processing = null;
            const rid = await queue.get('judge');
            const rdoc = await record.get(rid);
            let task;
            if (!rdoc.input) {
                // eslint-disable-next-line no-await-in-loop
                const pdoc = await problem.getById(rdoc.pid);
                task = {
                    event: 'judge',
                    rid,
                    type: 0,
                    pid: rdoc.pid,
                    data: pdoc.data,
                    lang: rdoc.lang,
                    code: rdoc.code,
                };
            } else {
                task = {
                    event: 'pretest',
                    rid,
                    type: 0,
                    input: rdoc.input,
                    lang: rdoc.lang,
                    code: rdoc.code,
                };
            }
            this.send({ task });
            this.processing = task.rid;
        }
    }

    async cleanup() {
        if (this.processing) {
            await record.reset(this.processing);
            queue.push('judge', this.processing);
        }
    }
}

async function apply() {
    Route('/judge', module.exports.JudgeHandler);
    Connection('/judge/conn', module.exports.JudgeConnectionHandler);
}

global.Hydro.handler.judge = module.exports = {
    JudgeHandler, JudgeConnectionHandler, apply,
};
