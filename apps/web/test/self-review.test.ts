import { ITEM_REASON_RULES,codePointLength,itemReasonError,requiresItemReason } from '../src/lib/itemReasons';
import { afterEach,describe,it,expect,vi } from 'vitest';
import { scoreError,scoreValue,selfTotal,hydrateSelfReview,selfDraft } from '../src/lib/selfReview';
import { realApi } from '../src/api/real';

afterEach(()=>vi.unstubAllGlobals());

describe('self-review input and projection',()=>{
  it('distinguishes a blank score from valid zero; accepts only integers in range',()=>{
    expect(scoreValue('')).toBeNull();expect(scoreValue('  ')).toBeNull();expect(scoreValue('0')).toBe(0);expect(scoreValue('100')).toBe(100);
    for(const value of ['-1','101','1.5','NaN','Infinity','abc']){expect(scoreError(value)).not.toBe('');expect(scoreValue(value)).toBeNull();}
  });
  it('normalizes weights and matches basis-point rounding only when every item is scored',()=>{
    const items=[{weight:30,scoreText:'88'},{weight:25,scoreText:'80'},{weight:25,scoreText:'85'},{weight:20,scoreText:'78'}];
    expect(selfTotal(items)).toBe(83.25);expect(selfTotal([{weight:1,scoreText:'0'},{weight:2,scoreText:'100'}])).toBe(66.67);
    expect(selfTotal([{weight:100,scoreText:'0'}])).toBe(0);expect(selfTotal([...items,{weight:0,scoreText:''}])).toBeNull();
    expect(selfTotal([])).toBeNull();expect(selfTotal([{weight:0,scoreText:'90'}])).toBeNull();
  });
  const detail=()=>({review:{id:'review',cycleId:'cycle',status:'DRAFT'},template:{items:[{id:'b',code:'support_needed',label:'动态支持指标',weight:20},{id:'a',code:'self_awareness',label:'动态认知指标',weight:80}]},draft:{dataJson:{items:[{itemId:'a',score:0,reason:'已填写事实'},{itemId:'b',score:null,reason:'未评分也保留依据'}],overallReason:'总结',comment:'反思',nextPlan:'计划',readConfirmed:true}},latestRevision:null});
  it('restores scores and reasons by ID, with stable-code hints independent of position',()=>{
    const form=hydrateSelfReview(detail());expect(form.items[0].reason).toBe('未评分也保留依据');expect(form.items[0].placeholder).toContain('暂无');expect(form.items[1].scoreText).toBe('0');
    expect(selfDraft(form).items[0]).toEqual({itemId:'b',score:null,reason:'未评分也保留依据'});expect(selfDraft(form).items[1].score).toBe(0);
    expect(selfDraft(form)).toMatchObject({overallReason:'总结',comment:'反思',nextPlan:'计划',readConfirmed:true});
  });
  it('prefers server descriptions and hints, and uses generic hints for unknown dynamic metrics',()=>{
    const data=detail();Object.assign(data.template.items[0],{description:'后台描述',placeholder:'后台提示'});data.template.items[1].code='new_metric';
    const form=hydrateSelfReview(data);expect(form.items[0].description).toBe('后台描述');expect(form.items[0].placeholder).toBe('后台提示');expect(form.items[1].placeholder).toContain('例如');
  });
  it('shows returned submitted text without inventing unavailable item-level details',()=>{
    const data:any=detail();data.review.status='SUBMITTED';data.latestRevision={scoreBp:8325,overallReason:'已提交总结',comment:'已提交反思',nextPlan:'已提交计划',readConfirmed:true};
    const form=hydrateSelfReview(data);expect(form.detailsUnavailable).toBe(true);expect(form.items.every(i=>i.scoreText===''&&i.reason==='')).toBe(true);expect(form.scoreBp).toBe(8325);expect(form.overallReason).toBe('已提交总结');expect(form.readConfirmed).toBe(true);
  });
  it('keeps raw stable codes and submitted text from the existing detail endpoint',async()=>{
    const raw=detail();const fetcher=vi.fn(async(url:string)=>new Response(JSON.stringify({data:url.endsWith('/assignments/me')?{self:{reviewId:'review'},cycle:{status:'REVIEWING'}}:raw}),{status:200}));vi.stubGlobal('fetch',fetcher);
    expect(await realApi.getSelfReviewPage('cycle')).toEqual(raw);expect(fetcher.mock.calls.map(c=>c[0])).toEqual(['/api/v1/cycles/cycle/assignments/me','/api/v1/reviews/review']);
  });
  it('sends null unscored values and their reasons without converting them to zero',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({data:{rowVersion:2}}),{status:200}));vi.stubGlobal('fetch',fetcher);
    const body=selfDraft(hydrateSelfReview(detail()));await realApi.saveSelfReviewDraft('review',body);
    const init=(fetcher.mock.calls as unknown as Array<[string,RequestInit]>)[0][1];const stored=JSON.parse(init.body as string);
    expect(init.method).toBe('PUT');expect(stored.items[0]).toEqual({itemId:'b',score:null,reason:'未评分也保留依据'});expect(stored.items[1].score).toBe(0);
  });
});

describe('shared item reason rules in the frontend',()=>{
 it('hydrates server rules with a compatible fallback and keeps short draft text unchanged',()=>{
  const data={review:{id:'r',cycleId:'c',status:'DRAFT'},template:{items:[{id:'m',code:'delivery',label:'交付',weight:100}]},draft:{dataJson:{items:[{itemId:'m',score:80,reason:'尚未写完'}]}}};
  const form=hydrateSelfReview(data);expect(form.reasonRules).toEqual(ITEM_REASON_RULES);
  expect(itemReasonError(scoreValue(form.items[0].scoreText),form.items[0].reason,form.reasonRules)).not.toBe('');
  form.items[0].scoreText='79';expect(requiresItemReason(scoreValue(form.items[0].scoreText))).toBe(false);
  expect(selfDraft(form).items[0].reason).toBe('尚未写完');
  expect(codePointLength(' 😀中文 ')).toBe(3);
 });
});
