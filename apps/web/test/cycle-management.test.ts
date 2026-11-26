import {describe,it,expect} from 'vitest';
import {filterCycles,validateCycleForm,cycleStatus,type ManagedCycle} from '../src/lib/cycle-management';
import {monthlyPath,MONTHLY_SECTIONS} from '../src/lib/monthly-navigation';
const row={id:'existing',title:'十一月月评',month:'2026-11',status:'REVIEWING'} as ManagedCycle;
const form={title:'新周期',month:'2026-12',open_at:'2026-12-01T09:00',close_at:'2026-12-20T18:00',publish_at:'2026-12-21T18:00',ruleset_id:'frozen'};
describe('cycle management contracts',()=>{
 it('has five distinct route addresses',()=>{expect(new Set(MONTHLY_SECTIONS.map(s=>monthlyPath(s.key))).size).toBe(5);expect(monthlyPath('cycles','id')).toBe('/management/monthly/cycles/id');});
 it('does not mix archived records into active list',()=>{const archive={...row,id:'old',status:'ARCHIVED'};expect(filterCycles([row,archive],'','','',false)).toEqual([row]);expect(filterCycles([row,archive],'2026-11','','2026',true)).toEqual([archive]);});
 it('filters business phases without mutating database state',()=>{const pending={...row,status:'CALIBRATING',management_stage:'待核验'};expect(cycleStatus(pending)).toBe('待核验');expect(filterCycles([row,pending],'十一月','待核验','2026',false)).toEqual([pending]);expect(pending.status).toBe('CALIBRATING');});
 it('rejects empty titles and duplicate months instead of overwriting drafts',()=>{expect(validateCycleForm({...form,title:'  '},[])).toContain('名称');expect(validateCycleForm({...form,month:'2026-11'},[row])).toContain('已存在');});
 it('checks dates, month validity and frozen rule selection',()=>{expect(validateCycleForm({...form,open_at:form.close_at},[])).toContain('开始时间');expect(validateCycleForm({...form,publish_at:form.open_at},[])).toContain('发布时间');expect(validateCycleForm({...form,month:'2026-13'},[])).toContain('月份');expect(validateCycleForm({...form,ruleset_id:''},[])).toContain('规则');});
 it('allows the same month for editing the exact current draft',()=>{expect(validateCycleForm({...form,month:'2026-11'},[row],row.id)).toBe('');});
});
