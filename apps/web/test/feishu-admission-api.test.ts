import {afterEach,it,expect,vi} from 'vitest';
import {realApi} from '../src/api/real';
import {defaultHome,visibleWorkspaces} from '../src/lib/workspaces';
afterEach(()=>vi.unstubAllGlobals());
it('binding list and revoke remain available without an application queue',async()=>{
 const calls:any[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string,init:any)=>{calls.push({url,init});return Response.json({data:[]});}));
 await realApi.listFeishuBindings();await realApi.revokeFeishuBinding('binding');expect(calls.map(c=>c.url)).toEqual(['/api/v1/auth/feishu/bindings','/api/v1/auth/feishu/bindings/binding/revoke']);expect(calls.every(c=>c.init.credentials==='include')).toBe(true);
 expect('getAdmissionStatus' in realApi).toBe(false);expect('reviewAdmission' in realApi).toBe(false);expect('listAdmissions' in realApi).toBe(false);
});
it('login and member management have no application polling or approval controls',async()=>{
 const {readFileSync}=await import('node:fs');const login=readFileSync(new URL('../src/views/LoginView.vue',import.meta.url),'utf8'),panel=readFileSync(new URL('../src/components/FeishuAdmissionPanel.vue',import.meta.url),'utf8');
 expect(login).toContain('账号尚未关联，请联系管理员');expect(login).not.toMatch(/refreshAdmission|等待管理员核实|刷新申请状态/);expect(panel).not.toMatch(/reviewAdmission|listAdmissions|确认批准绑定|申请状态/);expect(panel).toContain('revokeFeishuBinding');
});
it('OAuth identity lands according to server capabilities, including head and published-only guidance',()=>{
 expect(defaultHome({capabilities:[],roles:[]}).path).toBe('/personal');
 expect(defaultHome({capabilities:['progress.read'],roles:['HEAD']}).path).toBe('/personal');
 expect(defaultHome({capabilities:['org.manage'],roles:[]}).path).toBe('/personal');
 const guidance={capabilities:['result.read_published'],roles:[],isGuidance:true};expect(defaultHome(guidance).path).toBe('/published-results');
 expect(visibleWorkspaces(guidance).flatMap(w=>w.items).some(i=>i.to==='/tasks')).toBe(false);
});
it('result-only viewers see exactly the published-result entry even with unrelated grants',()=>{
 const ctx={isResultViewer:true,roles:[],capabilities:['result.read_published','org.manage','cycle.manage']};expect(defaultHome(ctx)).toEqual({port:'oversight',path:'/published-results'});expect(visibleWorkspaces(ctx).flatMap(w=>w.items).map(i=>i.to)).toEqual(['/published-results']);
});
