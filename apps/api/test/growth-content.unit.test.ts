import {describe,it,expect} from 'vitest';
import {personalContent,validateReport,type GrowthInput} from '../src/growth/growth-content';
const input:GrowthInput={cycle:'2026-10',dimensions:['任务交付','协作支持','学习成长','创新改善'],evidence:[{id:'E1',kind:'评价意见',text:'协作清晰，协作及时，善于复盘。'}],history:[]};
const claim={text:'材料提到协作清晰，建议持续复盘。',evidence_ids:['E1']};
const valid=()=>({overall_summary:'材料提到本月能够围绕实际任务推进工作，并在协作沟通中及时回应需求。反馈认为，主动沟通与持续复盘是可以延续的积极表现；现有文字对任务安排细节的描述仍然有限，暂不能据此判断所有能力。建议下月记录关键任务的推进过程，在阶段结束时回顾阻碍与应对方法，并与协作方核对改进是否有效。',strengths:[claim],improvements:[claim],growth_suggestions:[claim],action_plan:[claim],traits:[claim],keywords:[{word:'协作',count:999}],capability_features:input.dimensions.map(d=>({dimension:d,...claim})),trend_summary:'不应使用的虚假趋势',evidence_references:['E1']});
describe('qualitative growth boundary',()=>{
 it('recomputes mention counts and does not invent history',()=>{const r=validateReport(valid(),input);expect(r.keywords[0].count).toBe(2);expect(r.trend_summary).toContain('不足');});
 it('drops unknown hidden numeric fields',()=>{expect(JSON.stringify(validateReport({...valid(),final_score:99},input))).not.toContain('final_score');});
 it('rejects invented evidence',()=>{expect(()=>validateReport({...valid(),strengths:[{...claim,evidence_ids:['E99']}]},input)).toThrow();});
 it('rejects invented keyword',()=>{expect(()=>validateReport({...valid(),keywords:[{word:'卓越'}]},input)).toThrow();});
 it('rejects score prose including Chinese numerals',()=>{for(const s of ['得分很好','实际九十分','能力90','排名靠前'])expect(()=>validateReport({...valid(),action_plan:[{...claim,text:s}]},input)).toThrow();});
 it('rejects missing dimensions and short summary',()=>{expect(()=>validateReport({...valid(),capability_features:[]},input)).toThrow();expect(()=>validateReport({...valid(),overall_summary:'资料不足'},input)).toThrow();});
 it('legacy content is allowlisted',()=>{expect(personalContent({strengths:'沟通清晰',weaknesses:'材料不足',suggestions:'继续复盘',directions:'记录进展',final_score:99})).not.toHaveProperty('final_score');});
 it('unsafe legacy report is not exposed',()=>expect(personalContent({strengths:'99',weaknesses:'材料不足',suggestions:'复盘',directions:'记录'})).toBeNull());
});
