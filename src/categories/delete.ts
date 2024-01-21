import async from 'async';
import db from '../database';
import batch from '../batch';
import plugins from '../plugins';
import topics from '../topics';
import groups from '../groups';
import privileges from '../privileges';
import cache from '../cache';

// Functions exported: purge,
module.exports = function (Categories : any) {
    Categories.purge = async function (cid : number, uid : number) {
        await batch.processSortedSet(`cid:${cid}:tids`, async (tids : Array<number>) => {
            await async.eachLimit(tids, 10, async (tid : number) => {
                await topics.purgePostsAndTopic(tid, uid);
            });
        }, { alwaysStartAt: 0 });
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const pinnedTids : Array<number> = await db.getSortedSetRevRange(`cid:${cid}:tids:pinned`, 0, -1);
        await async.eachLimit(pinnedTids, 10, async (tid) => {
            await topics.purgePostsAndTopic(tid, uid);
        });
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const categoryData : any = await Categories.getCategoryData(cid);
        await purgeCategory(cid, categoryData);
        plugins.hooks.fire('action:category.delete', { cid: cid, uid: uid, category: categoryData });
    };

    async function purgeCategory(cid : number, categoryData : any) {
        const bulkRemove : Array<object> = [['categories:cid', cid]];
        if (categoryData && categoryData.name) {
            bulkRemove.push(['categories:name', `${categoryData.name.slice(0, 200).toLowerCase()}:${cid}`]);
        }
        await db.sortedSetRemoveBulk(bulkRemove);

        await removeFromParent(cid);
        await deleteTags(cid);
        await db.deleteAll([
            `cid:${cid}:tids`,
            `cid:${cid}:tids:pinned`,
            `cid:${cid}:tids:posts`,
            `cid:${cid}:tids:votes`,
            `cid:${cid}:tids:views`,
            `cid:${cid}:tids:lastposttime`,
            `cid:${cid}:recent_tids`,
            `cid:${cid}:pids`,
            `cid:${cid}:read_by_uid`,
            `cid:${cid}:uid:watch:state`,
            `cid:${cid}:children`,
            `cid:${cid}:tag:whitelist`,
            `category:${cid}`,
        ]);
        const privilegeList : Array<string> = await privileges.categories.getPrivilegeList();
        await groups.destroy(privilegeList.map(privilege => `cid:${cid}:privileges:${privilege}`));
    }

    async function removeFromParent(cid : number) {
        const [parentCid, children] = await Promise.all([
            Categories.getCategoryField(cid, 'parentCid'),
            db.getSortedSetRange(`cid:${cid}:children`, 0, -1),
        ]);

        const bulkAdd : Array<Array<string>> = [];
        const childrenKeys = children.map((cid) => {
            bulkAdd.push(['cid:0:children', cid, cid]);
            return `category:${cid}`;
        });

        await Promise.all([
            db.sortedSetRemove(`cid:${parentCid}:children`, cid),
            db.setObjectField(childrenKeys, 'parentCid', 0),
            db.sortedSetAddBulk(bulkAdd),
        ]);

        cache.del([
            'categories:cid',
            'cid:0:children',
            `cid:${parentCid}:children`,
            `cid:${parentCid}:children:all`,
            `cid:${cid}:children`,
            `cid:${cid}:children:all`,
            `cid:${cid}:tag:whitelist`,
        ]);
    }

    async function deleteTags(cid : number): Promise<void> {
        const tags : string[] = await db.getSortedSetMembers(`cid:${cid}:tags`);
        await db.deleteAll(tags.map(tag => `cid:${cid}:tag:${tag}:topics`));
        await db.delete(`cid:${cid}:tags`);
    }
};
