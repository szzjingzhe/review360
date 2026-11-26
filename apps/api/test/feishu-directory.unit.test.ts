import {afterEach,expect,it,vi} from 'vitest';
import {ConfigService} from '@nestjs/config';
import {FeishuService} from '../src/auth/feishu.service';
afterEach(()=>vi.unstubAllGlobals());
function fixture(incomplete=false){
 const db={query:vi.fn(()=>{throw new Error('Directory reader must not write or query member data');})};
 const service=new FeishuService(new ConfigService({FEISHU_ORG_ID:'org',FEISHU_TENANT_KEY:'tenant',FEISHU_APP_ID:'app'}),db as any);
 const calls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(input:string,init:any)=>{
  calls.push(input);const url=new URL(input);let data:any={items:[]};
  if(url.pathname.endsWith('/tenant_access_token/internal'))return Response.json({code:0,tenant_access_token:'private-token'});
  expect(init.method??'GET').toBe('GET');
  if(url.pathname.endsWith('/visibility'))return Response.json({code:99991672,msg:'No permission'});
  if(url.pathname.endsWith('/departments/0/children'))data={items:[{open_department_id:'od_test',name:'测试部'}]};
  if(url.pathname.endsWith('/find_by_department')&&url.searchParams.get('department_id')==='od_test'){
   data=url.searchParams.has('page_token')?{items:[{open_id:'ou_second',user_id:'u2',name:'停用测试',department_ids:['od_test'],status:{is_frozen:true}}]}:{items:[{open_id:'ou_first',user_id:'u1',name:'同名提示',department_ids:['od_test'],status:{is_activated:true},mobile:'private-mobile',email:'private-email'}],has_more:true,page_token:incomplete?'':'page2'};
  }
  return Response.json({code:0,data});
 }));return {service,db,calls};
}
it('reads paginated directory without sync, credentials or contact details in the projection; visibility remains unconfirmed',async()=>{
 const {service,db,calls}=fixture();const result=await service.readDirectory('org');
 expect(result.users).toEqual([{openId:'ou_first',userId:'u1',name:'同名提示',departmentNames:['测试部'],active:true},{openId:'ou_second',userId:'u2',name:'停用测试',departmentNames:['测试部'],active:false}]);
 expect(result.visibility).toEqual({state:'ADMIN_CONFIRMATION_REQUIRED',providerCode:99991672});
 expect(JSON.stringify(result)).not.toMatch(/private-token|private-mobile|private-email/);expect(db.query).not.toHaveBeenCalled();expect(calls.some(u=>u.includes('page_token=page2'))).toBe(true);
});
it('fails closed on incomplete pagination rather than returning a partial candidate source',async()=>{
 const {service}=fixture(true);await expect(service.readDirectory('org')).rejects.toMatchObject({response:{code:'FEISHU_DIRECTORY_INCOMPLETE'}});
});
it('rejects a different organization before requesting any provider token',async()=>{
 const {service,calls}=fixture();await expect(service.readDirectory('other')).rejects.toMatchObject({response:{code:'FEISHU_MAPPING_NOT_CONFIGURED'}});expect(calls).toEqual([]);
});
