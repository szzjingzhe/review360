import {expect,it,vi} from 'vitest';
import {FeishuNotificationGateway} from '../../worker/src/feishu-notification.gateway';
const config={FEISHU_APP_ID:'test-app',FEISHU_APP_SECRET:'test-secret',FEISHU_TENANT_KEY:'test-tenant',FEISHU_ORG_ID:'test-org',APP_ORIGIN:'https://test.invalid'};
const message={id:'11111111-1111-4111-8111-111111111111',orgId:'test-org',recipientId:'test-member',channel:'FEISHU' as const,payload:{type:'SYSTEM_TEST'}};
const db=(rows:any[])=>({query:vi.fn(async()=>({rows,rowCount:rows.length}))}) as any;
it('real sender validates tenant recipient, sends stable UUID, records API acceptance only',async()=>{
 const request=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({code:0,tenant_access_token:'test-token',expire:7200})))
  .mockResolvedValueOnce(new Response(JSON.stringify({code:0,data:{message_id:'om_test'}})));
 const result=await new FeishuNotificationGateway(db([{external_id:'ou_test'}]),config,request).send(message);
 expect(result).toEqual({ok:true,accepted:true,messageId:'om_test'});
 const body=JSON.parse(request.mock.calls[1][1].body);expect(body.uuid).toBe(message.id);expect(body.receive_id).toBe('ou_test');expect(JSON.parse(body.content).text).toContain('不涉及评分');expect(body).not.toHaveProperty('app_secret');
});
it('missing binding and wrong organization never send',async()=>{
 const request=vi.fn();expect((await new FeishuNotificationGateway(db([]),config,request).send(message)).error).toBe('FEISHU_RECIPIENT_NOT_BOUND');
 expect((await new FeishuNotificationGateway(db([]),config,request).send({...message,orgId:'another-org'})).error).toBe('FEISHU_ORGANIZATION_MISMATCH');expect(request).not.toHaveBeenCalled();
});
it('permission errors and missing message acknowledgements are failures, not sent',async()=>{
 for(const response of [{code:99991672,msg:'sensitive-provider-detail'},{code:0,data:{}}]){
 const request=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({code:0,tenant_access_token:'test-token'})))
 .mockResolvedValueOnce(new Response(JSON.stringify(response)));
 const result=await new FeishuNotificationGateway(db([{external_id:'ou_test'}]),config,request).send(message);
 expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('sensitive-provider-detail');expect(result).not.toHaveProperty('messageId');
 }
});
