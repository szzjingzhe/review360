import {describe,it,expect} from 'vitest';
import {navItemActive,itemAllowed,WORKSPACES} from '../src/lib/workspaces';
const entries=['/department','/department/progress','/department/growth'].map(to=>({to,label:to}));
describe('sidebar current entry',()=>{
 it.each(entries.map(e=>e.to))('highlights only the matching department entry on %s',path=>{expect(entries.filter(e=>navItemActive(e,path)).map(e=>e.to)).toEqual([path]);});
 it('keeps the most specific registered entry active on a nested detail route',()=>{expect(entries.filter(e=>navItemActive(e,'/department/progress/detail')).map(e=>e.to)).toEqual(['/department/progress']);});
 it('retains parent highlighting for unlisted detail pages',()=>{expect(navItemActive({to:'/cycles',label:'周期'},'/cycles/123')).toBe(true);});
 it('does not match prefixes without a path separator or activate the home on children',()=>{expect(navItemActive(entries[0],'/department-other')).toBe(false);expect(navItemActive({to:'/',label:'首页'},'/department')).toBe(false);});
 it('does not highlight member feedback for the management entry',()=>{expect(navItemActive({to:'/feedback',label:'反馈'},'/feedback/manage')).toBe(false);});
});

describe('评价分配导航权限',()=>{
 const item=WORKSPACES.find(w=>w.key==='oversight')!.items.find(i=>i.to==='/management/monthly')!;
 it('允许具备管理入口与分配权限的部长访问',()=>{expect(itemAllowed(item,{roles:['HEAD'],capabilities:['management.access','assignment.manage']})).toBe(true);});
 it('不将分配权限当作管理端入口授权',()=>{expect(itemAllowed(item,{roles:['HEAD'],capabilities:['assignment.manage']})).toBe(false);});
});
