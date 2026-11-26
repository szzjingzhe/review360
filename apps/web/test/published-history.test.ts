import {afterEach,expect,it,vi} from 'vitest';
import {publishedHistory} from '../src/lib/publishedHistory';
import {realApi} from '../src/api/real';
afterEach(()=>vi.unstubAllGlobals());
it('old drafts/cancelled/reviewing periods are not archives; current real publications are visible',()=>{
 const cycles=[{id:'draft',month:'2020-01',status:'DRAFT'},{id:'cancel',month:'2020-02',status:'CANCELLED'},
 {id:'running',month:'2020-03',status:'REVIEWING'},{id:'now',month:'2099-01',status:'PUBLISHED'},
 {id:'partial',month:'2099-02',status:'PARTIALLY_PUBLISHED'},{id:'archived',month:'2021-01',status:'ARCHIVED'},
 {id:'empty',month:'2021-02',status:'PUBLISHED'}];
 expect(publishedHistory(cycles,cycles.filter(c=>c.id!=='empty').map(c=>({cycle_id:c.id})) ).map(c=>c.id)).toEqual(['partial','now','archived']);
});
it('award candidate contract preserves real identity/score and refuses malformed values instead of NaN',async()=>{
 const response={userId:'member',displayName:'测试成员',deptName:'测试部门',finalScore:89,cycleId:'cycle',month:'2026-10',publicationVersion:2};
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:[response]}))));
 expect((await realApi.listAwardCandidates('cycle'))[0]).toMatchObject({userId:'member',displayName:'测试成员',finalScore:89,month:'2026-10'});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:[{...response,finalScore:'invalid'}]}))));
 await expect(realApi.listAwardCandidates('cycle')).rejects.toThrow('AWARD_CANDIDATE_INVALID');
});
