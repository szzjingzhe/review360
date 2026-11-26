import {describe,it,expect} from 'vitest';
import {deadlineText,growthChart,percent} from '../src/lib/cockpit';
describe('management cockpit display contract',()=>{
 it('keeps missing denominators distinct from zero progress',()=>{expect(percent(null)).toBe('—');expect(percent(0)).toBe('0%');});
 it('handles pending, closed and archived cycles',()=>{const now=Date.parse('2026-11-04T00:00:00Z');const c={status:'PENDING_OPEN',open_at:'2026-11-05T00:00:00Z',close_at:'2026-11-10T00:00:00Z'};expect(deadlineText(c,now)).toContain('开始 1 天');expect(deadlineText({...c,status:'CALIBRATING'},now)).toBe('评价已截止');expect(deadlineText({...c,status:'ARCHIVED'},now)).toBe('周期已归档');});
 it('uses only supplied historical points and never interpolates missing dimensions',()=>{const option=growthChart([{cycle_id:'a',month:'2026-09',title:'九月',dimension:'任务交付',value:72,sample_count:3},{cycle_id:'b',month:'2026-11',title:'十一月',dimension:'协作支持',value:81,sample_count:4}]);expect((option.xAxis as any).data).toEqual(['2026-09','2026-11']);expect((option.series as any)[0].data).toEqual([72,null]);expect((option.series as any)[1].data).toEqual([null,81]);});
});
