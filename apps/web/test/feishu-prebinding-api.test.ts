import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {realApi} from '../src/api/real';
afterEach(()=>vi.unstubAllGlobals());
it('candidate query, explicit individual verification and batch submission retain the server contracts',async()=>{
 const calls:any[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string,init:any)=>{calls.push({url,init});return Response.json({data:{}});}));
 await realApi.previewPrebindings();await realApi.listPrebindingBatches();await realApi.getPrebindingBatch('batch');
 await realApi.verifyPrebinding('batch','item',true,'ou_test','已核对可信名单');await realApi.submitPrebindings('batch',['item'],true,'已核查应用范围');
 expect(calls.map(c=>[c.url,c.init.method??'GET'])).toEqual([['/api/v1/auth/feishu/prebindings/preview','POST'],['/api/v1/auth/feishu/prebindings','GET'],['/api/v1/auth/feishu/prebindings/batch','GET'],['/api/v1/auth/feishu/prebindings/batch/items/item/verification','PUT'],['/api/v1/auth/feishu/prebindings/batch/submit','POST']]);
 expect(JSON.parse(calls[3].init.body)).toEqual({confirmed:true,openId:'ou_test',evidence:'已核对可信名单'});
 expect(JSON.parse(calls[4].init.body)).toEqual({itemIds:['item'],visibilityConfirmed:true,visibilityEvidence:'已核查应用范围'});expect(calls.every(c=>c.init.credentials==='include')).toBe(true);
});
it('atomic failure preserves per-item diagnostics for display',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({code:'PREBINDING_VALIDATION_FAILED',detail:{committed:false,items:[{itemId:'item',status:'FAILED',code:'VERIFICATION_REQUIRED'}]}},{status:409})));
 await expect(realApi.submitPrebindings('batch',['item'],true,'已核查')).rejects.toMatchObject({code:'PREBINDING_VALIDATION_FAILED',detail:{committed:false,items:[{code:'VERIFICATION_REQUIRED'}]}});
});
it('the administrator screen exposes prebinding only behind org.manage and leaves new candidates unverified',()=>{
 const page=readFileSync(new URL('../src/views/UserManagementView.vue',import.meta.url),'utf8');
 expect(page).toContain('<FeishuPrebindingPanel v-if="auth.user?.capabilities.includes(\'org.manage\')"');
 const panel=readFileSync(new URL('../src/components/FeishuPrebindingPanel.vue',import.meta.url),'utf8');expect(panel).toContain('!!i.verified_by');expect(panel).toContain('i.verified_by&&i.verified_open_id');expect(panel).not.toContain('selectAll');
});
