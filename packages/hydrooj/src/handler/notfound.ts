/* eslint-disable no-empty-function */
/* eslint-disable class-methods-use-this */
import { NotFoundError } from '../error';
import {
    Route, Handler, param, Types,
} from '../service/server';

class NotFoundHandler extends Handler {
    @param('bsod', Types.Boolean)
    prepare(domainId: string, bsod: boolean) {
        if (bsod) throw new Error(this.request.path);
        throw new NotFoundError(this.request.path);
    }

    all() { }
}

export async function apply() {
    Route('notfound', '(/.*)+', NotFoundHandler);
}

global.Hydro.handler.notfound = apply;
