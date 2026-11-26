import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {FeedbackService} from '../src/feedback/feedback.service';
import {encodeAppeal} from '@360/domain';
const actor={userId:'owner',orgId:'org',displayName:'成员',sessionIdHash:'test'};
const publication='11111111-1111-4111-8111-111111111111';
describe('feedback server boundary',()=>{
 it('rejects malformed inputs before database access',async()=>{
  const db={connect:vi.fn()},service=new FeedbackService(db as any);
  for(const reason of [null,42,{},'未分类理由',encodeAppeal('评价结果异议',['评价任务'],'事实'),encodeAppeal('评价流程问题',[],'事实'),encodeAppeal('其他问题',[],' '.repeat(10)),encodeAppeal('其他问题',[],'中'.repeat(501))])await expect(service.createRequest(actor,publication,reason)).rejects.toMatchObject({status:400});
  await expect(service.createRequest(actor,'invalid',encodeAppeal('其他问题',[],'事实'))).rejects.toMatchObject({status:400});expect(db.connect).not.toHaveBeenCalled();
 });
 for(const [name,row,status] of [['foreign organization',null,404],['another member',{target_id:'other',published_at:new Date()},403],['future publication',{target_id:'owner',published_at:new Date(Date.now()+86400000)},400]] as const)it(`rejects ${name} without creating rows`,async()=>{
  const query=vi.fn(async(sql:string)=>sql.includes('SELECT p.target_id')?{rows:row?[row]:[],rowCount:row?1:0}:{rows:[],rowCount:0}),release=vi.fn();
  const service=new FeedbackService({connect:async()=>({query,release})} as any);await expect(service.createRequest(actor,publication,encodeAppeal('其他问题',[],'事实'))).rejects.toMatchObject({status});expect(query.mock.calls.some(([sql])=>sql.includes('INSERT'))).toBe(false);expect(release).toHaveBeenCalled();
 });
});
