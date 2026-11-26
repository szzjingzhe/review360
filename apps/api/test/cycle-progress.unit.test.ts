import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ReportController } from '../src/report/report.controller';
import { ManagementController } from '../src/management/management.controller';
const actor={orgId:'org',userId:'manager',sessionIdHash:'session',displayName:'管理员'};
const cycle='11111111-1111-4111-8111-111111111111';
describe('周期进度权限',()=>{
 it('材料须经授权且只返回当前可用版本',async()=>{
  const policy={assertParticipant:vi.fn().mockResolvedValue(undefined)};
  const materials={assertEligibleParticipant:vi.fn(),list:vi.fn().mockResolvedValue({materials:[{id:'m',versions:[{id:'current',isCurrent:true,ready:true},{id:'old',isCurrent:false,ready:true},{id:'invalid',isCurrent:true,ready:false}]}]})};
  const controller=new ReportController({} as never,materials as never,policy as never);
  const result=await controller.managedMaterials(actor,cycle,'member');
  expect(policy.assertParticipant.mock.calls.map(c=>c[1])).toEqual(['management.access','progress.read','report.view']);
  expect(materials.assertEligibleParticipant).toHaveBeenCalledWith(actor,cycle,'member');
  expect(result.data[0].versions.map(v=>v.id)).toEqual(['current']);
 });
 it('缺少权限时不读取材料',async()=>{
  const policy={assertParticipant:vi.fn().mockRejectedValue(new ForbiddenException())};
  const materials={list:vi.fn(),assertEligibleParticipant:vi.fn()};
  await expect(new ReportController({} as never,materials as never,policy as never).managedMaterials(actor,cycle,'member')).rejects.toBeInstanceOf(ForbiddenException);
  expect(materials.list).not.toHaveBeenCalled();
 });
 it('没有关系权限时不查询任务',async()=>{
  const policy={assertCollection:vi.fn(async (_actor,cap)=>{if(cap==='assignment.read')throw new ForbiddenException();}),scopedSql:vi.fn()};
  const db={query:vi.fn()};
  await expect(new ManagementController(db as never,policy as never,{} as never,{} as never).cycleProgressTasks(actor,cycle)).rejects.toBeInstanceOf(ForbiddenException);
  expect(db.query).not.toHaveBeenCalled();
 });
 it('任务详情要求关系权限并约束双方范围',async()=>{
  const policy={assertCollection:vi.fn(),scopedSql:vi.fn((_a,_c,_cy,dept)=>`SCOPE_${dept.replace('.','_')}`)};
  const db={query:vi.fn().mockResolvedValue({rows:[]})};
  await new ManagementController(db as never,policy as never,{} as never,{} as never).cycleProgressTasks(actor,cycle);
  expect(policy.assertCollection.mock.calls.map(c=>c[1])).toEqual(['progress.read','assignment.read']);
  expect(policy.scopedSql).toHaveBeenCalledTimes(6);
  expect(db.query.mock.calls[0][0]).toContain('SCOPE_rp_dept_snapshot');
  expect(db.query.mock.calls[0][0]).toContain('SCOPE_tp_dept_snapshot');
  expect(db.query.mock.calls[0][0].split('EXISTS(')[0]).not.toContain('score');
 });
});

